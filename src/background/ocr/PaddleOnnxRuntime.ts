import { runtime } from 'webextension-polyfill';
import * as ort from 'onnxruntime-web';

const LOG_TAG = '[PaddleOnnxOcrBackend]';
const SESSION_INIT_TIMEOUT_MS = 20_000;
const INFERENCE_TIMEOUT_MS = 15_000;
const DISABLE_WASM_FALLBACK = __NAMIDA_PADDLE_ONNX_DISABLE_WASM_FALLBACK__;

type SessionBundle = {
    promise: Promise<ort.InferenceSession>;
    session: ort.InferenceSession | null;
    accelerated: boolean;
    retired: boolean;
    inFlight: Set<Promise<unknown>>;
    releasePromise: Promise<void> | null;
};

type NavigatorWithAcceleration = Navigator & { gpu?: unknown; ml?: unknown };

/** Owns local ONNX sessions; retiring a session never releases an active inference. */
export class PaddleOnnxRuntime {
    private static configured = false;
    private readonly sessions = new Map<string, SessionBundle>();
    private readonly modelPaths = new Map<string, string>();
    private forceWasmOnly = false;
    private gpuEnabled = true;

    public async ensureSession(key: string, localModelPath: string): Promise<ort.InferenceSession> {
        this.configure();
        const existing = this.sessions.get(key);
        if (existing) {
            if (this.modelPaths.get(key) !== localModelPath) {
                throw new Error(`ONNX session ${key} already has a different model path.`);
            }
            return existing.promise;
        }

        this.modelPaths.set(key, localModelPath);
        const bundle: SessionBundle = {
            promise: undefined as unknown as Promise<ort.InferenceSession>,
            session: null,
            accelerated: false,
            retired: false,
            inFlight: new Set(),
            releasePromise: null,
        };
        bundle.promise = this.createSession(localModelPath).then(async (created) => {
            bundle.session = created.session;
            bundle.accelerated = created.accelerated;
            if (bundle.retired) {
                await this.releaseIfIdle(bundle);
                throw new Error(`ONNX session ${key} was retired during initialization.`);
            }
            console.info(LOG_TAG, 'Initialized ONNX session', {
                accelerated: created.accelerated,
                providers: created.providers,
                sessionKey: key,
                wasmFallbackDisabled: DISABLE_WASM_FALLBACK,
                wasmOnly: this.forceWasmOnly,
            });
            return created.session;
        }).catch((error) => {
            // An older initialization must not evict a replacement created after a reset.
            if (this.sessions.get(key) === bundle) {
                this.sessions.delete(key);
            }
            throw error;
        });
        this.sessions.set(key, bundle);
        return bundle.promise;
    }

    public async run<T>(
        key: string,
        session: ort.InferenceSession,
        runInference: (activeSession: ort.InferenceSession) => Promise<T>,
    ): Promise<T> {
        let bundle = await this.resolveBundle(key, session);
        let retriedWithWasm = false;
        while (true) {
            // The settings may have changed while resolveBundle was awaiting initialization.
            if (bundle.retired || !bundle.session) {
                throw new Error(`ONNX session ${key} was retired before inference.`);
            }
            const activeSession = bundle.session;
            const activeBundle = bundle;
            const inference = Promise.resolve().then(() => runInference(activeSession));
            activeBundle.inFlight.add(inference);
            const settled = () => {
                activeBundle.inFlight.delete(inference);
                void this.releaseIfIdle(activeBundle);
            };
            // Track the actual operation, not the timeout wrapper: timeout does not cancel ORT.
            void inference.then(settled, settled);
            try {
                return await withTimeout(
                    inference,
                    activeBundle.accelerated ? INFERENCE_TIMEOUT_MS : 0,
                    () => new Error(`Timed out running ONNX inference with accelerated provider for ${key}`),
                );
            } catch (error) {
                if (DISABLE_WASM_FALLBACK || retriedWithWasm || !activeBundle.accelerated || !shouldFallbackToWasm(error)) {
                    throw error;
                }
                console.warn(LOG_TAG, 'Disabling accelerated execution provider after runtime failure', {
                    error,
                    sessionKey: key,
                });
                if (!this.forceWasmOnly) {
                    this.forceWasmOnly = true;
                    await this.retireSessions();
                }
                bundle = await this.resolveBundle(key, activeSession);
                retriedWithWasm = true;
            }
        }
    }

    public async setGpuEnabled(enabled: boolean): Promise<void> {
        if (this.gpuEnabled === enabled) {
            return;
        }
        this.gpuEnabled = enabled;
        this.forceWasmOnly = false;
        await this.retireSessions();
    }

    public async terminate(): Promise<void> {
        this.modelPaths.clear();
        await this.retireSessions();
    }

    private async resolveBundle(key: string, session: ort.InferenceSession): Promise<SessionBundle> {
        const existing = this.sessions.get(key);
        if (existing?.session === session && !existing.retired) {
            return existing;
        }
        const modelPath = this.modelPaths.get(key);
        if (!modelPath) {
            throw new Error(`ONNX session ${key} has no active model.`);
        }
        const activeSession = await this.ensureSession(key, modelPath);
        const bundle = this.sessions.get(key);
        if (!bundle || bundle.session !== activeSession || bundle.retired) {
            throw new Error(`ONNX session ${key} was retired before inference.`);
        }
        return bundle;
    }

    private async retireSessions(): Promise<void> {
        const retired = [...this.sessions.values()];
        this.sessions.clear();
        for (const bundle of retired) {
            bundle.retired = true;
        }
        // Pending initialization/inference releases itself when it settles. Do not block
        // WASM recovery forever on a hung accelerated operation.
        await Promise.all(retired.map((bundle) => this.releaseIfIdle(bundle)));
    }

    private async releaseIfIdle(bundle: SessionBundle): Promise<void> {
        if (!bundle.retired || !bundle.session || bundle.inFlight.size > 0) {
            return;
        }
        bundle.releasePromise ??= releaseSession(bundle.session);
        await bundle.releasePromise;
    }

    private async createSession(localModelPath: string) {
        const sessionUrl = runtime.getURL(`libs/paddleocr/${localModelPath}`);
        const candidates = getSessionOptions(this.forceWasmOnly, this.gpuEnabled);
        if (candidates.length === 0) {
            throw new Error('No accelerated ONNX execution provider is available and Paddle ONNX WASM fallback is disabled for this build.');
        }
        let lastError: unknown;
        for (const options of candidates) {
            const providers = (options.executionProviders ?? []).map((provider) => typeof provider === 'string' ? provider : provider.name);
            const accelerated = providers.some((provider) => provider !== 'wasm');
            try {
                const session = await withTimeout(
                    ort.InferenceSession.create(sessionUrl, options),
                    accelerated ? SESSION_INIT_TIMEOUT_MS : 0,
                    () => new Error(`Timed out creating ONNX session with providers: ${providers.join(', ')}`),
                    (abandonedSession) => { void releaseSession(abandonedSession); },
                );
                return { session, providers, accelerated };
            } catch (error) {
                lastError = error;
                console.warn(LOG_TAG, 'Failed to create ONNX session', { error, providers, sessionUrl });
            }
        }
        throw lastError ?? new Error(`Failed to create ONNX session for ${sessionUrl}`);
    }

    private configure(): void {
        if (PaddleOnnxRuntime.configured) {
            return;
        }
        if (DISABLE_WASM_FALLBACK) {
            console.info(LOG_TAG, 'Paddle ONNX WASM fallback is disabled for this build; accelerated provider failures will be fatal.');
        }
        ort.env.wasm.proxy = false;
        ort.env.wasm.wasmPaths = {
            mjs: runtime.getURL('libs/onnxruntime/ort-wasm-simd-threaded.jsep.mjs'),
            wasm: runtime.getURL('libs/onnxruntime/ort-wasm-simd-threaded.jsep.wasm'),
        };
        PaddleOnnxRuntime.configured = true;
    }
}

async function releaseSession(session: ort.InferenceSession): Promise<void> {
    try {
        await session.release();
    } catch (error) {
        console.warn(LOG_TAG, 'Failed to release ONNX session', { error });
    }
}

function getSessionOptions(forceWasmOnly: boolean, gpuEnabled: boolean): ort.InferenceSession.SessionOptions[] {
    const options = (executionProviders: ort.InferenceSession.ExecutionProviderConfig[]): ort.InferenceSession.SessionOptions => ({
        executionProviders,
        graphOptimizationLevel: 'all',
    });
    if (!gpuEnabled || (forceWasmOnly && !DISABLE_WASM_FALLBACK)) {
        return DISABLE_WASM_FALLBACK ? [] : [options([{ name: 'wasm' }])];
    }
    const browserNavigator = typeof navigator === 'undefined' ? null : navigator as NavigatorWithAcceleration;
    const candidates: ort.InferenceSession.SessionOptions[] = [];
    if (browserNavigator?.gpu) {
        candidates.push(options([{ name: 'webgpu' }]));
    }
    if (browserNavigator?.ml) {
        candidates.push(options([{ name: 'webnn', deviceType: 'gpu', powerPreference: 'high-performance' }]));
    }
    if (!DISABLE_WASM_FALLBACK) {
        candidates.push(options([{ name: 'wasm' }]));
    }
    return candidates;
}

function shouldFallbackToWasm(error: unknown): boolean {
    const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    return text.includes('Timed out running ONNX inference with accelerated provider')
        || text.includes('using ceil() in shape computation is not yet supported for MaxPool')
        || (text.includes('MaxPool') && text.includes('not yet supported'));
}

function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    createError: () => Error,
    onLateValue?: (value: T) => void,
): Promise<T> {
    if (timeoutMs <= 0) {
        return promise;
    }
    return new Promise<T>((resolve, reject) => {
        let timedOut = false;
        const timer = globalThis.setTimeout(() => {
            timedOut = true;
            reject(createError());
        }, timeoutMs);
        promise.then((value) => {
            globalThis.clearTimeout(timer);
            if (timedOut) {
                onLateValue?.(value);
            } else {
                resolve(value);
            }
        }, (error) => {
            globalThis.clearTimeout(timer);
            reject(error);
        });
    });
}
