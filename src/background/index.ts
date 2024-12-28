import { commands, runtime, tabs } from "webextension-polyfill";
import { NamidaMessage, NamidaMessageAction } from "../interfaces/message";
import { TesseractOcrHandler } from "./TesseractOcrHandler";

console.log('Background script loaded');

/**
 * 1. Initialize the OCR worker once on script startup.
 *    This way, the worker is ready whenever a recognize request comes in.
 */
(async () => {
    await TesseractOcrHandler.initWorker();
})().catch(console.error);

commands.onCommand.addListener(async (command) => {
    if (command === "toggle-feature") {
        const [tab] = await tabs.query({ active: true, currentWindow: true });
        if (tab.id) {
            tabs.sendMessage(tab.id, { action: NamidaMessageAction.SnipPage });
        }
    }
});

runtime.onMessage.addListener(async (message, sender) => {
    const namidaMessage = message as NamidaMessage;

    switch (namidaMessage.action) {
        case NamidaMessageAction.CaptureFullScreen: {
            return await tabs.captureVisibleTab(undefined, { format: 'png' });
        }

        case NamidaMessageAction.RecognizeImage: {
            return await TesseractOcrHandler.recognizeFromBackground(namidaMessage.data);
        }

        default:
            break;
    }
});