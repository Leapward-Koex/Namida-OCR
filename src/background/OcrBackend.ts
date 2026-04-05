import { PSM } from 'tesseract.js';

export interface OcrBackend {
    init(): Promise<void>;
    recognize(dataUrl: string, pageSegMode: PSM): Promise<string | undefined>;
    terminate(): Promise<void>;
}
