import { PSM } from 'tesseract.js';
import type { OcrBackendRuntimeSettings } from './OcrBackend';
import type { OcrDebugSnapshot } from './OcrDebugSnapshot';
import type { OcrRecognitionResult } from './OcrService';
import type { PaddleAccelerationStatus } from './PaddleWorkerProtocol';

export const BackgroundOcrService = {
    async init(_model?: string, _runtimeSettings?: OcrBackendRuntimeSettings): Promise<void> {
        // Chromium uses the offscreen document for OCR. The background service
        // worker should stay lightweight and never load the OCR engine directly.
    },

    async recognize(
        _dataUrl: string,
        _pageSegMode: PSM,
        _model?: string,
        _runtimeSettings?: OcrBackendRuntimeSettings,
    ): Promise<string | undefined> {
        throw new Error('Background OCR is unavailable in Chromium builds. Use the offscreen OCR path instead.');
    },

    async setDebugEnabled(_enabled: boolean): Promise<void> {
        // Chromium uses the offscreen document for OCR. The background service
        // worker should stay lightweight and never load the OCR engine directly.
    },

    async recognizeWithDebug(
        _dataUrl: string,
        _pageSegMode: PSM,
        _model?: string,
        _runtimeSettings?: OcrBackendRuntimeSettings,
        _debugEnabled?: boolean,
    ): Promise<OcrRecognitionResult> {
        throw new Error('Background OCR is unavailable in Chromium builds. Use the offscreen OCR path instead.');
    },

    async getAccelerationStatus(): Promise<PaddleAccelerationStatus | null> { return null; },
    async retryGpu(): Promise<void> {},

    async setRuntimeSettings(_runtimeSettings: OcrBackendRuntimeSettings): Promise<void> {
        // Chromium uses the offscreen document for OCR. The background service
        // worker should stay lightweight and never load the OCR engine directly.
    },

    async getLastDebugSnapshot(): Promise<OcrDebugSnapshot | null> {
        return null;
    },
};
