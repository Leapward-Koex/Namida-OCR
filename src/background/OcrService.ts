import { PSM } from 'tesseract.js';
import { OcrBackend } from './OcrBackend';
import { TesseractOcrBackend } from './TesseractOcrBackend';

export class OcrService {
    private static backend: OcrBackend | null = null;

    private static getBackend(): OcrBackend {
        if (!this.backend) {
            this.backend = new TesseractOcrBackend();
        }

        return this.backend;
    }

    public static async init(): Promise<void> {
        await this.getBackend().init();
    }

    public static async recognize(dataUrl: string, pageSegMode: PSM): Promise<string | undefined> {
        return this.getBackend().recognize(dataUrl, pageSegMode);
    }

    public static async terminate(): Promise<void> {
        await this.getBackend().terminate();
    }
}
