/** Only structured-cloneable values cross the isolated ONNX worker boundary. */
export type PaddleExecutionProvider = 'webgpu' | 'wasm';

export interface PaddleAdapterInfo {
    vendor?: string;
    architecture?: string;
    device?: string;
    description?: string;
    isFallbackAdapter?: boolean;
}

export interface PaddleModelInput {
    data: Float32Array;
    dims: number[];
}

export interface PaddleModelOutput extends PaddleModelInput {
    type: 'float32';
}

export interface PaddleWorkerModel {
    key: string;
    path: string;
}

/** Provider names describe session configuration, not every operator's execution location. */
export interface PaddleWorkerDiagnostics {
    provider: PaddleExecutionProvider;
    adapter?: PaddleAdapterInfo;
    sessionKeys: string[];
    successfulInferences: number;
}

export interface PaddleAccelerationStatus {
    requestedGpu: boolean;
    state: 'idle' | 'initializing' | 'ready' | 'running' | 'failed';
    provider: PaddleExecutionProvider | null;
    adapter?: PaddleAdapterInfo;
    fallbackReason?: string;
    lastError?: string;
    generation: number;
    sessionKeys: string[];
    successfulInferences: number;
    wasmFallbackDisabled: boolean;
}

export type PaddleWorkerRequest = {
    id: number;
    type: 'init';
    provider: PaddleExecutionProvider;
    runtimeBaseUrl: string;
    modelBaseUrl: string;
    models?: PaddleWorkerModel[];
} | {
    id: number;
    type: 'run';
    key: string;
    modelPath: string;
    input: PaddleModelInput;
};

export interface PaddleWorkerError {
    kind: 'input' | 'model' | 'provider' | 'device-lost';
    message: string;
}

export type PaddleWorkerResponse = {
    id: number;
    type: 'initialized';
    diagnostics: PaddleWorkerDiagnostics;
} | {
    id: number;
    type: 'result';
    output: PaddleModelOutput;
    diagnostics: PaddleWorkerDiagnostics;
} | {
    id: number;
    type: 'error';
    error: PaddleWorkerError;
    diagnostics?: PaddleWorkerDiagnostics;
} | {
    type: 'fatal';
    error: PaddleWorkerError;
    diagnostics?: PaddleWorkerDiagnostics;
};
