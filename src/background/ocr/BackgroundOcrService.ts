import { PSM } from 'tesseract.js';
import type { OcrBackendRuntimeSettings } from './OcrBackend';
import type { OcrDebugSnapshot } from './OcrDebugSnapshot';
import { OcrService } from './OcrService';

export const BackgroundOcrService = {
    async init(model?: string, runtimeSettings?: OcrBackendRuntimeSettings): Promise<void> {
        await OcrService.init(model, runtimeSettings);
    },

    async recognize(
        dataUrl: string,
        pageSegMode: PSM,
        model?: string,
        runtimeSettings?: OcrBackendRuntimeSettings,
    ): Promise<string | undefined> {
        return OcrService.recognize(dataUrl, pageSegMode, model, runtimeSettings);
    },

    async setDebugEnabled(enabled: boolean): Promise<void> {
        await OcrService.setDebugEnabled(enabled);
    },

    async setRuntimeSettings(runtimeSettings: OcrBackendRuntimeSettings): Promise<void> {
        await OcrService.setRuntimeSettings(runtimeSettings);
    },

    async getLastDebugSnapshot(): Promise<OcrDebugSnapshot | null> {
        return OcrService.getLastDebugSnapshot();
    },
};
