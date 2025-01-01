export interface NamidaVoice {
    id: string,
    name: string,
    language: string,
}

export class TTSWrapper {
    private static logTag = `[${TTSWrapper.name}]`;
    private static voices = window.speechSynthesis.getVoices();
    static _initialize() {
        window.speechSynthesis.addEventListener("voiceschanged", () => {
            this.voices = window.speechSynthesis.getVoices();
        });
    }

    public static async getVoices(): Promise<NamidaVoice[]> {
        return this.voices.map((voice) => ({ name: voice.name, id: voice.voiceURI, language: voice.lang })).filter((voice) => voice.id && voice.language) as NamidaVoice[];
    }

    public static speak(text: string, namidaVoice: NamidaVoice) {
        console.debug(TTSWrapper.logTag, "Speaking", text, "with window.speechSynthesis and", namidaVoice.name)
        window.speechSynthesis.cancel();
        const message = new SpeechSynthesisUtterance(text);
        const preferredVoice = this.voices.find((voice) => voice.voiceURI === namidaVoice.id);
        if (preferredVoice) {
            message.voice = preferredVoice;
        }
        else {
            const defaultVoiceForLanguage = this.voices.find((voice) => voice.lang === namidaVoice.language);
            if (defaultVoiceForLanguage) {
                message.voice = defaultVoiceForLanguage;
            }
        }

        if (message.voice) {
            window.speechSynthesis.speak(message);
        }
        else {
            console.warn(TTSWrapper.logTag, "Did not find voice to speak with");
        }
    }
}

TTSWrapper._initialize();