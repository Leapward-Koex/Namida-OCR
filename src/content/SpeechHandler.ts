export class SpeechSynthesisHandler {
    private static logTag = `[${SpeechSynthesisHandler.name}]`;
    private language: string;
    private voices: SpeechSynthesisVoice[] = window.speechSynthesis.getVoices();

    constructor(language: string = "ja-JP") {
        this.language = language;
    }

    public speak(text: string): void {
        const utterance = new SpeechSynthesisUtterance(text);
        const matchingVoice = this.voiceForLanguage();

        if (matchingVoice) {
            utterance.voice = matchingVoice;
            console.debug(SpeechSynthesisHandler.logTag, `Using voice: ${matchingVoice.name}`);
            window.speechSynthesis.cancel();
            window.speechSynthesis.speak(utterance);

        } else {
            console.warn(SpeechSynthesisHandler.logTag, "No matching voice found, cannot speak.");
        }
    }

    public voiceForLanguage(language: string = this.language) {
        return this.voices.find(
            (voice) =>
                voice.lang.toLowerCase().startsWith(language.toLowerCase())
        );
    }
}
