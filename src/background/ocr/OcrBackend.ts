import { PSM } from 'tesseract.js';
import type { OcrDebugSnapshot } from './OcrDebugSnapshot';
import type { PaddleAccelerationStatus } from './PaddleWorkerProtocol';

export type OcrBackendRuntimeSettings = {
    backend: 'tesseract' | 'paddleonnx';
    paddleGpuEnabled: boolean;
};

export interface OcrBackend {
    init(model?: string): Promise<void>;
    recognize(dataUrl: string, pageSegMode: PSM, model?: string): Promise<string | undefined>;
    setDebugEnabled?(enabled: boolean): Promise<void> | void;
    setGpuEnabled?(enabled: boolean): Promise<void> | void;
    setRuntimeSettings?(settings: OcrBackendRuntimeSettings): Promise<void> | void;
    getLastDebugSnapshot?(): Promise<OcrDebugSnapshot | null> | OcrDebugSnapshot | null;
    getAccelerationStatus?(): Promise<PaddleAccelerationStatus | null> | PaddleAccelerationStatus | null;
    retryGpu?(): Promise<void>;
    terminate(): Promise<void>;
}
