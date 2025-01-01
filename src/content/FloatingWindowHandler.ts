import { SpeechSynthesisHandler } from "./SpeechHandler";

export class FloatingWindow {
    private static floatingMessageEl: HTMLDivElement | null = null;
    private floatingMessageTimer: number | null = null;
    private windowFadeTimeout = 1000000;
    private speechHandler = new SpeechSynthesisHandler("ja-JP");

    constructor(text: string | undefined) {
        // Remove existing message if it's still visible
        if (FloatingWindow.floatingMessageEl) {
            FloatingWindow.floatingMessageEl.remove();
            FloatingWindow.floatingMessageEl = null;
            if (this.floatingMessageTimer) {
                window.clearTimeout(this.floatingMessageTimer);
                this.floatingMessageTimer = null;
            }
        }

        // Create a new floating div
        const floatingDiv = document.createElement('div');
        if (text) {
            floatingDiv.innerText = `Copied: ${text}`;
        }
        else {
            floatingDiv.innerText = `Failed to recognize text, please try again.`;
        }
        floatingDiv.style.position = 'fixed';
        floatingDiv.style.right = '20px';
        floatingDiv.style.bottom = '20px';
        floatingDiv.style.background = 'rgba(0, 0, 0, 0.85)';
        floatingDiv.style.color = '#fff';
        floatingDiv.style.padding = '10px 15px';
        floatingDiv.style.borderRadius = '8px';
        floatingDiv.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
        floatingDiv.style.zIndex = '999999';
        floatingDiv.style.fontSize = '24px';
        floatingDiv.style.opacity = '1';
        floatingDiv.style.transition = 'opacity 0.4s ease';


        // Create the speech button
        const speakButton = document.createElement('button');
        speakButton.innerText = 'Speak';
        speakButton.style.marginLeft = '10px';
        speakButton.style.background = '#4CAF50';
        speakButton.style.color = '#fff';
        speakButton.style.border = 'none';
        speakButton.style.borderRadius = '4px';
        speakButton.style.padding = '5px 10px';
        speakButton.style.cursor = 'pointer';

        // When the user clicks, speak the text
        speakButton.addEventListener('click', () => {
            this.speechHandler.speak(text!);
        });

        if (text && !!this.speechHandler.voiceForLanguage()) {
            // Append button to the floating div
            floatingDiv.appendChild(speakButton);
        }

        // Add it to the DOM
        document.body.appendChild(floatingDiv);
        FloatingWindow.floatingMessageEl = floatingDiv;

        // Set up event handlers to pause timer if hovered
        floatingDiv.addEventListener('mouseenter', () => {
            if (this.floatingMessageTimer) {
                window.clearTimeout(this.floatingMessageTimer);
                this.floatingMessageTimer = null;
            }
        });

        floatingDiv.addEventListener('mouseleave', () => {
            this.startFadeTimer();
        });

        // Start the fade timer
        this.startFadeTimer();
    }

    private startFadeTimer() {
        // Clear any existing timer
        if (this.floatingMessageTimer) {
            window.clearTimeout(this.floatingMessageTimer);
        }

        this.floatingMessageTimer = window.setTimeout(() => {
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
            }
        }, 400);
    }
}