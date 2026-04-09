declare module 'namida-background-ocr-service' {
    import type { OcrBackendRuntimeSettings } from '../background/ocr/OcrBackend';
    import type { OcrDebugSnapshot } from '../background/ocr/OcrDebugSnapshot';

    export const BackgroundOcrService: {
        init(model?: string, runtimeSettings?: OcrBackendRuntimeSettings): Promise<void>;
        recognize(
            dataUrl: string,
            pageSegMode: import('tesseract.js').PSM,
            model?: string,
            runtimeSettings?: OcrBackendRuntimeSettings,
        ): Promise<string | undefined>;
        setDebugEnabled(enabled: boolean): Promise<void>;
        setRuntimeSettings(runtimeSettings: OcrBackendRuntimeSettings): Promise<void>;
        getLastDebugSnapshot(): Promise<OcrDebugSnapshot | null>;
    };
}
