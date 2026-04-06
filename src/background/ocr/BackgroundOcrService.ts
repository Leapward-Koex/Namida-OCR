import { PSM } from 'tesseract.js';
import { OcrService } from './OcrService';

export const BackgroundOcrService = {
    async init(model?: string): Promise<void> {
        await OcrService.init(model);
    },

    async recognize(dataUrl: string, pageSegMode: PSM, model?: string): Promise<string | undefined> {
        return OcrService.recognize(dataUrl, pageSegMode, model);
    },
};
