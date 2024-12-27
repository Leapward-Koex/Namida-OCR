import { runtime } from "webextension-polyfill";
import { NamidaMessageAction } from "../interfaces/message";
import { SelectionRect } from "./SnippingOverlay";

export class ScreenshotHandler {
    constructor(private selection: SelectionRect) { }

    public async captureAndCrop(): Promise<string> {
        try {
            // 1) Request screenshot from background script
            const base64Image: string = await runtime.sendMessage({ action: NamidaMessageAction.CaptureFullScreen }) as string;
            if (!base64Image) {
                throw new Error("Failed to get screenshot of current tab")
            }
            // 2) Convert base64 to Image
            const screenshotImg = await this.loadImage(base64Image);

            // 3) Draw Image on Canvas
            const fullCanvas = this.drawImageOnCanvas(screenshotImg);

            // 4) Crop the Canvas
            const croppedCanvas = this.cropCanvas(fullCanvas, this.selection);

            // 5) Get Data URL
            const dataURL = croppedCanvas.toDataURL('image/png');

            return dataURL;
        } catch (error) {
            console.error('Snipping failed:', error);
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