declare module 'namida-background-ocr-service' {
    export const BackgroundOcrService: {
        init(model?: string): Promise<void>;
        recognize(dataUrl: string, pageSegMode: import('tesseract.js').PSM, model?: string): Promise<string | undefined>;
    };
}
