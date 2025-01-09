import { commands, runtime, tabs } from "webextension-polyfill";
import { NamidaMessage, NamidaMessageAction, NamidaOcrFromOffscreenData, NamidaTensorflowUpscaleData } from "../interfaces/message";
import { TesseractOcrHandler } from "./TesseractOcrHandler";
import { Upscaler } from "./Upscaler";
import { Settings } from "../interfaces/Storage";
import { TranslationHandler } from "./TranslationHandler";
import { BrowserType, getCurrentBrowser } from "../interfaces/browserInfo";

console.log('Background script loaded');
if (globalThis.Worker) {
    // Workers are available in the service worker, e.g. Firefox
    (async () => {
        await TesseractOcrHandler.initWorker();
    })().catch(console.error);
}

if (getCurrentBrowser() === BrowserType.Firefox) {
    (async () => {
        // Firefox uses background scripts instead of a service worker and due to extension file size limits must use remote models.
        await TranslationHandler.initWorker(false);
    })().catch(console.error);
}

async function ensureOffscreenDocument() {
    const offscreenUrl = runtime.getURL('offscreen/offscreen.html');
    // Check if offscreen is already created
    const existingDocs = await chrome.offscreen.hasDocument?.();
    if (!existingDocs) {
        await chrome.offscreen.createDocument({
            url: offscreenUrl,
            reasons: [chrome.offscreen.Reason.WORKERS],
            justification: 'Perform background OCR using Tesseract.js and translations using ONNX transformers'
        });
    }
}

commands.onCommand.addListener((command) => {
    if (command === "toggle-feature") {
        console.debug("Going to snip page for OCR")
        tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
            if (tab?.id) {
                tabs.sendMessage(tab.id, { action: NamidaMessageAction.SnipPage });
            }
            else {
                console.debug("Could not find tab to snip")
            }
        });
    }
});

runtime.onMessage.addListener((message, sender) => {
    const namidaMessage = message as NamidaMessage;

    switch (namidaMessage.action) {
        case NamidaMessageAction.CaptureFullScreen: {
            return tabs.captureVisibleTab(undefined, { format: 'png' });
        }

        case NamidaMessageAction.UpscaleImage: {
            return Upscaler.upscaleImageWithAIFromBackground(namidaMessage.data as NamidaTensorflowUpscaleData);
        }

        case NamidaMessageAction.RecognizeImage: {
            return Settings.getPageSegMode().then((pageSegMode) => {
                if (globalThis.Worker) {
                    return TesseractOcrHandler.recognizeFromOffscreen(namidaMessage.data, pageSegMode);
                }
                else {
                    return ensureOffscreenDocument().then(() => {
                        return runtime.sendMessage(
                            {
                                action: NamidaMessageAction.RecognizeImageOffscreen,
                                data: {
                                    imageData: namidaMessage.data,
                                    pageSegMode: pageSegMode
                                } as NamidaOcrFromOffscreenData
                            });
                    });
                }
            });
        }

        case NamidaMessageAction.TranslateTextOffscreen: {
            return Settings.getPageSegMode().then((pageSegMode) => {
                if (globalThis.Worker) {
                    return TesseractOcrHandler.recognizeFromOffscreen(namidaMessage.data, pageSegMode);
                }
                else {
                    return ensureOffscreenDocument().then(() => {
                        return runtime.sendMessage(
                            {
                                action: NamidaMessageAction.RecognizeImageOffscreen,
                                data: {
                                    imageData: namidaMessage.data,
                                    pageSegMode: pageSegMode
                                } as NamidaOcrFromOffscreenData
                            });
                    });
                }
            });
        }

        case NamidaMessageAction.TranslateText: {
            if (getCurrentBrowser() === BrowserType.Firefox) {
                return TranslationHandler.translateText(namidaMessage.data);
            }
            else {
                return ensureOffscreenDocument().then(() => {
                    return runtime.sendMessage(
                        {
                            action: NamidaMessageAction.TranslateTextOffscreen,
                            data: namidaMessage.data
                        });
                });
            }
        }
    }
});