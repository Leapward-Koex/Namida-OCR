import { PSM } from 'tesseract.js';

export interface OcrBackend {
    init(model?: string): Promise<void>;
    recognize(dataUrl: string, pageSegMode: PSM, model?: string): Promise<string | undefined>;
    terminate(): Promise<void>;
}
