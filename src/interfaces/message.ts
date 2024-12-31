import { PSM } from "tesseract.js"

export enum NamidaMessageAction {
    SnipPage,
    CaptureFullScreen,
    UpscaleImage,
    RecognizeImage,
    RecognizeImageOffscreen,
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