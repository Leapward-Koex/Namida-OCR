import { Settings } from "../interfaces/Storage";
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
    private static isLoading = false;
    private static renderToken = 0;
    private static currentText: string | undefined;
    private static readonly speechHandler = new SpeechSynthesisHandler("ja-JP");

    constructor(config: FloatingWindowConfig) {
        FloatingWindow.showResult(config);
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
                ? "Recognized text:"
                : "Failed to recognize text, please try again.",
        });
    }

    private static render(state: FloatingWindowState) {
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
        this.textContainerEl.style.padding = state.html ? '20px' : '10px';
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

        this.buttonRowEl.style.display = 'none';
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
                this.buttonRowEl.style.display = showSpeakButton && canSpeak ? 'flex' : 'none';
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
        floatingDiv.style.background = 'rgba(0, 0, 0, 0.85)';
        floatingDiv.style.color = '#fff';
        floatingDiv.style.padding = '12px 16px';
        floatingDiv.style.borderRadius = '8px';
        floatingDiv.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
        floatingDiv.style.zIndex = '999999';
        floatingDiv.style.fontSize = '24px';
        floatingDiv.style.opacity = '1';
        floatingDiv.style.transition = 'opacity 0.4s ease';

        const headerRow = document.createElement('div');
        headerRow.style.display = 'flex';
        headerRow.style.justifyContent = 'space-between';
        headerRow.style.alignItems = 'center';

        const titleEl = document.createElement('span');
        titleEl.style.fontWeight = 'bold';

        const dismissButton = document.createElement('button');
        dismissButton.innerText = '×';
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
        textContainer.style.background = '#333';
        textContainer.style.borderRadius = '6px';
        textContainer.style.marginTop = '8px';
        textContainer.style.fontSize = '28px';
        textContainer.style.lineHeight = '1.4';

        const buttonRow = document.createElement('div');
        buttonRow.style.display = 'none';
        buttonRow.style.marginTop = '10px';

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

        buttonRow.appendChild(speakButton);
        floatingDiv.appendChild(headerRow);
        floatingDiv.appendChild(textContainer);
        floatingDiv.appendChild(buttonRow);
        document.body.appendChild(floatingDiv);

        floatingDiv.addEventListener('mouseenter', () => {
            this.clearFadeTimer();
        });

        floatingDiv.addEventListener('mouseleave', () => {
            this.startFadeTimer();
        });

        this.floatingMessageEl = floatingDiv;
        this.titleEl = titleEl;
        this.textContainerEl = textContainer;
        this.buttonRowEl = buttonRow;
        this.speakButtonEl = speakButton;
    }

    private static startFadeTimer() {
        if (!this.floatingMessageEl || this.isLoading) {
            return;
        }

        Settings.getWindowTimeout().then((windowTimeout) => {
            if (!this.floatingMessageEl || this.isLoading) {
                return;
            }

            this.clearFadeTimer();

            if (windowTimeout !== -1) {
                this.floatingMessageTimer = window.setTimeout(() => {
                    this.fadeOutMessage();
                }, windowTimeout);
            }
        });
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
        this.clearFadeTimer();

        if (this.floatingMessageEl) {
            this.floatingMessageEl.remove();
        }

        this.floatingMessageEl = null;
        this.titleEl = null;
        this.textContainerEl = null;
        this.buttonRowEl = null;
        this.speakButtonEl = null;
        this.isLoading = false;
        this.currentText = undefined;
    }
}
