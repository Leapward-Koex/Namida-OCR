export enum NamidaMessageAction {
    SnipPage,
    CaptureFullScreen,
    UpscaleImage,
    RecognizeImage,
}

export interface NamidaMessage {
    action: NamidaMessageAction,
    data: any
}