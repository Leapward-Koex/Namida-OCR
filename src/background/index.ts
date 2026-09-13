import { commands, runtime, tabs } from "webextension-polyfill";
import { PSM } from "tesseract.js";
import { NamidaMessage, NamidaMessageAction, NamidaOcrFromOffscreenData, NamidaOcrFromOffscreenResult, NamidaTensorflowUpscaleData, type NamidaOcrPreloadData } from "../interfaces/message";
import { Upscaler } from "./Upscaler";
import { Settings, StorageKey } from "../interfaces/Storage";
import { FuriganaHandler } from "./FuriganaHandler";
import { BackgroundOcrService } from "namida-background-ocr-service";
import type { OcrDebugSnapshot } from "./ocr/OcrDebugSnapshot";
import { isTranslationPlatformSupported } from '../translation/TranslatorApi';
import type { TranslationCancelRequest, TranslationRequest, TranslationResult, TranslationStatus, TranslationStatusRequest } from '../translation/TranslationTypes';

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

async function hasOffscreenDocument(): Promise<boolean> {
    // getContexts covers browser versions that expose offscreen without hasDocument.
    if (chrome.runtime?.getContexts) {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
            documentUrls: [runtime.getURL('offscreen/offscreen.html')],
        });
        return contexts.length > 0;
    }
    return await chrome.offscreen.hasDocument?.() ?? false;
}

function ensureOffscreenDocument(): Promise<void> {
    // Share both the existence check and creation: simultaneous first snips
    // would otherwise each try to create Chrome's single offscreen document.
    if (!offscreenCreation) {
        offscreenCreation = (async () => {
            if (!await hasOffscreenDocument()) {
                await chrome.offscreen.createDocument({
                    url: runtime.getURL('offscreen/offscreen.html'),
                    reasons: [chrome.offscreen.Reason.WORKERS],
                    justification: 'Perform local OCR, furigana and browser-provided translation in a document'
                });
            }
        })().finally(() => { offscreenCreation = null; });
    }
    return offscreenCreation;
}

const pendingTranslations = new Map<string, { cancelled: boolean }>();
const translationCancelled: TranslationResult = { ok: false, reason: 'cancelled', message: 'Translation cancelled.' };
let translationReset: Promise<void> = Promise.resolve();

function resetTranslation(): Promise<void> {
    // Invalidate only requests already accepted when settings changed. New
    // requests wait for disposal, so a delayed reset cannot destroy their session.
    for (const pending of pendingTranslations.values()) pending.cancelled = true;
    const resetting = translationReset.then(async () => {
        if (await hasOffscreenDocument()) {
            await runtime.sendMessage({ action: NamidaMessageAction.ResetTranslationOffscreen });
        }
    });
    translationReset = resetting.catch(() => {});
    return resetting;
}

if (__NAMIDA_TRANSLATION_ENABLED__) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'sync' && (changes[StorageKey.TranslationEnabled] || changes[StorageKey.TranslationTargetLanguage])) {
            resetTranslation().catch(console.warn);
        }
    });
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
        case NamidaMessageAction.GetTranslationStatus: {
            if (!isTranslationPlatformSupported()) return Promise.resolve({ state: 'unsupported', message: 'Local translation is unavailable in this browser' } satisfies TranslationStatus);
            const data = namidaMessage.data as TranslationStatusRequest;
            return (async (): Promise<TranslationStatus> => {
                try {
                    if (data.ensureHost) await ensureOffscreenDocument();
                    else if (!await hasOffscreenDocument()) return { state: 'error', message: 'Open translation settings to check browser availability.' };
                    return await runtime.sendMessage({ action: NamidaMessageAction.GetTranslationStatusOffscreen, data });
                } catch {
                    return { state: 'error', message: 'Could not check translation in the background. Try setup again in settings.' };
                }
            })();
        }

        case NamidaMessageAction.TranslateText: {
            if (!isTranslationPlatformSupported()) return Promise.resolve({ ok: false, reason: 'unsupported', message: 'Local translation is unavailable in this browser' } satisfies TranslationResult);
            const data = namidaMessage.data as TranslationRequest;
            const requestId = `${sender.tab?.id ?? 'extension'}:${data.requestId}`;
            const pending = { cancelled: false };
            pendingTranslations.set(requestId, pending);
            return (async (): Promise<TranslationResult> => {
                try {
                    await translationReset;
                    const settings = await Settings.getTranslationSettings();
                    if (pending.cancelled || settings.enabled === false || settings.targetLanguage !== data.targetLanguage) return translationCancelled;
                    await ensureOffscreenDocument();
                    if (pending.cancelled) return translationCancelled;
                    return await runtime.sendMessage({
                        action: NamidaMessageAction.TranslateTextOffscreen,
                        data: { ...data, requestId } satisfies TranslationRequest,
                    });
                } catch {
                    return { ok: false, reason: 'error', message: 'Local translation could not start. Try again or check translation settings.' };
                } finally {
                    if (pendingTranslations.get(requestId) === pending) pendingTranslations.delete(requestId);
                }
            })();
        }

        case NamidaMessageAction.CancelTranslation: {
            if (!isTranslationPlatformSupported()) return Promise.resolve();
            const data = namidaMessage.data as TranslationCancelRequest;
            const requestId = `${sender.tab?.id ?? 'extension'}:${data.requestId}`;
            const pending = pendingTranslations.get(requestId);
            if (pending) pending.cancelled = true;
            return hasOffscreenDocument().then((exists) => {
                if (exists) return runtime.sendMessage({ action: NamidaMessageAction.CancelTranslationOffscreen, data: { requestId } satisfies TranslationCancelRequest });
            });
        }

        case NamidaMessageAction.ResetTranslation: {
            if (!isTranslationPlatformSupported()) return Promise.resolve();
            return resetTranslation();
        }

        case NamidaMessageAction.OpenTranslationSettings: {
            if (!isTranslationPlatformSupported()) return Promise.resolve();
            return chrome.action.openPopup(sender.tab?.windowId === undefined ? {} : { windowId: sender.tab.windowId });
        }

        case NamidaMessageAction.CaptureFullScreen: {
            return tabs.captureVisibleTab(sender.tab?.windowId, { format: 'png' });
        }

        case NamidaMessageAction.UpscaleImage: {
            return Upscaler.upscaleImageWithAIFromBackground(namidaMessage.data as NamidaTensorflowUpscaleData);
        }

        case NamidaMessageAction.PreloadOcr: {
            return (async () => {
                if (await Settings.getOcrBackend() !== 'paddleonnx') return;
                const [ocrModel, paddleGpuEnabled] = await Promise.all([
                    Settings.getOcrModel(),
                    Settings.getPaddleOnnxGpuEnabled(),
                ]);
                if (globalThis.Worker) {
                    return BackgroundOcrService.init(ocrModel, { backend: 'paddleonnx', paddleGpuEnabled });
                }
                await ensureOffscreenDocument();
                return runtime.sendMessage({
                    action: NamidaMessageAction.PreloadOcrOffscreen,
                    data: {
                        ocrModel,
                        runtimeSettings: { ocrBackend: 'paddleonnx', paddleGpuEnabled },
                    } satisfies NamidaOcrPreloadData,
                });
            })();
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
                if (!await hasOffscreenDocument()) return null;
                return runtime.sendMessage({
                    action: retry ? NamidaMessageAction.RetryOcrGpuOffscreen : NamidaMessageAction.GetOcrAccelerationStatusOffscreen,
                });
            })();
        }
    }
});
