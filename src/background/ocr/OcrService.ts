import { PSM } from 'tesseract.js';
import type { OcrBackend, OcrBackendRuntimeSettings } from './OcrBackend';
import type { OcrDebugSnapshot } from './OcrDebugSnapshot';
import type { PaddleAccelerationStatus } from './PaddleWorkerProtocol';

type OcrBackendModule = { ConfiguredOcrBackend: new () => OcrBackend };
export type OcrRecognitionResult = {
    recognizedText: string | undefined;
    debugSnapshot: OcrDebugSnapshot | null;
};

export class OcrService {
    private static backend: OcrBackend | null = null;
    private static debugEnabled = false;
    private static lastDebugSnapshot: OcrDebugSnapshot | null = null;
    private static operationTail: Promise<unknown> = Promise.resolve();

    // A request owns settings, backend selection, inference and its snapshot until
    // it completes. Lifecycle changes join this queue; failures do not poison it.
    private static enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationTail.then(operation);
        this.operationTail = result.catch(() => undefined);
        return result;
    }

    private static async getBackend(): Promise<OcrBackend> {
        if (!this.backend) {
            const module = await import('namida-ocr-backend') as OcrBackendModule;
            const backend = new module.ConfiguredOcrBackend();
            await backend.setDebugEnabled?.(this.debugEnabled);
            this.backend = backend;
        }
        return this.backend;
    }

    public static init(model?: string, runtimeSettings?: OcrBackendRuntimeSettings): Promise<void> {
        const settings = runtimeSettings && { ...runtimeSettings };
        return this.enqueue(async () => {
            const backend = await this.getBackend();
            if (settings) await backend.setRuntimeSettings?.(settings);
            await backend.init(model);
        });
    }

    public static recognize(
        dataUrl: string,
        pageSegMode: PSM,
        model?: string,
        runtimeSettings?: OcrBackendRuntimeSettings,
    ): Promise<string | undefined> {
        return this.recognizeWithDebug(dataUrl, pageSegMode, model, runtimeSettings)
            .then((result) => result.recognizedText);
    }

    public static recognizeWithDebug(
        dataUrl: string,
        pageSegMode: PSM,
        model?: string,
        runtimeSettings?: OcrBackendRuntimeSettings,
        debugEnabled?: boolean,
    ): Promise<OcrRecognitionResult> {
        const settings = runtimeSettings && { ...runtimeSettings };
        return this.enqueue(async () => {
            this.lastDebugSnapshot = null;
            const backend = await this.getBackend();
            if (settings) await backend.setRuntimeSettings?.(settings);
            const captureDebug = debugEnabled ?? this.debugEnabled;
            await backend.setDebugEnabled?.(captureDebug);
            const recognizedText = await backend.recognize(dataUrl, pageSegMode, model);
            const debugSnapshot = captureDebug ? await backend.getLastDebugSnapshot?.() ?? null : null;
            this.lastDebugSnapshot = debugSnapshot;
            return { recognizedText, debugSnapshot };
        });
    }

    public static setDebugEnabled(enabled: boolean): Promise<void> {
        return this.enqueue(async () => {
            this.debugEnabled = enabled;
            if (!enabled) this.lastDebugSnapshot = null;
            await this.backend?.setDebugEnabled?.(enabled);
        });
    }

    public static setRuntimeSettings(runtimeSettings: OcrBackendRuntimeSettings): Promise<void> {
        const settings = { ...runtimeSettings };
        return this.enqueue(async () => {
            const backend = await this.getBackend();
            await backend.setRuntimeSettings?.(settings);
        });
    }

    // Status reads must not select a backend, load models, or wait behind a scan.
    public static async getAccelerationStatus(): Promise<PaddleAccelerationStatus | null> {
        return await this.backend?.getAccelerationStatus?.() ?? null;
    }

    public static retryGpu(): Promise<void> {
        return this.enqueue(async () => { await this.backend?.retryGpu?.(); });
    }

    public static async getLastDebugSnapshot(): Promise<OcrDebugSnapshot | null> {
        return this.lastDebugSnapshot;
    }

    public static terminate(): Promise<void> {
        return this.enqueue(async () => {
            const backend = this.backend;
            this.backend = null;
            this.lastDebugSnapshot = null;
            await backend?.terminate();
        });
    }
}
