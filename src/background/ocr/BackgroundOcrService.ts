import { PSM } from 'tesseract.js';
import type { OcrDebugSnapshot } from './OcrDebugSnapshot';
import { OcrService } from './OcrService';

export const BackgroundOcrService = {
    async init(model?: string): Promise<void> {
        await OcrService.init(model);
    },

    async recognize(dataUrl: string, pageSegMode: PSM, model?: string): Promise<string | undefined> {
        return OcrService.recognize(dataUrl, pageSegMode, model);
    },

    async setDebugEnabled(enabled: boolean): Promise<void> {
        await OcrService.setDebugEnabled(enabled);
    },

    async getLastDebugSnapshot(): Promise<OcrDebugSnapshot | null> {
        return OcrService.getLastDebugSnapshot();
    },
};
