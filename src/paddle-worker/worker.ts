import type * as Ort from 'onnxruntime-web';
import type {
    PaddleAdapterInfo, PaddleExecutionProvider, PaddleModelInput, PaddleModelOutput,
    PaddleWorkerDiagnostics, PaddleWorkerError, PaddleWorkerRequest, PaddleWorkerResponse,
} from '../background/ocr/PaddleWorkerProtocol';

interface WorkerAdapter {
    isFallbackAdapter?: boolean;
    info?: PaddleAdapterInfo;
    requestAdapterInfo?: () => Promise<PaddleAdapterInfo>;
}

export interface PaddleWorkerScope {
    location: { href: string };
    navigator?: { gpu?: { requestAdapter(options: { powerPreference: 'high-performance' }): Promise<WorkerAdapter | null> } };
    fetch(url: string): Promise<Response>;
    onmessage: ((event: { data: unknown }) => void) | null;
    postMessage(message: PaddleWorkerResponse, transfer?: Transferable[]): void;
}

class WorkerFailure extends Error {
    constructor(readonly kind: PaddleWorkerError['kind'], message: string) { super(message); }
}

/** One provider per worker; the supervisor terminates this entire realm to recover. */
export function installPaddleWorker(scope: PaddleWorkerScope, ort: typeof Ort): void {
    let configuration: { provider: PaddleExecutionProvider; runtimeBaseUrl: string; modelBaseUrl: string } | undefined;
    let adapterInfo: PaddleAdapterInfo | undefined;
    let initialized = false;
    let fatal: WorkerFailure | undefined;
    let observedDevice: unknown;
    let successfulInferences = 0;
    let queue = Promise.resolve();
    const sessions = new Map<string, { path: string; session: Ort.InferenceSession }>();

    const diagnostics = (): PaddleWorkerDiagnostics | undefined => configuration && ({
        provider: configuration.provider, adapter: adapterInfo,
        sessionKeys: [...sessions.keys()], successfulInferences,
    });

    function reportFatal(message: string): void {
        if (fatal) return;
        fatal = new WorkerFailure('device-lost', message);
        scope.postMessage({ type: 'fatal', error: { kind: fatal.kind, message }, diagnostics: diagnostics() });
    }

    async function observeDevice(): Promise<void> {
        if (configuration?.provider !== 'webgpu') return;
        // JSEP publishes its actual device after initialization. Let ORT choose
        // required features/limits rather than supplying an underspecified device.
        const device = await ort.env.webgpu.device as unknown as {
            lost?: Promise<{ reason?: string; message?: string }>;
        };
        if (!device?.lost) throw new WorkerFailure('provider', 'ONNX Runtime did not expose its WebGPU device.');
        if (device === observedDevice) return;
        observedDevice = device;
        void device.lost.then(info => {
            reportFatal(`WebGPU device lost${info.reason ? ` (${info.reason})` : ''}: ${info.message || 'no reason supplied'}`);
        }, error => reportFatal(`WebGPU device lost: ${errorMessage(error)}`));
    }

    function resolveModelPath(path: unknown): string {
        if (!configuration) throw new WorkerFailure('input', 'Initialize the ONNX worker before loading a model.');
        if (typeof path !== 'string' || !path || path.includes('\\')) {
            throw new WorkerFailure('input', 'Model path must identify a bundled extension asset.');
        }
        let url: URL;
        try { url = new URL(path, configuration.modelBaseUrl); }
        catch { throw new WorkerFailure('input', 'Invalid model path.'); }
        const base = new URL(configuration.modelBaseUrl);
        if (!sameExtension(url, base) || !url.pathname.startsWith(base.pathname)
            || /%(?:2f|5c|00)/i.test(url.pathname) || url.search || url.hash) {
            throw new WorkerFailure('input', 'Model path must remain inside the bundled PaddleOCR directory.');
        }
        return url.href;
    }

    async function ensureSession(key: unknown, path: unknown): Promise<Ort.InferenceSession> {
        assertKey(key);
        const url = resolveModelPath(path);
        const existing = sessions.get(key);
        if (existing) {
            if (existing.path !== url) throw new WorkerFailure('input', `ONNX session ${key} already has a different model path.`);
            return existing.session;
        }
        let model: ArrayBuffer;
        try {
            const response = await scope.fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            model = await response.arrayBuffer();
            if (!model.byteLength) throw new Error('empty model file');
        } catch (error) {
            throw new WorkerFailure('model', `Unable to load bundled ONNX model ${key}: ${errorMessage(error)}`);
        }
        let session: Ort.InferenceSession;
        try {
            session = await ort.InferenceSession.create(new Uint8Array(model), {
                executionProviders: [{ name: configuration!.provider }], graphOptimizationLevel: 'all',
            });
        } catch (error) {
            // A valid local fetch can still fail to initialize the WASM runtime
            // itself. Only recognizable graph/serialization failures are model errors.
            const kind = isModelError(error) ? 'model' : 'provider';
            throw new WorkerFailure(kind, `Unable to initialize ONNX model ${key}: ${errorMessage(error)}`);
        }
        try {
            if (session.inputNames.length !== 1 || session.outputNames.length < 1) {
                throw new WorkerFailure('model', `ONNX model ${key} must have exactly one input and at least one output.`);
            }
            await observeDevice();
            if (fatal) throw fatal;
            sessions.set(key, { path: url, session });
            return session;
        } catch (error) {
            try { await session.release(); } catch { /* The supervisor also destroys failed worker realms. */ }
            throw error;
        }
    }

    async function initialize(request: Extract<PaddleWorkerRequest, { type: 'init' }>): Promise<void> {
        if (request.provider !== 'webgpu' && request.provider !== 'wasm') {
            throw new WorkerFailure('input', 'Unsupported ONNX execution provider.');
        }
        const next = {
            provider: request.provider,
            runtimeBaseUrl: validateBaseUrl(request.runtimeBaseUrl, scope.location.href, '/libs/onnxruntime/'),
            modelBaseUrl: validateBaseUrl(request.modelBaseUrl, scope.location.href, '/libs/paddleocr/'),
        };
        if (configuration && (configuration.provider !== next.provider
            || configuration.runtimeBaseUrl !== next.runtimeBaseUrl || configuration.modelBaseUrl !== next.modelBaseUrl)) {
            throw new WorkerFailure('input', 'An ONNX worker cannot change provider or asset directories.');
        }
        if (request.models !== undefined && !Array.isArray(request.models)) {
            throw new WorkerFailure('input', 'Models must be an array of bundled model paths.');
        }
        configuration = next;
        if (!initialized) {
            ort.env.wasm.proxy = false;
            // Extension workers are not cross-origin isolated. Never spawn ORT's
            // own proxy/thread workers or depend on SharedArrayBuffer availability.
            ort.env.wasm.numThreads = 1;
            ort.env.wasm.wasmPaths = {
                mjs: new URL('ort-wasm-simd-threaded.jsep.mjs', next.runtimeBaseUrl).href,
                wasm: new URL('ort-wasm-simd-threaded.jsep.wasm', next.runtimeBaseUrl).href,
            };
            if (next.provider === 'webgpu') {
                const gpu = scope.navigator?.gpu;
                if (!gpu) throw new WorkerFailure('provider', 'WebGPU is unavailable in this browser worker.');
                let adapter: WorkerAdapter | null;
                try { adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' }); }
                catch (error) { throw new WorkerFailure('provider', `WebGPU adapter request failed: ${errorMessage(error)}`); }
                if (!adapter) throw new WorkerFailure('provider', 'The browser did not provide a WebGPU adapter.');
                let info = adapter.info;
                if (!info && adapter.requestAdapterInfo) {
                    try { info = await adapter.requestAdapterInfo(); } catch { /* Adapter details may be unavailable. */ }
                }
                adapterInfo = copyAdapterInfo(info, adapter.isFallbackAdapter);
                if (adapterInfo.isFallbackAdapter === true
                    || /swiftshader|llvmpipe|lavapipe|microsoft basic render/i.test(`${adapterInfo.description} ${adapterInfo.device}`)) {
                    throw new WorkerFailure('provider', 'The browser only provided a software WebGPU adapter.');
                }
                ort.env.webgpu.adapter = adapter as typeof ort.env.webgpu.adapter;
            }
            initialized = true;
        }
        for (const model of request.models ?? []) {
            if (!model || typeof model !== 'object') throw new WorkerFailure('input', 'Invalid bundled model entry.');
            await ensureSession(model.key, model.path);
        }
    }

    async function run(request: Extract<PaddleWorkerRequest, { type: 'run' }>): Promise<PaddleModelOutput> {
        if (!initialized) throw new WorkerFailure('input', 'Initialize the ONNX worker before running inference.');
        assertInput(request.input);
        const session = await ensureSession(request.key, request.modelPath);
        const metadata = session.inputMetadata[0];
        if (!metadata?.isTensor || metadata.type !== 'float32') {
            throw new WorkerFailure('model', 'PaddleOCR models must accept one float32 tensor.');
        }
        if (metadata.shape.length && (metadata.shape.length !== request.input.dims.length
            || metadata.shape.some((dimension, index) => typeof dimension === 'number' && dimension >= 0 && dimension !== request.input.dims[index]))) {
            throw new WorkerFailure('input', `ONNX input shape [${request.input.dims}] does not match model shape [${metadata.shape}].`);
        }
        let input: Ort.Tensor | undefined;
        let outputs: Ort.InferenceSession.ReturnType | undefined;
        try {
            try { input = new ort.Tensor('float32', request.input.data, request.input.dims); }
            catch (error) { throw new WorkerFailure('input', `Invalid ONNX input tensor: ${errorMessage(error)}`); }
            try { outputs = await session.run({ [session.inputNames[0]]: input }); }
            catch (error) {
                if (fatal) throw fatal;
                throw new WorkerFailure(isInputError(error) ? 'input' : isModelError(error) ? 'model' : 'provider',
                    `ONNX inference failed: ${errorMessage(error)}`);
            }
            if (fatal) throw fatal;
            const output = outputs[session.outputNames[0]];
            if (!output || output.type !== 'float32') throw new WorkerFailure('model', 'PaddleOCR model returned no float32 output.');
            let data: Ort.Tensor.DataType;
            try { data = output.data; }
            catch { throw new WorkerFailure('model', 'PaddleOCR output data is not accessible on the CPU.'); }
            if (!(data instanceof Float32Array)) throw new WorkerFailure('model', 'PaddleOCR output must contain float32 data.');
            // ORT owns the original buffer. Copy before disposing and transfer only
            // the independent copy; root validates detector/CTC output dimensions.
            const result: PaddleModelOutput = { type: 'float32', data: new Float32Array(data), dims: [...output.dims] };
            successfulInferences += 1;
            return result;
        } finally {
            for (const output of new Set(Object.values(outputs ?? {}))) {
                try { output.dispose(); } catch { /* Continue releasing every tensor. */ }
            }
            try { input?.dispose(); } catch { /* Worker termination is the final resource boundary. */ }
        }
    }

    scope.onmessage = event => {
        const request = event.data as PaddleWorkerRequest;
        // Serialize the whole command, including model initialization and copying.
        // A rejected request must not poison later independent requests.
        queue = queue.then(async () => {
            try {
                if (!request || !Number.isSafeInteger(request.id) || request.id < 0) {
                    throw new WorkerFailure('input', 'Worker requests require a nonnegative safe-integer id.');
                }
                if (fatal) throw fatal;
                if (request.type === 'init') {
                    await initialize(request);
                    scope.postMessage({ id: request.id, type: 'initialized', diagnostics: diagnostics()! });
                } else if (request.type === 'run') {
                    const output = await run(request);
                    scope.postMessage({ id: request.id, type: 'result', output, diagnostics: diagnostics()! }, [output.data.buffer]);
                } else throw new WorkerFailure('input', 'Unknown ONNX worker request.');
            } catch (error) {
                const failure: PaddleWorkerError = error instanceof WorkerFailure
                    ? { kind: error.kind, message: error.message }
                    : { kind: configuration?.provider === 'webgpu' ? 'provider' : 'model', message: errorMessage(error) };
                scope.postMessage({ id: request?.id ?? -1, type: 'error', error: failure, diagnostics: diagnostics() });
            }
        });
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sameExtension(url: URL, worker: URL): boolean {
    // URL.origin is "null" for extension schemes in some environments.
    return (url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:')
        && url.protocol === worker.protocol && url.host === worker.host && !url.username && !url.password;
}

function validateBaseUrl(value: unknown, workerHref: string, directory: string): string {
    if (typeof value !== 'string') throw new WorkerFailure('input', 'Missing bundled ONNX asset directory.');
    let url: URL;
    try { url = new URL(value); }
    catch { throw new WorkerFailure('input', 'Invalid bundled ONNX asset directory.'); }
    if (!sameExtension(url, new URL(workerHref)) || url.pathname !== directory || url.search || url.hash) {
        throw new WorkerFailure('input', `ONNX assets must use this extension's ${directory} directory.`);
    }
    return url.href;
}

function assertKey(key: unknown): asserts key is string {
    if (typeof key !== 'string' || !key || key.length > 128) throw new WorkerFailure('input', 'Invalid ONNX model key.');
}

function assertInput(input: PaddleModelInput | undefined): asserts input is PaddleModelInput {
    if (!input || !(input.data instanceof Float32Array) || !Array.isArray(input.dims)
        || input.dims.length !== 4 || input.dims[0] !== 1 || input.dims[1] !== 3
        || !input.dims.every(dimension => Number.isSafeInteger(dimension) && dimension > 0)) {
        throw new WorkerFailure('input', 'PaddleOCR input must be a float32 tensor with shape [1, 3, H, W].');
    }
    const expectedLength = input.dims.reduce((length, dimension) => length * dimension, 1);
    if (!Number.isSafeInteger(expectedLength) || expectedLength !== input.data.length) {
        throw new WorkerFailure('input', 'PaddleOCR input shape does not match its data length.');
    }
}

function copyAdapterInfo(info: PaddleAdapterInfo | undefined, legacyFallback: boolean | undefined): PaddleAdapterInfo {
    const result: PaddleAdapterInfo = {};
    for (const key of ['vendor', 'architecture', 'device', 'description'] as const) {
        if (typeof info?.[key] === 'string') result[key] = info[key];
    }
    const isFallbackAdapter = info?.isFallbackAdapter ?? legacyFallback;
    if (typeof isFallbackAdapter === 'boolean') result.isFallbackAdapter = isFallbackAdapter;
    return result;
}

function isModelError(error: unknown): boolean {
    return /invalid (?:protobuf|model)|protobuf parsing|failed to load model|unsupported (?:model ir|ir version|opset)|opset.*(?:under development|not supported)|no opset import|model format|invalid graph/i.test(errorMessage(error));
}

function isInputError(error: unknown): boolean {
    return /invalid (?:input|rank|dimensions)|unexpected input|input.*(?:shape|dimension|data type).*mismatch|input tensor.*(?:shape|type)|missing.*input/i.test(errorMessage(error));
}
