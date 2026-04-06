import { runtime } from 'webextension-polyfill';
import { NamidaMessageAction } from '../interfaces/message';

export class TesseractOcrHandler {
    public async recognizeFromContent(dataUrl: string): Promise<string> {
        const text = await runtime.sendMessage({
            action: NamidaMessageAction.RecognizeImage,
            data: dataUrl,
        });
        return text as string;
    }
}
