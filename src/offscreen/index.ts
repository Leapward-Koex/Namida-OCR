import { runtime } from "webextension-polyfill";
import { NamidaMessage, NamidaMessageAction, NamidaOcrFromOffscreenMessage } from "../interfaces/message";
import { TesseractOcrHandler } from "../background/TesseractOcrHandler";
import { TranslationHandler } from "../background/TranslationHandler";

console.debug("Loading offscreen document");

/**
 * 1. Initialize the OCR worker once on script startup.
 *    This way, the offscreen worker is ready whenever a recognize request comes in.
 */
(async () => {
    await TesseractOcrHandler.initWorker();
})().catch(console.error);

(async () => {
    await TranslationHandler.initWorker();
})().catch(console.error);

runtime.onMessage.addListener((message) => {
    const namidaMessage = message as NamidaMessage;
    if (namidaMessage.action === NamidaMessageAction.RecognizeImageOffscreen) {
        const namidaOffscreenOcrMessage = message as NamidaOcrFromOffscreenMessage;
        return TesseractOcrHandler.recognizeFromOffscreen(namidaOffscreenOcrMessage.data.imageData, namidaOffscreenOcrMessage.data.pageSegMode);
    }
    else if (namidaMessage.action === NamidaMessageAction.TranslateTextOffscreen) {
        return TranslationHandler.translateText(namidaMessage.data);
    }
});
