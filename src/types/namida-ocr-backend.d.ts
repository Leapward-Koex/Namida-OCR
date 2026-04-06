declare module 'namida-ocr-backend' {
    import { OcrBackend } from '../background/ocr/OcrBackend';

    export class ConfiguredOcrBackend implements OcrBackend {
        init(model?: string): Promise<void>;
        recognize(dataUrl: string, pageSegMode: import('tesseract.js').PSM, model?: string): Promise<string | undefined>;
        terminate(): Promise<void>;
    }
}
