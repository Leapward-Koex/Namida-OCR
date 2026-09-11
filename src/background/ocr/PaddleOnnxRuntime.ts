import { runtime } from 'webextension-polyfill';
import type {
    PaddleAccelerationStatus, PaddleExecutionProvider, PaddleModelInput, PaddleModelOutput,
    PaddleWorkerDiagnostics, PaddleWorkerError, PaddleWorkerModel, PaddleWorkerRequest, PaddleWorkerResponse,
} from './PaddleWorkerProtocol';

const GPU_INIT_TIMEOUT_MS = 20_000;
const GPU_RUN_TIMEOUT_MS = 15_000;
const CPU_TIMEOUT_MS = 120_000;
const DISABLE_WASM_FALLBACK = __NAMIDA_PADDLE_ONNX_DISABLE_WASM_FALLBACK__;
type Command = PaddleWorkerRequest extends infer R ? R extends { id: number } ? Omit<R, 'id'> : never : never;
type Reply = Exclude<PaddleWorkerResponse, { type: 'fatal' | 'error' }>;
type WorkerContext = {
    worker: Worker;
    provider: PaddleExecutionProvider;
    initialized: boolean;
    pending: Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
};

class RuntimeFailure extends Error {
    constructor(message: string, readonly kind: PaddleWorkerError['kind'], readonly provider: PaddleExecutionProvider) {
        super(message);
    }
}

/** Each worker owns an entire ORT module, device and session cache. Termination is
 * the cancellation boundary: a hung JSEP run must never share ORT state with retry.
 */
export class PaddleOnnxRuntime {
    private context: WorkerContext | null = null;
    private queue: Promise<void> = Promise.resolve();
    private nextId = 0;
    private forceWasmOnly = false;
    private readonly models = new Map<string, string>();
    private status: PaddleAccelerationStatus = {
        requestedGpu: true, state: 'idle', provider: null, generation: 0,
        sessionKeys: [], successfulInferences: 0, wasmFallbackDisabled: DISABLE_WASM_FALLBACK,
    };

    public getStatus(): PaddleAccelerationStatus {
        return { ...this.status, adapter: this.status.adapter ? { ...this.status.adapter } : undefined,
            sessionKeys: [...this.status.sessionKeys] };
    }

    public initialize(models: PaddleWorkerModel[]): Promise<void> {
        const snapshot = models.map(model => ({ ...model }));
        return this.enqueue(async () => {
            this.registerModels(snapshot);
            await this.withRecovery(context => this.prepare(context, snapshot));
        });
    }

    public run(key: string, modelPath: string, input: PaddleModelInput): Promise<PaddleModelOutput> {
        const snapshot = { data: new Float32Array(input.data), dims: [...input.dims] };
        return this.enqueue(async () => {
            const models = [{ key, path: modelPath }];
            this.registerModels(models);
            return this.withRecovery(async context => {
                await this.prepare(context, models);
                this.status.state = 'running';
                // Keep the input buffer here: a transfer would detach it before a CPU retry.
                const reply = await this.rpc(context, { type: 'run', key, modelPath, input: snapshot });
                if (reply.type !== 'result') throw new RuntimeFailure('Unexpected ONNX worker response.', 'provider', context.provider);
                this.status.state = 'ready';
                this.status.lastError = undefined;
                return reply.output;
            });
        });
    }

    public setGpuEnabled(enabled: boolean): Promise<void> {
        return this.enqueue(async () => {
            if (this.status.requestedGpu === enabled) return;
            this.reset();
            this.status.requestedGpu = enabled;
        });
    }

    public retryGpu(): Promise<void> {
        return this.enqueue(async () => {
            if (!this.status.requestedGpu) throw new Error('Enable GPU acceleration before retrying it.');
            this.reset();
            await this.withRecovery(context => this.prepare(context,
                [...this.models].map(([key, path]) => ({ key, path }))));
        });
    }

    public terminate(): Promise<void> {
        return this.enqueue(async () => { this.reset(); this.models.clear(); });
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const job = this.queue.then(operation);
        this.queue = job.then(() => undefined, () => undefined);
        return job;
    }

    private registerModels(models: PaddleWorkerModel[]): void {
        for (const { key, path } of models) {
            if (this.models.has(key) && this.models.get(key) !== path) {
                throw new Error('ONNX session ' + key + ' already has a different model path.');
            }
        }
        for (const { key, path } of models) this.models.set(key, path);
    }

    private async withRecovery<T>(operation: (context: WorkerContext) => Promise<T>): Promise<T> {
        for (let attempt = 0; ; attempt += 1) {
            try {
                return await operation(this.context ?? this.createWorker());
            } catch (error) {
                this.status.lastError = error instanceof Error ? error.message : String(error);
                const brokenProvider = error instanceof RuntimeFailure
                    && (error.kind === 'provider' || error.kind === 'device-lost');
                if (brokenProvider) this.retire(error);
                if (brokenProvider && error.provider === 'webgpu' && !DISABLE_WASM_FALLBACK && attempt === 0) {
                    this.forceWasmOnly = true;
                    this.status.fallbackReason = error.message;
                    console.warn('[PaddleOnnxRuntime]', 'Restarting OCR in a fresh CPU worker', { reason: error.message });
                    continue;
                }
                this.status.state = 'failed';
                throw error;
            }
        }
    }

    private createWorker(): WorkerContext {
        const provider = this.status.requestedGpu && !this.forceWasmOnly ? 'webgpu' : 'wasm';
        if (provider === 'wasm' && DISABLE_WASM_FALLBACK) {
            throw new Error('Paddle ONNX CPU fallback is disabled for this build. Enable GPU acceleration to run OCR.');
        }
        this.status = { ...this.status, state: 'initializing', provider: null, adapter: undefined,
            generation: this.status.generation + 1, sessionKeys: [], successfulInferences: 0 };
        let worker: Worker;
        try {
            worker = new Worker(runtime.getURL('paddle-worker/index.js'));
        } catch (error) {
            throw new RuntimeFailure('Could not start local ONNX worker: ' + String(error), 'provider', provider);
        }
        const context: WorkerContext = { worker, provider, initialized: false, pending: new Map() };
        this.context = context;
        worker.onmessage = (event: MessageEvent<PaddleWorkerResponse>) => {
            if (this.context !== context) return;
            const reply = event.data;
            if (reply.diagnostics) this.updateDiagnostics(reply.diagnostics);
            if (reply.type === 'fatal') {
                this.failWorker(context, new RuntimeFailure(reply.error.message, reply.error.kind, provider));
                return;
            }
            const pending = context.pending.get(reply.id);
            if (!pending) return;
            clearTimeout(pending.timer);
            context.pending.delete(reply.id);
            if (reply.type === 'error') pending.reject(new RuntimeFailure(reply.error.message, reply.error.kind, provider));
            else pending.resolve(reply);
        };
        worker.onerror = event => {
            event.preventDefault();
            this.failWorker(context, new RuntimeFailure('ONNX worker failed: ' + event.message, 'provider', provider));
        };
        worker.onmessageerror = () => this.failWorker(context,
            new RuntimeFailure('Could not read ONNX worker response.', 'provider', provider));
        return context;
    }

    private async prepare(context: WorkerContext, models: PaddleWorkerModel[]): Promise<void> {
        const missing = models.filter(model => !this.status.sessionKeys.includes(model.key));
        if (context.initialized && missing.length === 0) return;
        this.status.state = 'initializing';
        const reply = await this.rpc(context, {
            type: 'init', provider: context.provider, models: missing,
            runtimeBaseUrl: runtime.getURL('libs/onnxruntime/'), modelBaseUrl: runtime.getURL('libs/paddleocr/'),
        });
        if (reply.type !== 'initialized') throw new RuntimeFailure('Unexpected ONNX initialization response.', 'provider', context.provider);
        context.initialized = true;
        this.status.state = 'ready';
        this.status.lastError = undefined;
    }

    private rpc(context: WorkerContext, command: Command): Promise<Reply> {
        if (this.context !== context) return Promise.reject(new RuntimeFailure('ONNX worker was retired.', 'provider', context.provider));
        const id = ++this.nextId;
        const timeout = context.provider === 'wasm' ? CPU_TIMEOUT_MS
            : command.type === 'init' ? GPU_INIT_TIMEOUT_MS * Math.max(1, command.models?.length ?? 0) : GPU_RUN_TIMEOUT_MS;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.failWorker(context, new RuntimeFailure(
                'Timed out ' + (command.type === 'init' ? 'initializing' : 'running') + ' ONNX ' + context.provider + ' worker after ' + timeout + ' ms.',
                'provider', context.provider)), timeout);
            context.pending.set(id, { resolve, reject, timer });
            try { context.worker.postMessage({ ...command, id }); }
            catch (error) {
                clearTimeout(timer);
                context.pending.delete(id);
                reject(new RuntimeFailure('Invalid ONNX worker request: ' + String(error), 'input', context.provider));
            }
        });
    }

    private updateDiagnostics(diagnostics: PaddleWorkerDiagnostics): void {
        this.status.provider = diagnostics.provider;
        this.status.adapter = diagnostics.adapter ? { ...diagnostics.adapter } : undefined;
        this.status.sessionKeys = [...diagnostics.sessionKeys];
        this.status.successfulInferences = diagnostics.successfulInferences;
    }

    private failWorker(context: WorkerContext, error: RuntimeFailure): void {
        if (this.context !== context) return;
        this.status.lastError = error.message;
        this.status.state = 'failed';
        if (context.provider === 'webgpu' && !DISABLE_WASM_FALLBACK) {
            this.forceWasmOnly = true;
            this.status.fallbackReason = error.message;
        }
        this.retire(error);
    }

    private retire(error = new Error('ONNX worker retired.')): void {
        const context = this.context;
        this.context = null;
        if (context) {
            context.worker.terminate();
            for (const pending of context.pending.values()) {
                clearTimeout(pending.timer);
                pending.reject(error);
            }
            context.pending.clear();
        }
        this.status.provider = null;
        this.status.adapter = undefined;
        this.status.sessionKeys = [];
        this.status.successfulInferences = 0;
    }

    private reset(): void {
        this.retire();
        this.forceWasmOnly = false;
        this.status.state = 'idle';
        this.status.fallbackReason = undefined;
        this.status.lastError = undefined;
    }
}
