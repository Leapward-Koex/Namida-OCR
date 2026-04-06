import { PSM } from 'tesseract.js';
import { OcrBackend } from './OcrBackend';

type OcrBackendModule = {
    ConfiguredOcrBackend: new () => OcrBackend;
};

export class OcrService {
    private static backend: OcrBackend | null = null;
    private static backendPromise: Promise<OcrBackend> | null = null;

    private static async getBackend(): Promise<OcrBackend> {
        if (this.backend) {
            return this.backend;
        }

        if (!this.backendPromise) {
            this.backendPromise = import('namida-ocr-backend').then((module) => {
                const backendModule = module as OcrBackendModule;
                const backend = new backendModule.ConfiguredOcrBackend();
                this.backend = backend;
                return backend;
            }).catch((error) => {
                this.backendPromise = null;
                throw error;
            });
        }

        return this.backendPromise;
    }

    public static async init(model?: string): Promise<void> {
        const backend = await this.getBackend();
        await backend.init(model);
    }

    public static async recognize(dataUrl: string, pageSegMode: PSM, model?: string): Promise<string | undefined> {
        const backend = await this.getBackend();
        return backend.recognize(dataUrl, pageSegMode, model);
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
