import { runtime } from 'webextension-polyfill';
import { NamidaMessageAction } from '../interfaces/message';

export class TesseractOcrHandler {
    private static logTag = `[${TesseractOcrHandler.name}]`;

    public async recognizeFromContent(dataUrl: string): Promise<string> {
        const text = await runtime.sendMessage({
            action: NamidaMessageAction.RecognizeImage,
            data: dataUrl,
        }) as string;
        console.debug(TesseractOcrHandler.logTag, 'Recognized text:', text);
        return text;
    }
}
