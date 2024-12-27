import { runtime } from "webextension-polyfill";
import { NamidaMessage } from "../interfaces/message";
import { SelectionRect, SnipOverlay } from "./SnippingOverlay";
import { SaveHandler } from "./SaveHandler";

console.debug('Content script loaded');

interface ScreenshotResponse {
    action: string;
    dataUrl: string;
}

// ScreenshotHandler Class
class ScreenshotHandler {
    constructor(private selection: SelectionRect) { }

    public async captureAndCrop(): Promise<string> {
        try {
            // 1) Request screenshot from background script
            const base64Image: string = await runtime.sendMessage({ action: 'captureFullScreen' }) as string;

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

// SnippingTool Class
class SnippingTool {
    private overlay: SnipOverlay;
    private saveHandler: SaveHandler;
    private isSnipping: boolean = false;

    constructor() {
        this.saveHandler = new SaveHandler();
        this.overlay = new SnipOverlay(this.onSelectionComplete.bind(this));
    }

    public setupMessageListener() {
        runtime.onMessage.addListener((message, sender, sendResponse) => {
            if ((message as NamidaMessage).action === "toggleFeature") {
                this.toggleSnipOverlay();
            }
            return true;
        });
    }

    private toggleSnipOverlay() {
        if (this.isSnipping) {
            this.overlay.hide();
            this.isSnipping = false;
        } else {
            this.overlay.show();
            this.isSnipping = true;
        }
    }

    private async onSelectionComplete(selection: SelectionRect) {
        const screenshotHandler = new ScreenshotHandler(selection);
        try {
            const croppedDataURL = await screenshotHandler.captureAndCrop();
            this.saveHandler.downloadImage(croppedDataURL, 'snippet.png');
        } catch (error) {
            // Handle error appropriately
        }
    }
}

const snippingTool = new SnippingTool();
snippingTool.setupMessageListener();
