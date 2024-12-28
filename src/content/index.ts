import { runtime } from "webextension-polyfill";
import { NamidaMessage, NamidaMessageAction } from "../interfaces/message";
import { SelectionRect, SnipOverlay } from "./SnippingOverlay";
import { SaveHandler } from "./SaveHandler";
import { TesseractOcrHandler } from "../background/TesseractOcrHandler";
import { ScreenshotHandler } from "./ScreenshotHandler";
import { Settings } from "../interfaces/Storage";
import { ClipboardHandler } from "./ClipboardHandler";
import { FloatingWindow } from "./FloatingWindowHandler";

console.debug('Content script loaded');

interface ScreenshotResponse {
    action: string;
    dataUrl: string;
}

// ScreenshotHandler Class

// SnippingTool Class
class SnippingTool {
    private overlay: SnipOverlay;
    private saveHandler: SaveHandler;
    private isSnipping: boolean = false;
    private ocr: TesseractOcrHandler;

    constructor() {
        this.saveHandler = new SaveHandler();
        this.ocr = new TesseractOcrHandler();
        this.overlay = new SnipOverlay(this.onSelectionComplete.bind(this));
    }

    public setupMessageListener() {
        runtime.onMessage.addListener((message, sender, sendResponse) => {
            if ((message as NamidaMessage).action === NamidaMessageAction.SnipPage) {
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
            console.debug("Capturing screen");
            const upscalingMethod = await Settings.getUpscalingMode();
            const croppedDataURL = await screenshotHandler.captureAndCrop(upscalingMethod);
            console.debug("Got data: " + croppedDataURL);
            const recognizedText = await this.ocr.recognizeFromContent(croppedDataURL);
            ClipboardHandler.copyText(recognizedText);
            new FloatingWindow(recognizedText);
            if (await Settings.getSaveOcrCrop()) {
                console.debug("Saving Image");
                this.saveHandler.downloadImage(croppedDataURL, 'snippet.png');
            }
        } catch (error) {
            console.error('Failed when creating selection and performing OCR', error);
        }
    }
}

const snippingTool = new SnippingTool();
snippingTool.setupMessageListener();
