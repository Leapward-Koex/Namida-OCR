import { PSM } from "tesseract.js"

export enum NamidaMessageAction {
    SnipPage,
    CaptureFullScreen,
    UpscaleImage,
    RecognizeImage,
    RecognizeImageOffscreen,
    GenerateFurigana,
    GenerateFuriganaOffscreen,
    GetLastOcrDebugSnapshot,
    GetLastOcrDebugSnapshotOffscreen,
    GetOcrAccelerationStatus,
    GetOcrAccelerationStatusOffscreen,
    RetryOcrGpu,
    RetryOcrGpuOffscreen,
    PreloadOcr,
    PreloadOcrOffscreen,
    GetTranslationStatus,
    GetTranslationStatusOffscreen,
    TranslateText,
    TranslateTextOffscreen,
    CancelTranslation,
    CancelTranslationOffscreen,
    ResetTranslation,
    ResetTranslationOffscreen,
    OpenTranslationSettings,
}

export interface NamidaMessage {
    action: NamidaMessageAction,
    data: any
}

export interface NamidaOcrRuntimeSettings {
    ocrBackend: 'tesseract' | 'paddleonnx',
    paddleGpuEnabled: boolean,
}

export interface NamidaOcrPreloadData {
    ocrModel: string,
    runtimeSettings: NamidaOcrRuntimeSettings
}

export interface NamidaOcrFromOffscreenData extends NamidaOcrPreloadData {
    debugArtifactsEnabled: boolean,
    imageData: string,
    pageSegMode: PSM,
}
export interface NamidaOcrFromOffscreenMessage {
    action: NamidaMessageAction,
    data: NamidaOcrFromOffscreenData
}

export interface NamidaOcrFromOffscreenResult {
    debugSnapshot: unknown,
    recognizedText: string | undefined
}

export interface NamidaTensorflowUpscaleData {
    imageData: number[]
    shape: [number, number, number]
    dataUrl?: string,
}

export interface NamidaTensorflowUpscaleMessage {
    action: NamidaMessageAction,
    data: NamidaTensorflowUpscaleData
}
