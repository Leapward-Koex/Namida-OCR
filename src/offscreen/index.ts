import { runtime } from "webextension-polyfill";
import { NamidaMessage, NamidaMessageAction, NamidaOcrFromOffscreenMessage } from "../interfaces/message";
import { TesseractOcrHandler } from "../background/TesseractOcrHandler";

console.debug("Loading offscreen document");

/**
 * 1. Initialize the OCR worker once on script startup.
 *    This way, the offscreen worker is ready whenever a recognize request comes in.
 */
(async () => {
    await TesseractOcrHandler.initWorker();
})().catch(console.error);

runtime.onMessage.addListener(async (message, sender, sendResponse) => {
    const namidaMessage = message as NamidaOcrFromOffscreenMessage;
    if (namidaMessage.action === NamidaMessageAction.RecognizeImageOffscreen) {
        return TesseractOcrHandler.recognizeFromOffscreen(namidaMessage.data.imageData, namidaMessage.data.pageSegMode);
    }
});
