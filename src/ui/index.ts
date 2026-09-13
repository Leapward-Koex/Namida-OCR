import { commands, runtime, storage, tabs } from "webextension-polyfill";
import {
    DEFAULT_OCR_BACKEND,
    DEFAULT_OCR_MODEL,
    DEFAULT_PADDLE_ONNX_GPU_ENABLED,
    FuriganaTypeString,
    Settings,
    StorageKey,
    type OcrBackendKind,
    TesseractTextDirectionString,
    UpscalingModeString,
} from "../interfaces/Storage";
import { SpeechSynthesisHandler } from "../content/SpeechHandler";
import { NamidaVoice, TTSWrapper } from "../content/TTSWrapper";
import { BrowserType, getCurrentBrowser, isWindows } from "../interfaces/browserInfo";
import { FuriganaType } from "../background/FuriganaHandler";
import { NamidaMessageAction } from "../interfaces/message";
import type { PaddleAccelerationStatus } from "../background/ocr/PaddleWorkerProtocol";
import { describePaddleAcceleration } from "./OcrAccelerationStatus";
import { initializeTranslationSettings } from "./TranslationSettings";

document.addEventListener('DOMContentLoaded', () => {
    initializeSettingsNavigation();
    initializeTranslationSettings();
    const manifest = runtime.getManifest();
    const buildVersion = document.getElementById('build-version');
    if (buildVersion) {
        buildVersion.textContent = manifest.version_name || manifest.version;
        buildVersion.title = `Extension version ${manifest.version}`;
    }
    const windowTimeoutSelect = document.getElementById("window-timeout") as HTMLSelectElement;
    const furiganaTypeSelect = document.getElementById("furigana-type") as HTMLSelectElement;
    const ocrBackendSelect = document.getElementById("ocr-backend") as HTMLSelectElement;
    const upscalingSelect = document.getElementById("upscaling-mode") as HTMLSelectElement;
    const tesseractTextDirectionSelect = document.getElementById("tesseract-text-direction") as HTMLSelectElement;
    const tesseractSettings = document.getElementById("tesseract-settings") as HTMLDivElement;
    const paddleSettings = document.getElementById("paddle-settings") as HTMLDivElement;
    const paddleGpuCheckbox = document.getElementById("enable-paddle-gpu") as HTMLInputElement;
    const paddleGpuStatus = document.getElementById("paddle-gpu-status") as HTMLParagraphElement;
    const paddleGpuDetails = document.getElementById("paddle-gpu-details") as HTMLDetailsElement;
    const paddleGpuDetailText = document.getElementById("paddle-gpu-detail-text") as HTMLParagraphElement;
    const retryPaddleGpu = document.getElementById("retry-paddle-gpu") as HTMLButtonElement;
    const voiceSelect = document.getElementById("voice-selection") as HTMLSelectElement;
    const saveOcrCropCheckbox = document.getElementById("save-ocr-crop") as HTMLInputElement;
    const showSpeakButtonCheckbox = document.getElementById("show-speak-button") as HTMLInputElement;
    const speechOptions = document.getElementById("speech-options") as HTMLDivElement;
    const speechStatus = document.getElementById("speech-status") as HTMLSpanElement;
    const speechDemoButton = document.getElementById("voice-demo-button") as HTMLButtonElement;
    const changeShortcut = document.getElementById("change-shortcut") as HTMLButtonElement;
    let statusRevision = 0;
    let voiceRevision = 0;

    function updateSpeechVisibility() {
        speechOptions.hidden = !showSpeakButtonCheckbox.checked;
    }

    async function refreshVoices() {
        const revision = ++voiceRevision;
        const voiceRow = document.querySelector<HTMLDivElement>('.voice-selection-container')!;
        try {
            const [preferredVoiceUri, voices] = await Promise.all([
                Settings.getPreferredVoiceId(),
                TTSWrapper.getVoices(),
            ]);
            if (revision !== voiceRevision) return;
            populateVoiceSelection(voiceSelect, preferredVoiceUri, voices);
            const hasVoice = voiceSelect.options.length > 0;
            voiceRow.hidden = !hasVoice;
            speechDemoButton.hidden = !hasVoice;
            speechDemoButton.disabled = !hasVoice;
            speechStatus.hidden = hasVoice;
            speechStatus.textContent = hasVoice ? '' : 'No Japanese voice. Install one and restart your browser.';
            if (!hasVoice && isWindows()) {
                const link = document.createElement('a');
                link.id = 'learn-install-pack';
                link.href = 'https://support.microsoft.com/en-us/windows/language-packs-for-windows-a5094319-a92d-18de-5b53-1cfc697cfca8';
                link.textContent = 'Windows voice setup';
                link.addEventListener('click', (event) => {
                    event.preventDefault();
                    tabs.create({ url: link.href });
                });
                speechStatus.append(' ', link);
            }
        } catch {
            if (revision !== voiceRevision) return;
            voiceRow.hidden = true;
            speechDemoButton.hidden = true;
            speechDemoButton.disabled = true;
            speechStatus.hidden = false;
            speechStatus.textContent = 'Could not load voices. Try reopening settings.';
        }
    }

    speechDemoButton.textContent = 'Preview voice';
    speechDemoButton.hidden = true;
    speechDemoButton.disabled = true;

    async function refreshPaddleStatus() {
        const revision = ++statusRevision;
        retryPaddleGpu.hidden = true;
        paddleGpuDetails.hidden = true;
        if (ocrBackendSelect.value !== 'paddleonnx') return;
        try {
            const status = await runtime.sendMessage({ action: NamidaMessageAction.GetOcrAccelerationStatus }) as PaddleAccelerationStatus | null;
            if (revision !== statusRevision) return;
            const description = describePaddleAcceleration(status ?? null, paddleGpuCheckbox.checked);
            paddleGpuStatus.textContent = description.text;
            paddleGpuStatus.title = description.detail;
            const adapter = status?.adapter;
            const adapterName = adapter && [adapter.description, adapter.vendor, adapter.architecture, adapter.device].filter(Boolean).join(' / ');
            const detail = [
                adapterName ? `Browser adapter: ${adapterName}.` : '',
                status?.provider === 'webgpu' ? 'WebGPU sessions may still use the CPU for some operations.' : '',
                description.detail,
            ].filter(Boolean).join(' ');
            paddleGpuDetailText.textContent = detail;
            paddleGpuDetails.hidden = !detail;
            retryPaddleGpu.hidden = !description.retryAvailable;
        } catch {
            if (revision === statusRevision) paddleGpuStatus.textContent = 'OCR status is temporarily unavailable.';
        }
    }

    loadSettings(
        windowTimeoutSelect,
        furiganaTypeSelect,
        ocrBackendSelect,
        upscalingSelect,
        tesseractTextDirectionSelect,
        paddleGpuCheckbox,
        saveOcrCropCheckbox,
        showSpeakButtonCheckbox,
    ).then(() => {
        updateBackendSettingsVisibility(ocrBackendSelect.value as OcrBackendKind, tesseractSettings, paddleSettings);
        updateSpeechVisibility();
        return refreshPaddleStatus();
    });

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

    ocrBackendSelect.addEventListener("change", async () => {
        const record: Record<string, unknown> = {};
        record[StorageKey.OcrBackend] = ocrBackendSelect.value;
        updateBackendSettingsVisibility(ocrBackendSelect.value as OcrBackendKind, tesseractSettings, paddleSettings);
        try {
            await storage.sync.set(record);
            await refreshPaddleStatus();
        } catch {
            paddleGpuStatus.textContent = 'Could not save the OCR backend preference.';
        }
    });

    upscalingSelect.addEventListener("change", () => {
        const record: Record<string, unknown> = {};
        record[StorageKey.UpscalingMode] = upscalingSelect.value;
        storage.sync.set(record);
    });

    tesseractTextDirectionSelect.addEventListener("change", () => {
        const record: Record<string, unknown> = {};
        record[StorageKey.OcrModel] = tesseractTextDirectionSelect.value === TesseractTextDirectionString.Horizontal
            ? 'jpn'
            : 'jpn_vert';
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

    paddleGpuCheckbox.addEventListener("change", async () => {
        const record: Record<string, unknown> = {};
        record[StorageKey.PaddleOnnxGpuEnabled] = paddleGpuCheckbox.checked;
        try {
            await storage.sync.set(record);
            await refreshPaddleStatus();
        } catch {
            paddleGpuStatus.textContent = 'Could not save the GPU preference.';
        }
    });

    retryPaddleGpu.addEventListener('click', async () => {
        retryPaddleGpu.disabled = true;
        ++statusRevision;
        paddleGpuStatus.textContent = 'Preparing a GPU retry…';
        try {
            await runtime.sendMessage({ action: NamidaMessageAction.RetryOcrGpu });
            await refreshPaddleStatus();
        } catch {
            paddleGpuStatus.textContent = 'Could not prepare a GPU retry. Try again after the current scan.';
        } finally {
            retryPaddleGpu.disabled = false;
        }
    });

    showSpeakButtonCheckbox.addEventListener("change", () => {
        updateSpeechVisibility();
        const record: Record<string, unknown> = {};
        record[StorageKey.ShowSpeakButton] = showSpeakButtonCheckbox.checked;
        storage.sync.set(record);
    });

    speechDemoButton.addEventListener("click", async () => {
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
        const shortcutHelp = document.getElementById('shortcut-help');
        const shortcutHelpText = document.getElementById('shortcut-help-text');
        if (shortcutHelp) shortcutHelp.hidden = false;
        if (shortcutHelpText) shortcutHelpText.textContent = 'Open about:addons → Extensions → gear menu → Manage Extension Shortcuts.';
    }

    commands.getAll().then((installedCommands) => {
        const snipCommand = installedCommands.find((installedCommand) => installedCommand.name == "toggle-feature");
        if (snipCommand && snipCommand.shortcut) {
            document.querySelector<HTMLSpanElement>('#shortcut-key')!.innerText = snipCommand.shortcut
        }
        else {
            document.getElementById('scan-instruction')!.textContent = 'Set a shortcut to start scanning.';
            changeShortcut.textContent = 'Set shortcut';
        }
    });

    // Browser voices can arrive after the popup has opened.
    speechSynthesis.addEventListener('voiceschanged', refreshVoices);
    refreshVoices();
});

function initializeSettingsNavigation(): void {
    const settingsTabs = ['reading-tab', 'recognition-tab']
        .map((id) => document.getElementById(id) as HTMLButtonElement | null)
        .filter((tab): tab is HTMLButtonElement => tab !== null);

    function activateTab(selected: HTMLButtonElement, focus = false) {
        for (const tab of settingsTabs) {
            const active = tab === selected;
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
            const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
            if (panel) panel.hidden = !active;
        }
        if (focus) selected.focus();
    }

    for (const [index, tab] of settingsTabs.entries()) {
        tab.addEventListener('click', () => activateTab(tab));
        tab.addEventListener('keydown', (event) => {
            let nextIndex: number;
            if (event.key === 'ArrowRight') nextIndex = (index + 1) % settingsTabs.length;
            else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + settingsTabs.length) % settingsTabs.length;
            else if (event.key === 'Home') nextIndex = 0;
            else if (event.key === 'End') nextIndex = settingsTabs.length - 1;
            else return;
            event.preventDefault();
            activateTab(settingsTabs[nextIndex], true);
        });
    }

    if (settingsTabs[0]) activateTab(settingsTabs[0]);
    window.addEventListener('hashchange', () => {
        if (window.location.hash === '#translation' && settingsTabs[0]) activateTab(settingsTabs[0]);
    });
}

async function loadSettings(
    windowTimeoutSelect: HTMLSelectElement,
    furiganaTypeSelect: HTMLSelectElement,
    ocrBackendSelect: HTMLSelectElement,
    upscalingSelect: HTMLSelectElement,
    tesseractTextDirectionSelect: HTMLSelectElement,
    paddleGpuCheckbox: HTMLInputElement,
    saveOcrCropCheckbox: HTMLInputElement,
    showSpeakButtonCheckbox: HTMLInputElement
) {
    const values = await storage.sync.get(null);

    furiganaTypeSelect.value =
        (values[StorageKey.FuriganaType] as string | undefined) || FuriganaTypeString.Hiragana;
    updateFuriganaExample(furiganaTypeSelect.value as FuriganaTypeString)
    windowTimeoutSelect.value =
        (values[StorageKey.WindowTimeout] as string | undefined) || "30000";
    ocrBackendSelect.value =
        normalizePopupBackend((values[StorageKey.OcrBackend] as string | undefined) ?? DEFAULT_OCR_BACKEND);
    upscalingSelect.value =
        (values[StorageKey.UpscalingMode] as string | undefined) || UpscalingModeString.Canvas;
    tesseractTextDirectionSelect.value = getTesseractTextDirectionFromModel(
        (values[StorageKey.OcrModel] as string | undefined) ?? DEFAULT_OCR_MODEL,
    );
    paddleGpuCheckbox.checked =
        (values[StorageKey.PaddleOnnxGpuEnabled] as boolean | undefined) ?? DEFAULT_PADDLE_ONNX_GPU_ENABLED;
    saveOcrCropCheckbox.checked =
        (values[StorageKey.SaveOcrCrop] as boolean | undefined) ?? false;
    showSpeakButtonCheckbox.checked =
        (values[StorageKey.ShowSpeakButton] as boolean | undefined) ?? true;
}

function normalizePopupBackend(backend: string | undefined): OcrBackendKind {
    if (backend === 'paddleonnx') {
        return backend;
    }

    return 'tesseract';
}

function getTesseractTextDirectionFromModel(model: string | undefined): TesseractTextDirectionString {
    return model?.trim() === 'jpn'
        ? TesseractTextDirectionString.Horizontal
        : TesseractTextDirectionString.Vertical;
}

function updateBackendSettingsVisibility(
    backend: OcrBackendKind,
    tesseractSettings: HTMLElement,
    paddleSettings: HTMLElement,
) {
    const isPaddleBackend = backend === 'paddleonnx';
    tesseractSettings.hidden = isPaddleBackend;
    paddleSettings.hidden = !isPaddleBackend;
    const description = document.getElementById('ocr-backend-description');
    if (description) description.textContent = isPaddleBackend
        ? 'Better for difficult text. Slower; GPU recommended.'
        : 'Fast scans. Match the text direction to your image.';
}

function populateVoiceSelection(
    voiceSelect: HTMLSelectElement,
    userPreferredVoiceId: string | undefined,
    voices: NamidaVoice[],
    voiceLanguage: string = "ja-JP"
): void {
    // Clear existing options
    voiceSelect.innerHTML = '';
    const voicesForLanguage = voices.filter((voice) => voice.language.toLowerCase().startsWith(voiceLanguage.toLowerCase()));
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
            furiganaExample.textContent = '日本語';
            break;
        case FuriganaTypeString.Hiragana:
            furiganaExample.innerHTML = '<ruby>日本語<rt>にほんご</rt></ruby>';
            break;
        case FuriganaTypeString.Katakana:
            furiganaExample.innerHTML = '<ruby>日本語<rt>ニホンゴ</rt></ruby>';
            break;
    }
}
