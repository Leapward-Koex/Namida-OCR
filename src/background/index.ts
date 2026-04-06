import { commands, runtime, tabs } from "webextension-polyfill";
import { NamidaMessage, NamidaMessageAction, NamidaOcrFromOffscreenData, NamidaOcrFromOffscreenResult, NamidaTensorflowUpscaleData } from "../interfaces/message";
import { Upscaler } from "./Upscaler";
import { Settings } from "../interfaces/Storage";
import { FuriganaHandler } from "./FuriganaHandler";
import { BackgroundOcrService } from "namida-background-ocr-service";
import type { OcrDebugSnapshot } from "./ocr/OcrDebugSnapshot";

console.log('Background script loaded');

type BackgroundDebugState = {
    events: Array<{
        at: string;
        data?: unknown;
        message: string;
    }>;
    startedAt: string;
};

type BackgroundDebugGlobal = typeof globalThis & {
    __namidaDebugState?: BackgroundDebugState;
};

((globalThis as BackgroundDebugGlobal).__namidaDebugState ??= {
    events: [],
    startedAt: new Date().toISOString(),
});

let lastOcrDebugSnapshot: OcrDebugSnapshot | null = null;

if (globalThis.Worker) {
    // Workers are available in the service worker, e.g. Firefox
    (async () => {
        await BackgroundOcrService.init();
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
            justification: 'Perform background OCR with bundled local assets'
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
            return tabs.captureVisibleTab(sender.tab?.windowId, { format: 'png' });
        }

        case NamidaMessageAction.UpscaleImage: {
            return Upscaler.upscaleImageWithAIFromBackground(namidaMessage.data as NamidaTensorflowUpscaleData);
        }

        case NamidaMessageAction.GenerateFurigana: {
            if (globalThis.XMLHttpRequest) {
                return FuriganaHandler.generateFurigana(namidaMessage.data);
            }
            else {
                return ensureOffscreenDocument().then(() => {
                    return runtime.sendMessage(
                        {
                            action: NamidaMessageAction.GenerateFuriganaOffscreen,
                            data: namidaMessage.data
                        });
                });
            }
        }

        case NamidaMessageAction.RecognizeImage: {
            return Promise.all([
                Settings.getPageSegMode(),
                Settings.getOcrDebugArtifacts(),
                Settings.getOcrModel(),
            ]).then(([pageSegMode, debugArtifactsEnabled, ocrModel]) => {
                lastOcrDebugSnapshot = null;

                if (globalThis.Worker) {
                    return BackgroundOcrService.setDebugEnabled(debugArtifactsEnabled).then(async () => {
                        const recognizedText = await BackgroundOcrService.recognize(namidaMessage.data, pageSegMode, ocrModel);
                        lastOcrDebugSnapshot = debugArtifactsEnabled
                            ? await BackgroundOcrService.getLastDebugSnapshot()
                            : null;
                        return recognizedText;
                    });
                }
                else {
                    return ensureOffscreenDocument().then(async () => {
                        const offscreenResult = await runtime.sendMessage(
                            {
                                action: NamidaMessageAction.RecognizeImageOffscreen,
                                data: {
                                    debugArtifactsEnabled,
                                    imageData: namidaMessage.data,
                                    pageSegMode: pageSegMode,
                                    ocrModel: ocrModel
                                } as NamidaOcrFromOffscreenData
                            }) as NamidaOcrFromOffscreenResult | string | undefined;

                        if (typeof offscreenResult === 'object' && offscreenResult !== null && 'recognizedText' in offscreenResult) {
                            lastOcrDebugSnapshot = (offscreenResult.debugSnapshot as OcrDebugSnapshot | null) ?? null;
                            return offscreenResult.recognizedText;
                        }

                        lastOcrDebugSnapshot = null;
                        return offscreenResult;
                    });
                }
            });
        }

        case NamidaMessageAction.GetLastOcrDebugSnapshot: {
            return Promise.resolve(lastOcrDebugSnapshot);
        }
    }
});
