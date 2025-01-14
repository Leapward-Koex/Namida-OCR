import { commands, runtime, storage, tabs } from "webextension-polyfill";
import { FuriganaTypeString, Settings, StorageKey, UpscalingModeString } from "../interfaces/Storage";
import { SpeechSynthesisHandler } from "../content/SpeechHandler";
import { NamidaVoice, TTSWrapper } from "../content/TTSWrapper";
import { BrowserType, getCurrentBrowser, isWindows } from "../interfaces/browserInfo";
import { FuriganaType } from "../background/FuriganaHandler";

document.addEventListener('DOMContentLoaded', () => {
    const windowTimeoutSelect = document.getElementById("window-timeout") as HTMLSelectElement;
    const furiganaTypeSelect = document.getElementById("furigana-type") as HTMLSelectElement;
    const upscalingSelect = document.getElementById("upscaling-mode") as HTMLSelectElement;
    const pageSegSelect = document.getElementById("page-seg-mode") as HTMLSelectElement;
    const voiceSelect = document.getElementById("voice-selection") as HTMLSelectElement;
    const saveOcrCropCheckbox = document.getElementById("save-ocr-crop") as HTMLInputElement;
    const showSpeakButtonCheckbox = document.getElementById("show-speak-button") as HTMLInputElement;
    const speechStatus = document.getElementById("speech-status") as HTMLSpanElement;
    const speakeDemoButton = document.getElementById("voice-demo-button") as HTMLButtonElement;
    const changeShortcut = document.getElementById("change-shortcut") as HTMLButtonElement;

    loadSettings(windowTimeoutSelect, furiganaTypeSelect, upscalingSelect, pageSegSelect, saveOcrCropCheckbox, showSpeakButtonCheckbox);

    // Attach listeners to save new values
    furiganaTypeSelect.addEventListener("change", () => {
        const record: Record<string, unknown> = {};
        record[StorageKey.FuriganaType] = furiganaTypeSelect.value;
        updateFuriganaExample(furiganaTypeSelect.value as FuriganaTypeString)
        storage.sync.set(record);
    });

    windowTimeoutSelect.addEventListener("change", () => {
        const record: Record<string, unknown> = {};
        record[StorageKey.WindowTimeout] = windowTimeoutSelect.value;
        storage.sync.set(record);
    });

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

    speakeDemoButton.addEventListener("click", async () => {
        const speechHandler = new SpeechSynthesisHandler();
        speechHandler.speak("こんにちは、NAMIDA OCRです。");
    });

    const browserType = getCurrentBrowser();
    changeShortcut.addEventListener("click", async () => {
        if (browserType == BrowserType.Chrome) {
            tabs.create({ url: 'chrome://extensions/shortcuts' });
        }
        else if (browserType == BrowserType.Edge) {
            tabs.create({ url: 'edge://extensions/shortcuts' });
        }
    });

    if (browserType == BrowserType.Firefox) {
        changeShortcut.hidden = true;
        const firefoxExplanation = document.createElement('p');
        firefoxExplanation.innerText = "To change the shortcut key combination, go to url 'about:addons' → click 'Extensions' → click the cog icon → click 'Manage Extension Shortcuts'.";
        changeShortcut.parentElement?.insertBefore(firefoxExplanation, changeShortcut.nextElementSibling);
    }

    commands.getAll().then((installedCommands) => {
        const snipCommand = installedCommands.find((installedCommand) => installedCommand.name == "toggle-feature");
        if (snipCommand && snipCommand.shortcut) {
            document.querySelector<HTMLSpanElement>('#shortcut-key')!.innerText = snipCommand.shortcut
        }
        else {
            document.querySelector<HTMLSpanElement>('#shortcut-key')!.innerText = "<no shortcut setup>"
        }
    });

    // Check for Japanese speech synthesis voice
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
});

async function loadSettings(
    windowTimeoutSelect: HTMLSelectElement,
    furiganaTypeSelect: HTMLSelectElement,
    upscalingSelect: HTMLSelectElement,
    pageSegSelect: HTMLSelectElement,
    saveOcrCropCheckbox: HTMLInputElement,
    showSpeakButtonCheckbox: HTMLInputElement
) {
    const values = await storage.sync.get(null);

    furiganaTypeSelect.value =
        (values[StorageKey.FuriganaType] as string | undefined) || FuriganaTypeString.Hiragana;
    updateFuriganaExample(furiganaTypeSelect.value as FuriganaTypeString)
    windowTimeoutSelect.value =
        (values[StorageKey.WindowTimeout] as string | undefined) || "30000";
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
        speechStatus.innerHTML =
            "No Japanese voice is available. Please install a Japanese language pack to your system" +
            "and restart your browser.";

        if (isWindows()) {
            speechStatus.innerHTML += " Click <a id=\"learn-install-pack\" href=\"https://support.microsoft.com/en-us/windows/language-packs-for-windows-a5094319-a92d-18de-5b53-1cfc697cfca8\">here</a> to learn how to install a language pack";
            speechStatus.querySelector('#learn-install-pack')?.addEventListener('click', () => {
                tabs.create({ url: "https://support.microsoft.com/en-us/windows/language-packs-for-windows-a5094319-a92d-18de-5b53-1cfc697cfca8" });
            });
        }
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

function updateFuriganaExample(furiganaType: FuriganaTypeString) {
    const furiganaExample = document.getElementById("furigana-example") as HTMLSpanElement;
    switch (furiganaType) {
        case FuriganaTypeString.None:
            furiganaExample.innerHTML = "<ruby>日本語</ruby>";
            break;
        case FuriganaTypeString.Hiragana:
            furiganaExample.innerHTML = "<ruby>日<rt>に</rt></ruby><ruby>本<rt>ほん</rt></ruby><ruby>語<rt>ご</rt></ruby></ruby>";
            break;
        case FuriganaTypeString.Katakana:
            furiganaExample.innerHTML = "<ruby>日<rt>ニ</rt></ruby><ruby>本<rt>ホン</rt></ruby><ruby>語<rt>ゴ</rt></ruby></ruby>";
            break;
    }
}