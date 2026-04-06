import { PSM } from 'tesseract.js';

export const BackgroundOcrService = {
    async init(): Promise<void> {
        // Chromium uses the offscreen document for OCR. The background service
        // worker should stay lightweight and never load the OCR engine directly.
    },

    async recognize(_dataUrl: string, _pageSegMode: PSM, _model?: string): Promise<string | undefined> {
        throw new Error('Background OCR is unavailable in Chromium builds. Use the offscreen OCR path instead.');
    },
};
