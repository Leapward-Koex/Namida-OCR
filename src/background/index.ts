import { commands, runtime, tabs } from "webextension-polyfill";
import { NamidaMessage, NamidaMessageAction, NamidaOcrFromOffscreenData } from "../interfaces/message";
import { TesseractOcrHandler } from "./TesseractOcrHandler";
import { Upscaler } from "./Upscaler";
import { Settings } from "../interfaces/Storage";

console.log('Background script loaded');

if (globalThis.Worker) {
    // Workers are available in the service worker, e.g. Firefox
    (async () => {
        await TesseractOcrHandler.initWorker();
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
            justification: 'Perform background OCR using Tesseract.js'
        });
    }
}

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

        case NamidaMessageAction.UpscaleImage: {
            return await Upscaler.upscaleImageWithAIFromBackground(namidaMessage.data);
        }

        case NamidaMessageAction.RecognizeImage: {
            const pageSegMode = await Settings.getPageSegMode();
            if (globalThis.Worker) {
                return await TesseractOcrHandler.recognizeFromOffscreen(namidaMessage.data, pageSegMode);
            }
            else {
                await ensureOffscreenDocument();
                return new Promise(async (resolve, reject) => {
                    chrome.runtime.sendMessage(
                        {
                            action: NamidaMessageAction.RecognizeImageOffscreen,
                            data: {
                                imageData: namidaMessage.data,
                                pageSegMode: pageSegMode
                            } as NamidaOcrFromOffscreenData
                        },
                        (response) => {
                            if (chrome.runtime.lastError) {
                                return reject(chrome.runtime.lastError);
                            }
                            resolve(response);
                        }
                    );
                });
            }

        }

        default:
            break;
    }
});