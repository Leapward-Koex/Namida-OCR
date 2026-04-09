declare module 'namida-ocr-backend' {
    import { OcrBackend } from '../background/ocr/OcrBackend';
    import type { OcrDebugSnapshot } from '../background/ocr/OcrDebugSnapshot';

    export class ConfiguredOcrBackend implements OcrBackend {
        init(model?: string): Promise<void>;
        recognize(dataUrl: string, pageSegMode: import('tesseract.js').PSM, model?: string): Promise<string | undefined>;
        setDebugEnabled?(enabled: boolean): Promise<void>;
        setGpuEnabled?(enabled: boolean): Promise<void>;
        getLastDebugSnapshot?(): Promise<OcrDebugSnapshot | null>;
        terminate(): Promise<void>;
    }
}
