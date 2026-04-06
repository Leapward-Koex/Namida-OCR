declare module 'namida-background-ocr-service' {
    import type { OcrDebugSnapshot } from '../background/ocr/OcrDebugSnapshot';

    export const BackgroundOcrService: {
        init(model?: string): Promise<void>;
        recognize(dataUrl: string, pageSegMode: import('tesseract.js').PSM, model?: string): Promise<string | undefined>;
        setDebugEnabled(enabled: boolean): Promise<void>;
        getLastDebugSnapshot(): Promise<OcrDebugSnapshot | null>;
    };
}
