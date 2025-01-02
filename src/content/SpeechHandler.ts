import { Settings } from "../interfaces/Storage";
import { TTSWrapper } from "./TTSWrapper";

export class SpeechSynthesisHandler {
    private static logTag = `[${SpeechSynthesisHandler.name}]`;
    private language: string;

    constructor(language: string = "ja-JP") {
        this.language = language;
    }

    public async speak(text: string): Promise<void> {
        const matchingVoice = await this.voiceForLanguage();

        if (matchingVoice) {
            console.debug(SpeechSynthesisHandler.logTag, `Using voice: ${matchingVoice.id}`);
            await TTSWrapper.speak(text, matchingVoice);

        } else {
            console.warn(SpeechSynthesisHandler.logTag, "No matching voice found, cannot speak.");
        }
    }

    public async voiceForLanguage(language: string = this.language) {
        try {
            const normalizedLanguage = language.toLowerCase();
            const preferredVoiceId = await Settings.getPreferredVoiceId(normalizedLanguage);
            const voices = await TTSWrapper.getVoices();
            const voicesForLanguage = voices.filter(
                (voice) => voice.language.toLowerCase().startsWith(normalizedLanguage)
            );

            if (voicesForLanguage.length === 0) {
                console.warn(SpeechSynthesisHandler.logTag, `No voices available for language: ${language}`);
                return;
            }

            if (preferredVoiceId) {
                const preferredVoiceForLanguage = voicesForLanguage.find(
                    (voice) => voice.id === preferredVoiceId
                );

                if (preferredVoiceForLanguage) {
                    return preferredVoiceForLanguage;
                } else {
                    console.warn(SpeechSynthesisHandler.logTag, `Preferred voice Id "${preferredVoiceId}" not found for language "${language}". Using default voice.`);
                }
            }

            return voicesForLanguage[0];
        } catch (error) {
            console.error(SpeechSynthesisHandler.logTag, `Error in voiceForLanguage: ${error}`);
        }
    }

}
