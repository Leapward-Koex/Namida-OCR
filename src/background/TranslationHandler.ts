import { env, pipeline, TranslationPipeline } from "@huggingface/transformers";
import { runtime } from "webextension-polyfill";
import { NamidaMessageAction } from "../interfaces/message";

export class TranslationHandler {
    private static logTag = `[${TranslationHandler.name}]`;
    private static translatorPromise: Promise<TranslationPipeline>;

    public static async initWorker(useLocalModels = true): Promise<void> {
        console.debug(TranslationHandler.logTag, "Initializing translation worker");
        env.allowLocalModels = useLocalModels;
        env.allowRemoteModels = !useLocalModels;
        env.localModelPath = runtime.getURL('xenovaModels');

        this.translatorPromise = pipeline('translation', 'onnx-community/opus-mt-ja-en', {
            dtype: "int8", device: "auto", progress_callback: (a) => {
                console.log(a)
            }
        });
    }

    public static async translateTextFromContent(japaneseText: string): Promise<string> {
        const text = await runtime.sendMessage({ action: NamidaMessageAction.TranslateText, data: japaneseText }) as string;
        console.debug(TranslationHandler.logTag, "Translate text: " + text);
        return text;
    }

    public static async translateText(japaneseText: string = 'こんにちは世界') {
        console.debug(TranslationHandler.logTag, "Going to translate", japaneseText);

        const pipeline = await this.translatorPromise;
        const result = await pipeline(japaneseText);

        let translatedResult = '';
        if (Array.isArray(result)) {
            translatedResult = result.map((translationResult) => (translationResult as any).translation_text).join(" ");
        }
        else {
            translatedResult = (result as any).translation_text
        }
        console.debug(TranslationHandler.logTag, "Translated", japaneseText, "to", translatedResult.toString());
        return translatedResult;
    }
}
