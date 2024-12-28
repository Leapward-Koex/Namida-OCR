import { runtime } from "webextension-polyfill";
import { NamidaMessageAction } from "../interfaces/message";
import { SelectionRect } from "./SnippingOverlay";
import { Upscaler } from "../background/Upscaler";

export enum UpscaleMethod {
    None,
    Canvas,
    TensorFlow,
}
export class ScreenshotHandler {
    private static logTag = `[${ScreenshotHandler.name}]`;
    constructor(private selection: SelectionRect) { }

    public async captureAndCrop(upscaleMethod: UpscaleMethod = UpscaleMethod.TensorFlow): Promise<string> {
        try {
            console.debug(ScreenshotHandler.logTag, 'Capturing Screen')
            const base64Image: string = await runtime.sendMessage({ action: NamidaMessageAction.CaptureFullScreen }) as string;
            if (!base64Image) {
                throw new Error("Failed to get screenshot of current tab")
            }
            console.debug(ScreenshotHandler.logTag, 'Captured Screen')

            console.debug(ScreenshotHandler.logTag, 'Cropping to selection')
            const screenshotImg = await this.loadImage(base64Image);
            const fullCanvas = this.drawImageOnCanvas(screenshotImg);
            const croppedCanvas = this.cropCanvas(fullCanvas, this.selection);
            console.debug(ScreenshotHandler.logTag, 'Cropped to selection')

            if (upscaleMethod === UpscaleMethod.None) {
                return croppedCanvas.toDataURL('image/png');
            }
            else if (upscaleMethod === UpscaleMethod.Canvas) {
                console.debug(ScreenshotHandler.logTag, 'Upscaling using canvas')
                const dataUrl = Upscaler.upscaleCanvas(croppedCanvas, 4);
                console.debug(ScreenshotHandler.logTag, 'Upscaled using canvas')
                return dataUrl;
            }
            else {
                console.debug(ScreenshotHandler.logTag, 'Upscaling using tensorflow')
                const dataUrl = await Upscaler.upscaleImageWithAIFromContent(croppedCanvas.toDataURL('image/png'));
                console.debug(ScreenshotHandler.logTag, 'Upscaled using tensorflow')
                return dataUrl
            }
        } catch (error) {
            console.error(ScreenshotHandler.logTag, 'Snipping failed:', error);
            throw error;
        }
    }

    private loadImage(src: string): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }

    private drawImageOnCanvas(img: HTMLImageElement): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Unable to get canvas context');

        ctx.drawImage(img, 0, 0);
        return canvas;
    }

    private cropCanvas(canvas: HTMLCanvasElement, rect: SelectionRect): HTMLCanvasElement {
        const croppedCanvas = document.createElement('canvas');
        croppedCanvas.width = rect.width;
        croppedCanvas.height = rect.height;

        const croppedCtx = croppedCanvas.getContext('2d');
        if (!croppedCtx) throw new Error('Unable to get cropped canvas context');

        croppedCtx.drawImage(
            canvas,
            rect.left,
            rect.top,
            rect.width,
            rect.height,
            0,
            0,
            rect.width,
            rect.height
        );

        return croppedCanvas;
    }
}