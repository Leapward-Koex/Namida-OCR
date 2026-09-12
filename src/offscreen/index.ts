import { runtime } from "webextension-polyfill";
import { NamidaMessage, NamidaMessageAction, NamidaOcrFromOffscreenMessage, type NamidaOcrFromOffscreenResult, type NamidaOcrPreloadData } from "../interfaces/message";
import { FuriganaHandler } from "../background/FuriganaHandler";
import { OcrService } from "../background/ocr/OcrService";

console.debug("Loading offscreen document");

runtime.onMessage.addListener((message) => {
    const namidaMessage = message as NamidaMessage;
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
