import { runtime, storage } from "webextension-polyfill";
import { Settings, StorageKey } from "../interfaces/Storage";
import { NamidaMessageAction } from "../interfaces/message";
import { isTranslationPlatformSupported } from "../translation/TranslatorApi";
import { TRANSLATION_LANGUAGES } from "../translation/TranslationLanguages";
import type { TranslationResult, TranslationStatus } from "../translation/TranslationTypes";
import { SpeechSynthesisHandler } from "./SpeechHandler";
import { TTSWrapper } from "./TTSWrapper";

type FloatingWindowConfig = {
    html: string | undefined;
    text: string | undefined;
};

type FloatingWindowState = {
    html?: string;
    loading?: boolean;
    text?: string;
    title: string;
};

export class FloatingWindow {
    private static floatingMessageEl: HTMLDivElement | null = null;
    private static floatingMessageTimer: number | undefined;
    private static titleEl: HTMLSpanElement | null = null;
    private static textContainerEl: HTMLDivElement | null = null;
    private static buttonRowEl: HTMLDivElement | null = null;
    private static speakButtonEl: HTMLButtonElement | null = null;
    private static japaneseCopyEl: HTMLButtonElement | null = null;
    private static translationEl: HTMLDivElement | null = null;
    private static translationTextEl: HTMLDivElement | null = null;
    private static translationStatusEl: HTMLParagraphElement | null = null;
    private static translationTitleEl: HTMLElement | null = null;
    private static translationActionEl: HTMLButtonElement | null = null;
    private static translationCopyEl: HTMLButtonElement | null = null;
    private static translationRevision = 0;
    private static translationRequestId: string | undefined;
    private static translationPending = false;
    private static translationEligible = false;
    private static translatedText = '';
    private static translationNeedsSetup = false;
    private static pointerInside = false;
    private static readonly onSettingsChanged: Parameters<typeof storage.onChanged.addListener>[0] = (changes, area) => {
        if (area === 'sync' && (StorageKey.TranslationEnabled in changes || StorageKey.TranslationTargetLanguage in changes)) {
            this.cancelTranslation();
            if (this.translationEligible) void this.startTranslation();
        }
    };
    private static isLoading = false;
    private static renderToken = 0;
    private static currentText: string | undefined;
    private static captureDepth = 0;
    private static captureVisibility = '';
    private static readonly speechHandler = new SpeechSynthesisHandler("ja-JP");

    constructor(config: FloatingWindowConfig) {
        FloatingWindow.showResult(config);
    }

    public static hideForCapture(): () => void {
        if (this.captureDepth++ === 0) this.captureVisibility = this.floatingMessageEl?.style.visibility ?? '';
        if (this.floatingMessageEl) this.floatingMessageEl.style.visibility = 'hidden';
        let restored = false;
        return () => {
            if (restored) return;
            restored = true;
            if (--this.captureDepth === 0 && this.floatingMessageEl) {
                this.floatingMessageEl.style.visibility = this.captureVisibility;
            }
        };
    }

    public static showStatus(message = "Scanning text...") {
        this.render({
            loading: true,
            text: message,
            title: "Scanning text...",
        });
    }

    public static showFailure(message?: string) {
        this.render({
            text: message,
            title: "Failed to recognize text, please try again.",
        });
    }

    public static showResult(config: FloatingWindowConfig) {
        this.render({
            html: config.html,
            text: config.text,
            title: config.text || config.html
                ? "Japanese"
                : "Failed to recognize text, please try again.",
        });
        this.translationEligible = Boolean(config.text?.trim());
        if (isTranslationPlatformSupported() && config.text?.trim()) void this.startTranslation();
    }

    /** Invalidate asynchronous work without removing the source text. */
    public static cancelTranslation(suspend = false) {
        if (suspend) this.translationEligible = false;
        ++this.translationRevision;
        if (this.translationRequestId) {
            void runtime.sendMessage({ action: NamidaMessageAction.CancelTranslation, data: { requestId: this.translationRequestId } }).catch(() => {});
        }
        this.translationRequestId = undefined;
        this.translationPending = false;
        this.translatedText = '';
        if (this.translationEl) this.translationEl.hidden = true;
        this.startFadeTimer();
    }

    private static async startTranslation() {
        const revision = ++this.translationRevision;
        const source = this.currentText;
        if (!this.translationEligible || !source?.trim() || !this.floatingMessageEl || !isTranslationPlatformSupported()) return;
        const isCurrent = () => revision === this.translationRevision && Boolean(this.floatingMessageEl) && source === this.currentText;
        let timeout: number | undefined;
        try {
            const settings = await Settings.getTranslationSettings();
            if (!isCurrent() || settings.enabled === false) return;
            const target = settings.targetLanguage;
            const requestId = crypto.randomUUID();
            this.translationRequestId = requestId;
            const deadline = new Promise<TranslationResult>(resolve => {
                timeout = window.setTimeout(() => {
                    void runtime.sendMessage({ action: NamidaMessageAction.CancelTranslation, data: { requestId } }).catch(() => {});
                    resolve({ ok: false, reason: 'timeout', message: 'Translation timed out. Try again.' });
                }, 60_000);
            });
            this.translationPending = true;
            this.clearFadeTimer();
            this.floatingMessageEl!.style.opacity = '1';
            if (settings.enabled === undefined) {
                // The default is conditional on browser readiness, never on a
                // saved download flag. A model that needs setup stays quiet.
                const readiness = await Promise.race([
                    runtime.sendMessage({ action: NamidaMessageAction.GetTranslationStatus, data: { targetLanguage: target } }) as Promise<TranslationStatus>,
                    deadline,
                ]);
                if (!isCurrent() || !('state' in readiness) || readiness.state !== 'available') return;
            }
            this.translationEl!.hidden = false;
            const language = TRANSLATION_LANGUAGES.find(language => language.code === target)?.label ?? target;
            this.translationTitleEl!.textContent = language;
            this.translationTextEl!.textContent = '';
            this.translationTextEl!.lang = target;
            this.translationStatusEl!.textContent = 'Translating…';
            this.translationActionEl!.hidden = true;
            this.translationCopyEl!.hidden = true;
            this.translationCopyEl!.textContent = `Copy ${language}`;
            const result = await Promise.race([
                runtime.sendMessage({ action: NamidaMessageAction.TranslateText, data: { requestId, text: source, targetLanguage: target } }) as Promise<TranslationResult>,
                deadline,
            ]);
            if (!isCurrent()) return;
            if (result?.ok) {
                this.translatedText = result.text;
                this.translationTextEl!.textContent = result.text;
                this.translationStatusEl!.textContent = result.text.trim() ? '' : 'No translation was returned.';
                this.translationCopyEl!.hidden = !result.text.trim();
            } else {
                this.translationNeedsSetup = !result || ['unsupported', 'unavailable', 'setup-required'].includes(result.reason);
                this.translationStatusEl!.textContent = result?.message || 'Translation is unavailable. Open settings to check setup.';
                this.translationActionEl!.textContent = this.translationNeedsSetup ? 'Open translation settings' : 'Retry translation';
                this.translationActionEl!.hidden = false;
            }
        } catch {
            if (!isCurrent() || !this.translationStatusEl) return;
            this.translationEl!.hidden = false;
            this.translationStatusEl.textContent = 'Could not translate this text. Try again.';
            this.translationNeedsSetup = false;
            this.translationActionEl!.textContent = 'Retry translation';
            this.translationActionEl!.hidden = false;
        } finally {
            if (timeout !== undefined) window.clearTimeout(timeout);
            if (isCurrent()) {
                this.translationRequestId = undefined;
                this.translationPending = false;
                this.startFadeTimer();
            }
        }
    }

    private static render(state: FloatingWindowState) {
        this.cancelTranslation();
        this.translationEligible = false;
        this.ensureWindow();
        this.renderToken += 1;
        const renderToken = this.renderToken;
        this.isLoading = Boolean(state.loading);
        this.currentText = state.loading ? undefined : state.text;
        this.clearFadeTimer();

        if (!this.floatingMessageEl || !this.titleEl || !this.textContainerEl || !this.buttonRowEl || !this.speakButtonEl) {
            return;
        }

        this.floatingMessageEl.style.opacity = '1';
        this.titleEl.innerText = state.title;

        const hasVisibleText = Boolean(state.loading || state.text || state.html);
        this.textContainerEl.hidden = !hasVisibleText;
        this.textContainerEl.style.fontStyle = state.loading ? 'italic' : 'normal';
        this.textContainerEl.style.padding = state.html ? '12px 0 4px' : '4px 0';
        this.textContainerEl.innerHTML = '';

        if (state.html) {
            this.textContainerEl.innerHTML = state.html;
        }
        else if (state.text) {
            this.textContainerEl.innerText = state.text;
        }

        if (state.loading) {
            this.textContainerEl.removeAttribute('data-testid');
        }
        else {
            this.textContainerEl.setAttribute('data-testid', 'namida-floating-window-text');
        }

        this.buttonRowEl.style.display = !state.loading && state.text ? 'flex' : 'none';
        if (this.japaneseCopyEl) this.japaneseCopyEl.textContent = 'Copy Japanese';
        this.speakButtonEl.hidden = true;
        this.speakButtonEl.innerText = 'Speak';

        if (!state.loading) {
            this.startFadeTimer();
        }

        if (!state.loading && state.text) {
            Settings.getShowSpeakButton().then(async (showSpeakButton) => {
                const voice = await this.speechHandler.voiceForLanguage();

                if (
                    renderToken !== this.renderToken
                    || !this.floatingMessageEl
                    || !this.buttonRowEl
                ) {
                    return;
                }

                const canSpeak = Boolean(state.text) && Boolean(voice);
                this.speakButtonEl!.hidden = !(showSpeakButton && canSpeak);
            });
        }
    }

    private static ensureWindow() {
        if (this.floatingMessageEl) {
            return;
        }

        const floatingDiv = document.createElement('div');
        floatingDiv.setAttribute('data-testid', 'namida-floating-window');
        floatingDiv.style.position = 'fixed';
        floatingDiv.style.right = '20px';
        floatingDiv.style.bottom = '20px';
        floatingDiv.style.background = 'rgba(28, 32, 38, 0.97)';
        floatingDiv.style.color = '#fff';
        floatingDiv.style.padding = '12px 16px';
        floatingDiv.style.borderRadius = '8px';
        floatingDiv.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
        floatingDiv.style.zIndex = '999999';
        floatingDiv.style.fontFamily = '"Segoe UI", system-ui, sans-serif';
        floatingDiv.style.fontSize = '14px';
        floatingDiv.style.opacity = '1';
        floatingDiv.style.transition = 'opacity 0.4s ease';
        floatingDiv.style.maxWidth = 'min(640px, calc(100vw - 40px))';
        floatingDiv.style.maxHeight = 'calc(100vh - 40px)';
        floatingDiv.style.overflow = 'auto';
        floatingDiv.style.overflowWrap = 'anywhere';
        floatingDiv.style.boxSizing = 'border-box';

        const headerRow = document.createElement('div');
        headerRow.style.display = 'flex';
        headerRow.style.justifyContent = 'space-between';
        headerRow.style.alignItems = 'center';
        headerRow.style.gap = '8px';
        headerRow.setAttribute('data-testid', 'namida-japanese-actions');

        const titleEl = document.createElement('span');
        titleEl.style.fontWeight = 'bold';
        titleEl.style.fontSize = '14px';
        titleEl.style.marginRight = 'auto';

        const dismissButton = document.createElement('button');
        dismissButton.innerText = '×';
        dismissButton.setAttribute('aria-label', 'Dismiss OCR result');
        dismissButton.style.background = 'transparent';
        dismissButton.style.color = '#fff';
        dismissButton.style.border = 'none';
        dismissButton.style.cursor = 'pointer';
        dismissButton.style.fontSize = '22px';
        dismissButton.style.fontWeight = 'bold';
        dismissButton.style.marginLeft = '10px';
        dismissButton.addEventListener('click', () => {
            this.removeWindow();
        });

        headerRow.appendChild(titleEl);
        headerRow.appendChild(dismissButton);

        const textContainer = document.createElement('div');
        textContainer.style.background = 'transparent';
        textContainer.style.borderRadius = '6px';
        textContainer.style.marginTop = '8px';
        textContainer.style.fontSize = '24px';
        textContainer.style.lineHeight = '1.7';
        textContainer.style.whiteSpace = 'pre-wrap';
        textContainer.lang = 'ja';

        const buttonRow = document.createElement('div');
        buttonRow.style.display = 'none';
        buttonRow.style.gap = '6px';
        const copyJapanese = document.createElement('button');
        copyJapanese.type = 'button';
        copyJapanese.textContent = 'Copy Japanese';
        copyJapanese.setAttribute('data-testid', 'namida-copy-japanese');
        copyJapanese.addEventListener('click', () => {
            const text = this.currentText;
            const token = this.renderToken;
            if (!text) return;
            void navigator.clipboard.writeText(text).then(() => {
                if (token === this.renderToken) copyJapanese.textContent = 'Japanese copied';
            }).catch(() => {
                if (token === this.renderToken) copyJapanese.textContent = 'Copy failed — retry';
            });
        });

        const speakButton = document.createElement('button');
        speakButton.innerText = 'Speak';
        speakButton.style.background = '#1976d2';
        speakButton.style.color = '#fff';
        speakButton.style.border = 'none';
        speakButton.style.borderRadius = '4px';
        speakButton.style.padding = '6px 12px';
        speakButton.style.cursor = 'pointer';
        speakButton.style.fontSize = '20px';
        speakButton.style.marginRight = '6px';
        for (const button of [copyJapanese, speakButton]) {
            button.style.cssText = 'background:#39434f;color:#fff;border:1px solid #556170;border-radius:5px;padding:4px 8px;font:12px "Segoe UI",sans-serif;cursor:pointer';
        }
        speakButton.type = 'button';
        speakButton.setAttribute('aria-label', 'Speak Japanese');
        speakButton.addEventListener('click', () => {
            const text = this.currentText;
            if (!text) {
                return;
            }

            if (TTSWrapper.isSpeaking()) {
                TTSWrapper.cancel();
                speakButton.innerText = 'Speak';
                return;
            }

            this.speechHandler.speak(text).finally(() => {
                if (this.speakButtonEl) {
                    this.speakButtonEl.innerText = 'Speak';
                }
            });
            speakButton.textContent = 'Speaking...';
        });

        buttonRow.appendChild(copyJapanese);
        buttonRow.appendChild(speakButton);
        headerRow.appendChild(buttonRow);
        headerRow.appendChild(dismissButton);
        floatingDiv.appendChild(headerRow);
        floatingDiv.appendChild(textContainer);
        if (isTranslationPlatformSupported()) {
            const translation = document.createElement('div');
            translation.hidden = true;
            translation.setAttribute('data-testid', 'namida-translation');
            translation.style.cssText = 'margin-top:10px;border-top:1px solid #556170;padding-top:10px;font-size:18px;line-height:1.5';
            const translationHeader = document.createElement('div');
            translationHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;font-size:14px';
            translationHeader.setAttribute('data-testid', 'namida-translation-actions');
            const title = document.createElement('strong');
            const translatedText = document.createElement('div');
            translatedText.setAttribute('data-testid', 'namida-translation-text');
            translatedText.setAttribute('dir', 'auto');
            translatedText.style.whiteSpace = 'pre-wrap';
            const status = document.createElement('p');
            status.setAttribute('role', 'status');
            status.style.fontSize = '16px';
            status.style.margin = '0';
            const copy = document.createElement('button');
            copy.textContent = 'Copy translation';
            copy.hidden = true;
            copy.setAttribute('data-testid', 'namida-copy-translation');
            copy.addEventListener('click', () => {
                const text = this.translatedText;
                const revision = this.translationRevision;
                if (!text) return;
                void navigator.clipboard.writeText(text).then(() => {
                    if (revision === this.translationRevision) copy.textContent = `${title.textContent} copied`;
                }).catch(() => {
                    if (revision === this.translationRevision) status.textContent = 'Could not copy translation. Select and copy the text manually.';
                });
            });
            const action = document.createElement('button');
            action.hidden = true;
            action.addEventListener('click', () => {
                if (this.translationNeedsSetup) {
                    void runtime.sendMessage({ action: NamidaMessageAction.OpenTranslationSettings }).catch(() => {
                        status.textContent = 'Open Namida settings from the extension toolbar to set up translation.';
                    });
                } else {
                    this.cancelTranslation();
                    void this.startTranslation();
                }
            });
            for (const button of [copy, action]) {
                button.style.cssText = 'background:#39434f;color:#fff;border:1px solid #556170;border-radius:5px;padding:4px 8px;font:12px "Segoe UI",sans-serif;cursor:pointer';
                button.type = 'button';
            }
            translationHeader.appendChild(title);
            translationHeader.appendChild(copy);
            for (const child of [translationHeader, translatedText, status, action]) translation.appendChild(child);
            floatingDiv.appendChild(translation);
            this.translationEl = translation;
            this.translationTitleEl = title;
            this.translationTextEl = translatedText;
            this.translationStatusEl = status;
            this.translationCopyEl = copy;
            this.translationActionEl = action;
            storage.onChanged.addListener(this.onSettingsChanged);
        }
        document.body.appendChild(floatingDiv);

        floatingDiv.addEventListener('mouseenter', () => {
            this.pointerInside = true;
            this.clearFadeTimer();
        });

        floatingDiv.addEventListener('mouseleave', () => {
            this.pointerInside = false;
            this.startFadeTimer();
        });

        this.floatingMessageEl = floatingDiv;
        if (this.captureDepth > 0) floatingDiv.style.visibility = 'hidden';
        this.titleEl = titleEl;
        this.textContainerEl = textContainer;
        this.buttonRowEl = buttonRow;
        this.speakButtonEl = speakButton;
        this.japaneseCopyEl = copyJapanese;
    }

    private static startFadeTimer() {
        if (!this.floatingMessageEl || this.isLoading || this.translationPending || this.pointerInside) {
            return;
        }

        const revision = this.renderToken;
        Settings.getWindowTimeout().then((windowTimeout) => {
            if (revision !== this.renderToken || !this.floatingMessageEl || this.isLoading || this.translationPending || this.pointerInside) {
                return;
            }

            this.clearFadeTimer();

            if (windowTimeout !== -1) {
                this.floatingMessageTimer = window.setTimeout(() => {
                    this.fadeOutMessage();
                }, windowTimeout);
            }
        }).catch(() => {});
    }

    private static clearFadeTimer() {
        if (this.floatingMessageTimer) {
            window.clearTimeout(this.floatingMessageTimer);
            this.floatingMessageTimer = undefined;
        }
    }

    private static fadeOutMessage() {
        if (!this.floatingMessageEl) {
            return;
        }

        this.floatingMessageEl.style.opacity = '0';

        window.setTimeout(() => {
            if (this.floatingMessageEl?.style.opacity === '0') {
                this.removeWindow();
            }
        }, 400);
    }

    private static removeWindow() {
        this.cancelTranslation(true);
        ++this.renderToken;
        this.clearFadeTimer();
        if (isTranslationPlatformSupported()) storage.onChanged.removeListener(this.onSettingsChanged);

        if (this.floatingMessageEl) {
            this.floatingMessageEl.remove();
        }

        this.floatingMessageEl = null;
        this.titleEl = null;
        this.textContainerEl = null;
        this.buttonRowEl = null;
        this.speakButtonEl = null;
        this.japaneseCopyEl = null;
        this.translationEl = null;
        this.translationTextEl = null;
        this.translationTitleEl = null;
        this.translationStatusEl = null;
        this.translationCopyEl = null;
        this.translationActionEl = null;
        this.pointerInside = false;
        this.isLoading = false;
        this.currentText = undefined;
    }
}
