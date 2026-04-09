import { PSM } from 'tesseract.js';
import { OcrBackend, type OcrBackendRuntimeSettings } from './OcrBackend';
import type { OcrDebugSnapshot } from './OcrDebugSnapshot';

type OcrBackendModule = {
    ConfiguredOcrBackend: new () => OcrBackend;
};

export class OcrService {
    private static backend: OcrBackend | null = null;
    private static backendPromise: Promise<OcrBackend> | null = null;
    private static debugEnabled = false;

    private static async getBackend(): Promise<OcrBackend> {
        if (this.backend) {
            return this.backend;
        }

        if (!this.backendPromise) {
            this.backendPromise = import('namida-ocr-backend').then(async (module) => {
                const backendModule = module as OcrBackendModule;
                const backend = new backendModule.ConfiguredOcrBackend();
                await backend.setDebugEnabled?.(this.debugEnabled);
                this.backend = backend;
                return backend;
            }).catch((error) => {
                this.backendPromise = null;
                throw error;
            });
        }

        return this.backendPromise;
    }

    public static async init(model?: string, runtimeSettings?: OcrBackendRuntimeSettings): Promise<void> {
        const backend = await this.getBackend();
        if (runtimeSettings) {
            await backend.setRuntimeSettings?.(runtimeSettings);
        }
        await backend.init(model);
    }

    public static async recognize(
        dataUrl: string,
        pageSegMode: PSM,
        model?: string,
        runtimeSettings?: OcrBackendRuntimeSettings,
    ): Promise<string | undefined> {
        const backend = await this.getBackend();
        if (runtimeSettings) {
            await backend.setRuntimeSettings?.(runtimeSettings);
        }
        return backend.recognize(dataUrl, pageSegMode, model);
    }

    public static async setDebugEnabled(enabled: boolean): Promise<void> {
        this.debugEnabled = enabled;
        const backend = await this.getBackend();
        await backend.setDebugEnabled?.(enabled);
    }

    public static async setRuntimeSettings(runtimeSettings: OcrBackendRuntimeSettings): Promise<void> {
        const backend = await this.getBackend();
        await backend.setRuntimeSettings?.(runtimeSettings);
    }

    public static async getLastDebugSnapshot(): Promise<OcrDebugSnapshot | null> {
        const backend = await this.getBackend();
        return await backend.getLastDebugSnapshot?.() ?? null;
    }

    public static async terminate(): Promise<void> {
        if (!this.backend && !this.backendPromise) {
            return;
        }

        this.backend = null;
        const pendingBackend = this.backendPromise;
        this.backendPromise = null;
        const backend = pendingBackend ? await pendingBackend : null;
        await backend?.terminate();
    }
}
