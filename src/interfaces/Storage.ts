import { PSM } from "tesseract.js";
import { UpscaleMethod } from "../content/ScreenshotHandler";
import { storage } from "webextension-polyfill";

export enum StorageKey {
    UpscalingMode = "UpscalingMode",
    PageSegMode = "PageSegMode",
    SaveOcrCrop = "SaveOcrCrop",
    ShowSpeakButton = "ShowSpeakButton",
    PreferredVoices = "PreferredVoices",
    WindowTimeout = "WindowTimeout"
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

export class Settings {
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
        const values = await storage.sync.get(StorageKey.WindowTimeout);
        const value = values[StorageKey.WindowTimeout] as string | undefined;
        return Number(value ?? "30000");
    }

    public static async getUpscalingMode() {
        const values = await storage.sync.get(StorageKey.UpscalingMode);
        return this.getUpscalingModeFromString((values[StorageKey.UpscalingMode] as string | undefined));
    }

    public static async getPageSegMode() {
        const values = await storage.sync.get(StorageKey.PageSegMode);
        return this.getPageSegModeFromString((values[StorageKey.PageSegMode] as string | undefined));
    }

    public static async getSaveOcrCrop() {
        const values = await storage.sync.get(StorageKey.SaveOcrCrop);
        return (values[StorageKey.SaveOcrCrop] as boolean | undefined) ?? false;
    }

    public static async getShowSpeakButton() {
        const values = await storage.sync.get(StorageKey.ShowSpeakButton);
        return (values[StorageKey.ShowSpeakButton] as boolean | undefined) ?? true;
    }

    public static async getPreferredVoiceId(language = "ja-JP") {
        const preferredVoices = await Settings.getPreferredVoicesUri();
        return preferredVoices[language.toLowerCase()];
    }

    public static async getPreferredVoicesUri() {
        const values = await storage.sync.get(StorageKey.PreferredVoices);
        // language code -> voiceURI
        return (values[StorageKey.PreferredVoices] as { [language: string]: string } | undefined) ?? {};
    }
}