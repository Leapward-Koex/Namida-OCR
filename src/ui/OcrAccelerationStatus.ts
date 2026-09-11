import type { PaddleAccelerationStatus } from '../background/ocr/PaddleWorkerProtocol';

export function describePaddleAcceleration(status: PaddleAccelerationStatus | null, gpuEnabled: boolean) {
    if (!status) {
        return { text: gpuEnabled ? 'GPU will be checked on the next scan.' : 'GPU is disabled. The next scan will use CPU (WASM).', retryAvailable: false, detail: '' };
    }
    const preferenceChanged = status.requestedGpu !== gpuEnabled;
    const retryAvailable = !preferenceChanged && gpuEnabled && !!status.fallbackReason;
    let text: string;
    if (status.state === 'failed') {
        text = 'OCR could not start or finish.';
    } else if (status.state === 'idle') {
        text = status.requestedGpu ? 'GPU will be checked on the next scan.' : 'CPU (WASM) will be used on the next scan.';
    } else if (status.state === 'initializing') {
        text = status.requestedGpu ? 'Checking GPU and loading OCR…' : 'Loading OCR for CPU (WASM)…';
    } else if (status.provider === 'webgpu') {
        text = status.successfulInferences > 0
            ? 'GPU (WebGPU) is working.'
            : 'WebGPU is initialized; a scan will verify it.';
    } else if (status.provider === 'wasm') {
        text = status.requestedGpu ? 'GPU unavailable. Using CPU (WASM).' : 'Using CPU (WASM).';
    } else {
        text = 'OCR provider has not been confirmed yet.';
    }
    if (preferenceChanged) text += ' Your changed GPU preference applies on the next scan.';
    return { text, retryAvailable, detail: status.fallbackReason ?? status.lastError ?? '' };
}
