import { PSM } from "tesseract.js";
import { UpscaleMethod } from "../content/ScreenshotHandler";
import { FuriganaType } from "../background/FuriganaHandler";

export enum StorageKey {
    OcrBackend = "OcrBackend",
    PaddleOnnxGpuEnabled = "PaddleOnnxGpuEnabled",
    UpscalingMode = "UpscalingMode",
    PageSegMode = "PageSegMode",
    OcrModel = "OcrModel",
    OcrDebugArtifacts = "OcrDebugArtifacts",
    SaveOcrCrop = "SaveOcrCrop",
    ShowSpeakButton = "ShowSpeakButton",
    PreferredVoices = "PreferredVoices",
    WindowTimeout = "WindowTimeout",
    FuriganaType = "FuriganaType"
}

export const DEFAULT_OCR_MODEL = __NAMIDA_OCR_MODEL__;
export type OcrBackendKind = 'tesseract' | 'scribejs' | 'paddleonnx';
export const DEFAULT_PADDLE_ONNX_GPU_ENABLED = true;

function normalizeOcrBackendKind(backend: string): OcrBackendKind {
    if (backend === 'scribejs' || backend === 'paddleonnx') {
        return backend;
    }

    return 'tesseract';
}

export const DEFAULT_OCR_BACKEND: OcrBackendKind = normalizeOcrBackendKind(__NAMIDA_OCR_BACKEND__);
const OCR_MODEL_PATTERN = /^[A-Za-z0-9_-]+$/;

export enum FuriganaTypeString {
    None = 'none',
    Hiragana = 'hiragana',
    Katakana = 'katakana'
}

export enum UpscalingModeString {
    None = 'none',
    Canvas = 'canvas',
    Tensorflow = 'tensorflow'
}

export enum PageSegModeString {
    SingleBlock = 'single-block',
    SingleBlockVertical = 'single-block-vertical',
    Auto = 'auto'
}

export enum TesseractTextDirectionString {
    Horizontal = 'horizontal',
    Vertical = 'vertical'
}

type StorageQuery = string | string[] | { [key: string]: unknown } | null;

function describeStorageQuery(query: StorageQuery): string {
    if (query === null) {
        return 'null';
    }

    if (typeof query === 'string') {
        return query;
    }

    if (Array.isArray(query)) {
        return query.join(', ');
    }

    return Object.keys(query).join(', ');
}

function getSyncStorageArea(query: StorageQuery) {
    const syncStorage = chrome?.storage?.sync;

    if (!syncStorage) {
        throw new Error(`chrome.storage.sync is unavailable while reading ${describeStorageQuery(query)}.`);
    }

    return syncStorage;
}

function readSyncStorage(query: StorageQuery): Promise<Record<string, unknown>> {
    const syncStorage = getSyncStorageArea(query);

    return new Promise((resolve, reject) => {
        syncStorage.get(query, (items) => {
            const lastError = chrome.runtime?.lastError;

            if (lastError) {
                reject(new Error(lastError.message));
                return;
            }

            resolve((items ?? {}) as Record<string, unknown>);
        });
    });
}

export class Settings {
    private static getOcrModelFromString(settingString: string | undefined) {
        const trimmedSetting = settingString?.trim();

        if (trimmedSetting && OCR_MODEL_PATTERN.test(trimmedSetting)) {
            return trimmedSetting;
        }

        return DEFAULT_OCR_MODEL;
    }

    private static getFuriganaTypeString(settingString: string | undefined) {
        if (settingString === FuriganaTypeString.None) {
            return FuriganaType.None;
        }
        else if (settingString === FuriganaTypeString.Hiragana) {
            return FuriganaType.Hiragana;
        }
        if (settingString === FuriganaTypeString.Katakana) {
            return FuriganaType.Katakana;
        }
        return FuriganaType.Hiragana;
    }

    private static getUpscalingModeFromString(settingString: string | undefined) {
        if (settingString === UpscalingModeString.None) {
            return UpscaleMethod.None;
        }
        else if (settingString === UpscalingModeString.Canvas) {
            return UpscaleMethod.Canvas;
        }
        if (settingString === UpscalingModeString.Tensorflow) {
            return UpscaleMethod.TensorFlow;
        }
        return UpscaleMethod.Canvas;
    }

    private static getPageSegModeFromString(settingString: string | undefined) {
        if (settingString === PageSegModeString.SingleBlock) {
            return PSM.SINGLE_BLOCK;
        }
        else if (settingString === PageSegModeString.SingleBlockVertical) {
            return PSM.SINGLE_BLOCK_VERT_TEXT;
        }
        if (settingString === PageSegModeString.Auto) {
            return PSM.AUTO;
        }
        return PSM.AUTO;
    }

    public static async getWindowTimeout() {
        const values = await readSyncStorage(StorageKey.WindowTimeout);
        const value = values[StorageKey.WindowTimeout] as string | undefined;
        return Number(value ?? "30000");
    }

    public static async getFuriganaType() {
        const values = await readSyncStorage(StorageKey.FuriganaType);
        return this.getFuriganaTypeString((values[StorageKey.FuriganaType] as string | undefined));
    }

    public static async getUpscalingMode() {
        const values = await readSyncStorage(StorageKey.UpscalingMode);
        return this.getUpscalingModeFromString((values[StorageKey.UpscalingMode] as string | undefined));
    }

    public static async getOcrBackend() {
        const values = await readSyncStorage(StorageKey.OcrBackend);
        return normalizeOcrBackendKind((values[StorageKey.OcrBackend] as string | undefined) ?? DEFAULT_OCR_BACKEND);
    }

    public static async getPaddleOnnxGpuEnabled() {
        const values = await readSyncStorage(StorageKey.PaddleOnnxGpuEnabled);
        return (values[StorageKey.PaddleOnnxGpuEnabled] as boolean | undefined) ?? DEFAULT_PADDLE_ONNX_GPU_ENABLED;
    }

    public static async getPageSegMode() {
        const values = await readSyncStorage(StorageKey.PageSegMode);
        return this.getPageSegModeFromString((values[StorageKey.PageSegMode] as string | undefined));
    }

    public static async getOcrModel() {
        const values = await readSyncStorage(StorageKey.OcrModel);
        return this.getOcrModelFromString((values[StorageKey.OcrModel] as string | undefined));
    }

    public static async getOcrDebugArtifacts() {
        const values = await readSyncStorage(StorageKey.OcrDebugArtifacts);
        return (values[StorageKey.OcrDebugArtifacts] as boolean | undefined) ?? false;
    }

    public static async getSaveOcrCrop() {
        const values = await readSyncStorage(StorageKey.SaveOcrCrop);
        return (values[StorageKey.SaveOcrCrop] as boolean | undefined) ?? false;
    }

    public static async getShowSpeakButton() {
        const values = await readSyncStorage(StorageKey.ShowSpeakButton);
        return (values[StorageKey.ShowSpeakButton] as boolean | undefined) ?? true;
    }

    public static async getPreferredVoiceId(language = "ja-JP") {
        const preferredVoices = await Settings.getPreferredVoicesUri();
        return preferredVoices[language.toLowerCase()];
    }

    public static async getPreferredVoicesUri() {
        const values = await readSyncStorage(StorageKey.PreferredVoices);
        // language code -> voiceURI
        return (values[StorageKey.PreferredVoices] as { [language: string]: string } | undefined) ?? {};
    }
}
