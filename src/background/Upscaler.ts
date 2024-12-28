import UpscalerJS from 'upscaler';
import x2 from '@upscalerjs/esrgan-thick'
import { runtime } from 'webextension-polyfill';

export class Upscaler {
    upscaler: any;
    constructor() {
    }

    public static async upscaleImageWithAI(base64Input: string) {
        const upscaler = new UpscalerJS({
            model: {
                scale: 2,
                path: runtime.getURL('libs/tensorflow/model.json')
            }
        });
        const upscaledImage = await upscaler.upscale(base64Input)
        return upscaledImage;
    }

    public static upscaleCanvas(
        sourceCanvas: HTMLCanvasElement,
        scaleFactor: number
    ): HTMLCanvasElement {
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

        return upscaledCanvas;
    }
}