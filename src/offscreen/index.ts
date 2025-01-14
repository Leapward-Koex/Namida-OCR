import { runtime } from "webextension-polyfill";
import { NamidaMessage, NamidaMessageAction, NamidaOcrFromOffscreenMessage } from "../interfaces/message";
import { TesseractOcrHandler } from "../background/TesseractOcrHandler";
import { FuriganaHandler } from "../background/FuriganaHandler";

console.debug("Loading offscreen document");

/**
 * 1. Initialize the OCR worker once on script startup.
 *    This way, the offscreen worker is ready whenever a recognize request comes in.
 */
(async () => {
    await TesseractOcrHandler.initWorker();
})().catch(console.error);

runtime.onMessage.addListener((message) => {
    const namidaMessage = message as NamidaMessage;
    if (namidaMessage.action === NamidaMessageAction.RecognizeImageOffscreen) {
        const namidaOcrMessage = message as NamidaOcrFromOffscreenMessage;
        return TesseractOcrHandler.recognizeFromOffscreen(namidaOcrMessage.data.imageData, namidaOcrMessage.data.pageSegMode);
    }
    if (namidaMessage.action === NamidaMessageAction.GenerateFuriganaOffscreen) {
        return FuriganaHandler.generateFurigana(namidaMessage.data);
    }
});
