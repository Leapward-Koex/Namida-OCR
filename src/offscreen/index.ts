import { runtime } from "webextension-polyfill";
import { NamidaMessage, NamidaMessageAction, NamidaOcrFromOffscreenMessage, type NamidaOcrFromOffscreenResult, type NamidaOcrPreloadData } from "../interfaces/message";
import { FuriganaHandler } from "../background/FuriganaHandler";
import { OcrService } from "../background/ocr/OcrService";
import { TranslationService } from '../translation/TranslationService';
import type { TranslationCancelRequest, TranslationRequest, TranslationStatusRequest } from '../translation/TranslationTypes';

console.debug("Loading offscreen document");

const translationService = __NAMIDA_TRANSLATION_ENABLED__ ? new TranslationService() : null;

runtime.onMessage.addListener((message) => {
    const namidaMessage = message as NamidaMessage;
    if (translationService) {
        if (namidaMessage.action === NamidaMessageAction.GetTranslationStatusOffscreen) {
            return translationService.getStatus((namidaMessage.data as TranslationStatusRequest).targetLanguage);
        }
        if (namidaMessage.action === NamidaMessageAction.TranslateTextOffscreen) {
            return translationService.translate(namidaMessage.data as TranslationRequest);
        }
        if (namidaMessage.action === NamidaMessageAction.CancelTranslationOffscreen) {
            translationService.cancel((namidaMessage.data as TranslationCancelRequest).requestId);
            return Promise.resolve();
        }
        if (namidaMessage.action === NamidaMessageAction.ResetTranslationOffscreen) {
            translationService.reset();
            return Promise.resolve();
        }
    }
    if (namidaMessage.action === NamidaMessageAction.PreloadOcrOffscreen) {
        const data = namidaMessage.data as NamidaOcrPreloadData;
        return OcrService.init(data.ocrModel, {
            backend: data.runtimeSettings.ocrBackend,
            paddleGpuEnabled: data.runtimeSettings.paddleGpuEnabled,
        });
    }
    if (namidaMessage.action === NamidaMessageAction.RecognizeImageOffscreen) {
        const namidaOcrMessage = message as NamidaOcrFromOffscreenMessage;
        const runtimeSettings = {
            backend: namidaOcrMessage.data.runtimeSettings.ocrBackend,
            paddleGpuEnabled: namidaOcrMessage.data.runtimeSettings.paddleGpuEnabled,
        } as const;

        return OcrService.recognizeWithDebug(
            namidaOcrMessage.data.imageData,
            namidaOcrMessage.data.pageSegMode,
            namidaOcrMessage.data.ocrModel,
            runtimeSettings,
            namidaOcrMessage.data.debugArtifactsEnabled,
        ) satisfies Promise<NamidaOcrFromOffscreenResult>;
    }
    if (namidaMessage.action === NamidaMessageAction.GetLastOcrDebugSnapshotOffscreen) {
        return OcrService.getLastDebugSnapshot();
    }
    if (namidaMessage.action === NamidaMessageAction.GetOcrAccelerationStatusOffscreen) {
        return OcrService.getAccelerationStatus();
    }
    if (namidaMessage.action === NamidaMessageAction.RetryOcrGpuOffscreen) {
        return OcrService.retryGpu().then(() => OcrService.getAccelerationStatus());
    }
    if (namidaMessage.action === NamidaMessageAction.GenerateFuriganaOffscreen) {
        return FuriganaHandler.generateFurigana(namidaMessage.data);
    }
});
