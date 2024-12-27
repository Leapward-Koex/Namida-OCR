export enum NamidaMessageAction {
    SnipPage,
    CaptureFullScreen,
    RecognizeImage,
}

export interface NamidaMessage {
    action: NamidaMessageAction,
    data: any
}