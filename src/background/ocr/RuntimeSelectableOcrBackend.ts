import { PSM } from 'tesseract.js';
import { DEFAULT_OCR_BACKEND, Settings, type OcrBackendKind } from '../../interfaces/Storage';
import type { OcrBackend } from './OcrBackend';
import { PaddleOnnxOcrBackend } from './PaddleOnnxOcrBackend';
import { TesseractOcrBackend } from './TesseractOcrBackend';
import type { OcrDebugSnapshot } from './OcrDebugSnapshot';

type SupportedRuntimeBackendKind = 'tesseract' | 'paddleonnx';

type RuntimeBackend = OcrBackend & {
    setGpuEnabled?(enabled: boolean): Promise<void> | void;
};

type RuntimeBackendSettings = {
    backend: SupportedRuntimeBackendKind;
    paddleGpuEnabled: boolean;
};

function normalizeRuntimeBackendKind(backend: OcrBackendKind): SupportedRuntimeBackendKind {
    if (backend === 'paddleonnx') {
        return 'paddleonnx';
    }

    return 'tesseract';
}

export class RuntimeSelectableOcrBackend implements OcrBackend {
    private activeBackend: RuntimeBackend | null = null;
    private activeBackendKey: string | null = null;
    private debugEnabled = false;

    public async init(model?: string): Promise<void> {
        const backend = await this.ensureBackend();
        await backend.init(model);
    }

    public async recognize(dataUrl: string, pageSegMode: PSM, model?: string): Promise<string | undefined> {
        const backend = await this.ensureBackend();
        return backend.recognize(dataUrl, pageSegMode, model);
    }

    public async setDebugEnabled(enabled: boolean): Promise<void> {
        this.debugEnabled = enabled;
        await this.activeBackend?.setDebugEnabled?.(enabled);
    }

    public async getLastDebugSnapshot(): Promise<OcrDebugSnapshot | null> {
        return await this.activeBackend?.getLastDebugSnapshot?.() ?? null;
    }

    public async terminate(): Promise<void> {
        const backend = this.activeBackend;
        this.activeBackend = null;
        this.activeBackendKey = null;
        await backend?.terminate();
    }

    private async ensureBackend(): Promise<RuntimeBackend> {
        const settings = await this.getSettings();
        const backendKey = this.getBackendKey(settings);

        if (this.activeBackend && this.activeBackendKey === backendKey) {
            return this.activeBackend;
        }

        await this.terminate();
        const backend = this.createBackend(settings.backend);
        await backend.setDebugEnabled?.(this.debugEnabled);

        if (settings.backend === 'paddleonnx') {
            await backend.setGpuEnabled?.(settings.paddleGpuEnabled);
        }

        this.activeBackend = backend;
        this.activeBackendKey = backendKey;
        return backend;
    }

    private createBackend(backend: SupportedRuntimeBackendKind): RuntimeBackend {
        if (backend === 'paddleonnx') {
            return new PaddleOnnxOcrBackend();
        }

        return new TesseractOcrBackend();
    }

    private getBackendKey(settings: RuntimeBackendSettings): string {
        if (settings.backend === 'paddleonnx') {
            return `${settings.backend}:${settings.paddleGpuEnabled ? 'gpu' : 'cpu'}`;
        }

        return settings.backend;
    }

    private async getSettings(): Promise<RuntimeBackendSettings> {
        const [ocrBackend, paddleGpuEnabled] = await Promise.all([
            Settings.getOcrBackend(),
            Settings.getPaddleOnnxGpuEnabled(),
        ]);

        return {
            backend: normalizeRuntimeBackendKind(ocrBackend ?? DEFAULT_OCR_BACKEND),
            paddleGpuEnabled,
        };
    }
}

export { RuntimeSelectableOcrBackend as ConfiguredOcrBackend };
