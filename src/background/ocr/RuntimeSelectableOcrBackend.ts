import { PSM } from 'tesseract.js';
import { DEFAULT_OCR_BACKEND, Settings, type OcrBackendKind } from '../../interfaces/Storage';
import type { OcrBackend, OcrBackendRuntimeSettings } from './OcrBackend';
import { PaddleOnnxOcrBackend } from './PaddleOnnxOcrBackend';
import { TesseractOcrBackend } from './TesseractOcrBackend';
import type { OcrDebugSnapshot } from './OcrDebugSnapshot';
import type { PaddleAccelerationStatus } from './PaddleWorkerProtocol';

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
    private runtimeSettingsOverride: RuntimeBackendSettings | null = null;
    private operationTail: Promise<unknown> = Promise.resolve();

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationTail.then(operation);
        this.operationTail = result.catch(() => undefined);
        return result;
    }

    public async init(model?: string): Promise<void> {
        const settings = this.runtimeSettingsOverride && { ...this.runtimeSettingsOverride };
        return this.enqueue(async () => {
            const backend = await this.ensureBackend(await this.getSettings(settings));
            await backend.init(model);
        });
    }

    public async recognize(dataUrl: string, pageSegMode: PSM, model?: string): Promise<string | undefined> {
        const settings = this.runtimeSettingsOverride && { ...this.runtimeSettingsOverride };
        return this.enqueue(async () => {
            const backend = await this.ensureBackend(await this.getSettings(settings));
            return backend.recognize(dataUrl, pageSegMode, model);
        });
    }

    public async setDebugEnabled(enabled: boolean): Promise<void> {
        return this.enqueue(async () => {
            this.debugEnabled = enabled;
            await this.activeBackend?.setDebugEnabled?.(enabled);
        });
    }

    public async setRuntimeSettings(settings: OcrBackendRuntimeSettings): Promise<void> {
        this.runtimeSettingsOverride = {
            backend: normalizeRuntimeBackendKind(settings.backend),
            paddleGpuEnabled: settings.paddleGpuEnabled,
        };
    }

    public async getLastDebugSnapshot(): Promise<OcrDebugSnapshot | null> {
        return await this.activeBackend?.getLastDebugSnapshot?.() ?? null;
    }

    public async getAccelerationStatus(): Promise<PaddleAccelerationStatus | null> {
        return await this.activeBackend?.getAccelerationStatus?.() ?? null;
    }

    public retryGpu(): Promise<void> {
        return this.enqueue(async () => { await this.activeBackend?.retryGpu?.(); });
    }

    public async terminate(): Promise<void> {
        return this.enqueue(() => this.terminateActiveBackend());
    }

    private async terminateActiveBackend(): Promise<void> {
        const backend = this.activeBackend;
        this.activeBackend = null;
        this.activeBackendKey = null;
        await backend?.terminate();
    }

    private async ensureBackend(settings: RuntimeBackendSettings): Promise<RuntimeBackend> {
        const backendKey = this.getBackendKey(settings);

        if (this.activeBackend && this.activeBackendKey === backendKey) {
            return this.activeBackend;
        }

        await this.terminateActiveBackend();
        const backend = this.createBackend(settings.backend);
        try {
            await backend.setDebugEnabled?.(this.debugEnabled);
            if (settings.backend === 'paddleonnx') {
                await backend.setGpuEnabled?.(settings.paddleGpuEnabled);
            }
        } catch (error) {
            await backend.terminate().catch(() => undefined);
            throw error;
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

    private async getSettings(captured: RuntimeBackendSettings | null): Promise<RuntimeBackendSettings> {
        if (captured) {
            return captured;
        }

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
