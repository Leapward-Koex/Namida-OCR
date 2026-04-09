import { PSM } from 'tesseract.js';
import type { OcrDebugSnapshot } from './OcrDebugSnapshot';

export interface OcrBackend {
    init(model?: string): Promise<void>;
    recognize(dataUrl: string, pageSegMode: PSM, model?: string): Promise<string | undefined>;
    setDebugEnabled?(enabled: boolean): Promise<void> | void;
    setGpuEnabled?(enabled: boolean): Promise<void> | void;
    getLastDebugSnapshot?(): Promise<OcrDebugSnapshot | null> | OcrDebugSnapshot | null;
    terminate(): Promise<void>;
}
