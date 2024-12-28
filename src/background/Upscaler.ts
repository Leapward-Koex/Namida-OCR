import UpscalerJS from 'upscaler';
import { runtime } from 'webextension-polyfill';
import { NamidaMessageAction } from '../interfaces/message';

export class Upscaler {
    private static logTag = `[${Upscaler.name}]`;
    private static upscaler = new UpscalerJS({
        model: {
            scale: 2,
            path: runtime.getURL('libs/tensorflow/x2/model.json')
        }
    });

    constructor() {
    }

    public static async upscaleImageWithAIFromBackground(base64Input: string) {
        console.debug(Upscaler.logTag, "Creating upscaler");
        console.debug(Upscaler.logTag, "Created upscaler");
        const upscaledImage = await Upscaler.upscaler.upscale(base64Input)
        console.debug(Upscaler.logTag, "Upscaled image");
        return upscaledImage;
    }

    public static async upscaleImageWithAIFromContent(dataURL: string) {
        return await runtime.sendMessage({ action: NamidaMessageAction.UpscaleImage, data: dataURL }) as string;
    }

    public static upscaleCanvas(
        sourceCanvas: HTMLCanvasElement,
        scaleFactor: number
    ): string {
        // 1) Create a new canvas with scaled dimensions
        const upscaledCanvas = document.createElement('canvas');
        upscaledCanvas.width = sourceCanvas.width * scaleFactor;
        upscaledCanvas.height = sourceCanvas.height * scaleFactor;

        const ctx = upscaledCanvas.getContext('2d');
        if (!ctx) {
            throw new Error('Unable to get canvas context for upscaled image');
        }

        // ctx.imageSmoothingEnabled = false;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        // 2) Draw the source canvas onto the new canvas, scaled up
        ctx.drawImage(
            sourceCanvas,
            0, 0, sourceCanvas.width, sourceCanvas.height,
            0, 0, upscaledCanvas.width, upscaledCanvas.height
        );

        return upscaledCanvas.toDataURL('image/png')
    }
}