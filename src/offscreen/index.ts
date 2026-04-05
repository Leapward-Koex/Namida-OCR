import { runtime } from "webextension-polyfill";
import { NamidaMessage, NamidaMessageAction, NamidaOcrFromOffscreenMessage } from "../interfaces/message";
import { FuriganaHandler } from "../background/FuriganaHandler";
import { OcrService } from "../background/OcrService";

console.debug("Loading offscreen document");

/**
 * 1. Initialize the OCR worker once on script startup.
 *    This way, the offscreen worker is ready whenever a recognize request comes in.
 */
(async () => {
    await OcrService.init();
})().catch(console.error);

runtime.onMessage.addListener((message) => {
    const namidaMessage = message as NamidaMessage;
    if (namidaMessage.action === NamidaMessageAction.RecognizeImageOffscreen) {
        const namidaOcrMessage = message as NamidaOcrFromOffscreenMessage;
        return OcrService.recognize(
            namidaOcrMessage.data.imageData,
            namidaOcrMessage.data.pageSegMode,
            namidaOcrMessage.data.ocrModel,
        );
    }
    if (namidaMessage.action === NamidaMessageAction.GenerateFuriganaOffscreen) {
        return FuriganaHandler.generateFurigana(namidaMessage.data);
    }
});
