import { PSM } from "tesseract.js"

export enum NamidaMessageAction {
    SnipPage,
    CaptureFullScreen,
    UpscaleImage,
    RecognizeImage,
    RecognizeImageOffscreen,
    TranslateText,
    TranslateTextOffscreen,
}

export interface NamidaMessage {
    action: NamidaMessageAction,
    data: any
}


export interface NamidaOcrFromOffscreenData {
    imageData: string,
    pageSegMode: PSM
}
export interface NamidaOcrFromOffscreenMessage {
    action: NamidaMessageAction,
    data: NamidaOcrFromOffscreenData
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
