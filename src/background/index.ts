import { commands, runtime, tabs } from "webextension-polyfill";
import { PSM } from "tesseract.js";
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
let offscreenCreation: Promise<void> | null = null;

function ensureOffscreenDocument(): Promise<void> {
    // Share both the existence check and creation: simultaneous first snips
    // would otherwise each try to create Chrome's single offscreen document.
    if (!offscreenCreation) {
        offscreenCreation = (async () => {
            if (!await chrome.offscreen.hasDocument?.()) {
                await chrome.offscreen.createDocument({
                    url: runtime.getURL('offscreen/offscreen.html'),
                    reasons: [chrome.offscreen.Reason.WORKERS],
                    justification: 'Perform background OCR with bundled local assets'
                });
            }
        })().finally(() => { offscreenCreation = null; });
    }
    return offscreenCreation;
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
                Settings.getOcrDebugArtifacts(),
                Settings.getOcrModel(),
                Settings.getOcrBackend(),
                Settings.getPaddleOnnxGpuEnabled(),
            ]).then(([debugArtifactsEnabled, ocrModel, ocrBackend, paddleGpuEnabled]) => {
                lastOcrDebugSnapshot = null;
                const resolvedPageSegMode = ocrBackend === 'paddleonnx'
                    ? PSM.AUTO
                    : ocrModel.trim() === 'jpn'
                        ? PSM.SINGLE_BLOCK
                        : PSM.SINGLE_BLOCK_VERT_TEXT;
                const runtimeSettings = {
                    backend: ocrBackend === 'paddleonnx' ? 'paddleonnx' : 'tesseract',
                    paddleGpuEnabled,
                } as const;

                if (globalThis.Worker) {
                    return BackgroundOcrService.recognizeWithDebug(
                        namidaMessage.data,
                        resolvedPageSegMode,
                        ocrModel,
                        runtimeSettings,
                        debugArtifactsEnabled,
                    ).then((result) => {
                        lastOcrDebugSnapshot = result.debugSnapshot;
                        return result.recognizedText;
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
                                    pageSegMode: resolvedPageSegMode,
                                    ocrModel: ocrModel,
                                    runtimeSettings: {
                                        ocrBackend: runtimeSettings.backend,
                                        paddleGpuEnabled: runtimeSettings.paddleGpuEnabled,
                                    },
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

        case NamidaMessageAction.GetOcrAccelerationStatus:
        case NamidaMessageAction.RetryOcrGpu: {
            const retry = namidaMessage.action === NamidaMessageAction.RetryOcrGpu;
            return (async () => {
                if (globalThis.Worker) {
                    if (retry) await BackgroundOcrService.retryGpu();
                    return BackgroundOcrService.getAccelerationStatus();
                }
                // Merely opening the popup must not create the offscreen host or
                // initialize a model. A later scan creates it through the normal path.
                if (!await chrome.offscreen.hasDocument?.()) return null;
                return runtime.sendMessage({
                    action: retry ? NamidaMessageAction.RetryOcrGpuOffscreen : NamidaMessageAction.GetOcrAccelerationStatusOffscreen,
                });
            })();
        }
    }
});
