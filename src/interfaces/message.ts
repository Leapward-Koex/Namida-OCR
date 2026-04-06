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
    GetLastOcrDebugSnapshotOffscreen
}

export interface NamidaMessage {
    action: NamidaMessageAction,
    data: any
}


export interface NamidaOcrFromOffscreenData {
    debugArtifactsEnabled: boolean,
    imageData: string,
    pageSegMode: PSM,
    ocrModel: string
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
