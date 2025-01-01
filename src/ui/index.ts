import { storage } from "webextension-polyfill";
import { StorageKey, UpscalingModeString } from "../interfaces/Storage";
import { SpeechSynthesisHandler } from "../content/SpeechHandler";

document.addEventListener('DOMContentLoaded', () => {
    const upscalingSelect = document.getElementById("upscaling-mode") as HTMLSelectElement;
    const pageSegSelect = document.getElementById("page-seg-mode") as HTMLSelectElement;
    const saveOcrCropCheckbox = document.getElementById("save-ocr-crop") as HTMLInputElement;
    const showSpeakButtonCheckbox = document.getElementById("show-speak-button") as HTMLInputElement;
    const speechStatus = document.getElementById("speech-status") as HTMLElement | null;

    loadSettings(upscalingSelect, pageSegSelect, saveOcrCropCheckbox, showSpeakButtonCheckbox);

    // Attach listeners to save new values
    upscalingSelect.addEventListener("change", () => {
        const record: Record<string, unknown> = {};
        record[StorageKey.UpscalingMode] = upscalingSelect.value;
        storage.sync.set(record);
    });

    pageSegSelect.addEventListener("change", () => {
        const record: Record<string, unknown> = {};
        record[StorageKey.PageSegMode] = pageSegSelect.value;
        storage.sync.set(record);
    });

    saveOcrCropCheckbox.addEventListener("change", () => {
        const record: Record<string, unknown> = {};
        record[StorageKey.SaveOcrCrop] = saveOcrCropCheckbox.checked;
        storage.sync.set(record);
    });

    showSpeakButtonCheckbox.addEventListener("change", () => {
        const record: Record<string, unknown> = {};
        record[StorageKey.ShowSpeakButton] = showSpeakButtonCheckbox.checked;
        storage.sync.set(record);
    });

    // Check for Japanese speech synthesis voice
    if (speechStatus) {
        checkJapaneseVoice(speechStatus);

        // The voices may not be loaded immediately, so also listen for updates.
        speechSynthesis.addEventListener("voiceschanged", () => {
            checkJapaneseVoice(speechStatus);
        });
    }
});

async function loadSettings(
    upscalingSelect: HTMLSelectElement,
    pageSegSelect: HTMLSelectElement,
    saveOcrCropCheckbox: HTMLInputElement,
    showSpeakButtonCheckbox: HTMLInputElement
) {
    const values = await storage.sync.get(null);

    // If a value was saved before, use it. Otherwise use default.
    upscalingSelect.value =
        (values[StorageKey.UpscalingMode] as string | undefined) || UpscalingModeString.Canvas;
    pageSegSelect.value =
        (values[StorageKey.PageSegMode] as string | undefined) || "single-block-vertical";
    saveOcrCropCheckbox.checked =
        (values[StorageKey.SaveOcrCrop] as boolean | undefined) ?? false;
    showSpeakButtonCheckbox.checked =
        (values[StorageKey.ShowSpeakButton] as boolean | undefined) ?? true;
}

/**
 * Check if there's at least one Japanese (ja) voice available in speech synthesis
 * and update the UI with the appropriate message.
 */
function checkJapaneseVoice(speechStatus: HTMLElement) {
    const handler = new SpeechSynthesisHandler();
    const japaneseVoice = handler.voiceForLanguage();

    if (japaneseVoice) {
        speechStatus.textContent = "A Japanese speech synthesis voice is available!";
    } else {
        speechStatus.textContent =
            "No Japanese voice is available. Please install a Japanese language pack " +
            "and restart your browser.";
    }
}
