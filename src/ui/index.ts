import { storage } from "webextension-polyfill";
import { Settings, StorageKey, UpscalingModeString } from "../interfaces/Storage";
import { SpeechSynthesisHandler } from "../content/SpeechHandler";
import { NamidaVoice, TTSWrapper } from "../content/TTSWrapper";

document.addEventListener('DOMContentLoaded', () => {
    const upscalingSelect = document.getElementById("upscaling-mode") as HTMLSelectElement;
    const pageSegSelect = document.getElementById("page-seg-mode") as HTMLSelectElement;
    const voiceSelect = document.getElementById("voice-selection") as HTMLSelectElement;
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

    voiceSelect.addEventListener("change", async () => {
        const preferredVoices = await Settings.getPreferredVoicesUri();
        const record: Record<string, unknown> = {};
        preferredVoices['ja-JP'.toLowerCase()] = voiceSelect.value;
        record[StorageKey.PreferredVoices] = preferredVoices;
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
        // The voices may not be loaded immediately, so also listen for updates.
        speechSynthesis.addEventListener("voiceschanged", () => {
            checkJapaneseVoice(speechStatus);
            // Also repopulate it when the voices change
            Settings.getPreferredVoiceId().then(async (preferredVoiceUri) => {
                const voices = await TTSWrapper.getVoices();
                populateVoiceSelection(voiceSelect, preferredVoiceUri, voices);
            });
        });
        checkJapaneseVoice(speechStatus);
        Settings.getPreferredVoiceId().then(async (preferredVoiceUri) => {
            const voices = await TTSWrapper.getVoices();
            populateVoiceSelection(voiceSelect, preferredVoiceUri, voices);
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
async function checkJapaneseVoice(speechStatus: HTMLElement) {
    const handler = new SpeechSynthesisHandler();
    const japaneseVoice = await handler.voiceForLanguage();

    if (japaneseVoice) {
        speechStatus.textContent = "A Japanese speech synthesis voice is available!";
    } else {
        speechStatus.textContent =
            "No Japanese voice is available. Please install a Japanese language pack to your system" +
            "and restart your browser.";
        document.querySelector<HTMLDivElement>('.voice-selection-container')!.hidden = true;

    }
}

function populateVoiceSelection(
    voiceSelect: HTMLSelectElement,
    userPreferredVoiceId: string | undefined,
    voices: NamidaVoice[],
    voiceLanguage: string = "ja-JP"
): void {
    // Clear existing options
    voiceSelect.innerHTML = '';
    const voicesForLanguage = voices.filter((voice) => voice.language.toLowerCase() === voiceLanguage.toLowerCase());
    // Populate the select element with available voices
    voicesForLanguage.forEach((voice) => {
        const option = document.createElement('option');
        option.textContent = `${voice.name}`;
        option.value = voice.id;

        if (userPreferredVoiceId && voice.id === userPreferredVoiceId) {
            option.selected = true;
        }

        voiceSelect.appendChild(option);
    });

    // If the preferred voice wasn't found in the available voices, select a default
    if (userPreferredVoiceId) {
        const isPreferredVoiceAvailable = voicesForLanguage.some((voice) => voice.id === userPreferredVoiceId);
        if (!isPreferredVoiceAvailable && voicesForLanguage.length > 0) {
            voiceSelect.selectedIndex = 0;
        }
    } else if (voicesForLanguage.length > 0) {
        // If no preferred voice is set, select the first available voice
        voiceSelect.selectedIndex = 0;
    }
}