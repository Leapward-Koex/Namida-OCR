import { Settings } from "../interfaces/Storage";
import { SpeechSynthesisHandler } from "./SpeechHandler";
import { TTSWrapper } from "./TTSWrapper";

export class FloatingWindow {
    private static floatingMessageEl: HTMLDivElement | null = null;
    private static currentWindowId: number | undefined;
    private windowId: number | undefined;
    private windowFadeTimeout = 10000;
    private speechHandler = new SpeechSynthesisHandler("ja-JP");
    static floatingMessageTimer: number | undefined;

    constructor(text: string | undefined) {
        // Remove existing message if it's still visible
        if (FloatingWindow.floatingMessageEl) {
            FloatingWindow.floatingMessageEl.remove();
            FloatingWindow.floatingMessageEl = null;
            FloatingWindow.currentWindowId = undefined;
            if (FloatingWindow.floatingMessageTimer) {
                window.clearTimeout(FloatingWindow.floatingMessageTimer);
                FloatingWindow.floatingMessageTimer = undefined;
            }
        }

        // Create the main floating container
        const floatingDiv = document.createElement('div');
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

        // --- Header row (title + dismiss button) ---
        const headerRow = document.createElement('div');
        headerRow.style.display = 'flex';
        headerRow.style.justifyContent = 'space-between';
        headerRow.style.alignItems = 'center';

        // Title
        const titleEl = document.createElement('span');
        titleEl.style.fontWeight = 'bold';
        if (text) {
            titleEl.innerText = "Recognized text:";
        } else {
            titleEl.innerText = "Failed to recognize text, please try again.";
        }

        // Dismiss button (X)
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
            // Instantly remove the window (no fade needed)
            if (FloatingWindow.floatingMessageEl) {
                FloatingWindow.floatingMessageEl.remove();
                FloatingWindow.floatingMessageEl = null;
                FloatingWindow.currentWindowId = undefined;
            }
        });

        // Assemble header row
        headerRow.appendChild(titleEl);
        headerRow.appendChild(dismissButton);

        // --- Recognized text container ---
        const textContainer = document.createElement('div');
        textContainer.style.background = '#333';
        textContainer.style.borderRadius = '6px';
        textContainer.style.padding = '10px';
        textContainer.style.marginTop = '8px';
        textContainer.style.fontSize = '20px';
        textContainer.style.lineHeight = '1.4';

        const translationContainer = document.createElement('div');
        translationContainer.classList.add('translation-container');
        translationContainer.style.background = '#333';
        translationContainer.style.borderRadius = '6px';
        translationContainer.style.padding = '10px';
        translationContainer.style.marginTop = '8px';
        translationContainer.style.fontSize = '20px';
        translationContainer.style.lineHeight = '1.4';
        translationContainer.innerText = "Loading translation..."

        if (text) {
            textContainer.innerText = text;
        } else {
            textContainer.innerText = "";
        }

        // --- Button row (Speak, etc.) ---
        const buttonRow = document.createElement('div');
        buttonRow.style.display = 'flex';
        buttonRow.style.marginTop = '10px';

        // Speak button
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
            // Only speak if text is defined
            if (text) {
                if (TTSWrapper.isSpeaking()) {
                    TTSWrapper.cancel();
                    speakButton.innerText = 'Speak';
                }
                else {
                    this.speechHandler.speak(text).finally(() => {
                        speakButton.innerText = 'Speak';
                    });
                    speakButton.textContent = 'Speaking...'
                }
            }
        });

        buttonRow.appendChild(speakButton);

        floatingDiv.appendChild(headerRow);
        if (text) {
            floatingDiv.appendChild(textContainer);
            floatingDiv.appendChild(translationContainer);
        }

        Settings.getShowSpeakButton().then(async (showSpeakButton) => {
            const voice = await this.speechHandler.voiceForLanguage();
            const canSpeak = Boolean(text) && Boolean(voice);
            if (showSpeakButton && canSpeak) {
                floatingDiv.appendChild(buttonRow);
            }

            // Add floatingDiv to the DOM
            document.body.appendChild(floatingDiv);
            FloatingWindow.floatingMessageEl = floatingDiv;

            // Hover events to pause the fade timer
            floatingDiv.addEventListener('mouseenter', () => {
                if (FloatingWindow.floatingMessageTimer) {
                    window.clearTimeout(FloatingWindow.floatingMessageTimer);
                    FloatingWindow.floatingMessageTimer = undefined;
                }
            });

            floatingDiv.addEventListener('mouseleave', () => {
                this.startFadeTimer();
            });

            // Start fade timer
            this.windowId = Math.random();
            FloatingWindow.currentWindowId = this.windowId;
            this.startFadeTimer();
        });
    }

    private startFadeTimer() {
        // Clear any existing timer
        if (FloatingWindow.floatingMessageTimer) {
            window.clearTimeout(FloatingWindow.floatingMessageTimer);
        }

        FloatingWindow.floatingMessageTimer = window.setTimeout(() => {
            this.fadeOutMessage();
        }, this.windowFadeTimeout);
    }

    private fadeOutMessage() {
        if (!FloatingWindow.floatingMessageEl) return;

        // Fade out by setting opacity to 0
        FloatingWindow.floatingMessageEl.style.opacity = '0';

        // Remove after the transition finishes (0.4s)
        setTimeout(() => {
            if (FloatingWindow.floatingMessageEl) {
                FloatingWindow.floatingMessageEl.remove();
                FloatingWindow.floatingMessageEl = null;
                FloatingWindow.currentWindowId = undefined;
            }
        }, 400);
    }

    public fillInTranslation(text: string) {
        if (this.windowId === FloatingWindow.currentWindowId && FloatingWindow.floatingMessageEl) {
            if (text) {
                FloatingWindow.floatingMessageEl.querySelector<HTMLDivElement>('.translation-container')!.innerText = text;
            }
            else {
                FloatingWindow.floatingMessageEl.querySelector<HTMLDivElement>('.translation-container')!.innerText = "Failed to load translation";
            }
        }
    }
}
