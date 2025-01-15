import { runtime } from "webextension-polyfill";
import { NamidaMessage, NamidaMessageAction } from "../interfaces/message";
import { SelectionRect, SnipOverlay } from "./SnippingOverlay";
import { SaveHandler } from "./SaveHandler";
import { TesseractOcrHandler } from "../background/TesseractOcrHandler";
import { ScreenshotHandler } from "./ScreenshotHandler";
import { Settings } from "../interfaces/Storage";
import { ClipboardHandler } from "./ClipboardHandler";
import { FloatingWindow } from "./FloatingWindowHandler";
import { TextProcessorHandler } from "./TextProcessorHandler";
import { FuriganaHandler } from "../background/FuriganaHandler";

console.debug('Content script loaded');

// SnippingTool Class
class SnippingTool {
    private static logTag = `[${SnippingTool.name}]`;
    private overlay: SnipOverlay;
    private saveHandler: SaveHandler;
    private ocr: TesseractOcrHandler;

    constructor() {
        this.saveHandler = new SaveHandler();
        this.ocr = new TesseractOcrHandler();
        this.overlay = new SnipOverlay(this.onSelectionComplete.bind(this));
    }

    public setupMessageListener() {
        runtime.onMessage.addListener((message) => {
            if ((message as NamidaMessage).action === NamidaMessageAction.SnipPage) {
                console.debug(SnippingTool.logTag, "Going to show overlay over content")
                this.overlay.show();
            }
            return undefined;
        });
    }

    private async onSelectionComplete(selection: SelectionRect) {
        const screenshotHandler = new ScreenshotHandler(selection);
        try {
            console.debug(SnippingTool.logTag, "Capturing screen");
            const upscalingMethod = await Settings.getUpscalingMode();
            const croppedDataURL = await screenshotHandler.captureAndCrop(upscalingMethod);
            console.debug(SnippingTool.logTag, "Got data: " + croppedDataURL);
            const recognizedText = await this.ocr.recognizeFromContent(croppedDataURL);
            const spacesRemovedText = TextProcessorHandler.removeSpaces(recognizedText);
            const furigana = await FuriganaHandler.generateFuriganaFromContent(spacesRemovedText ?? "");
            ClipboardHandler.copyText(spacesRemovedText);
            new FloatingWindow({ text: spacesRemovedText, html: furigana });
            if (await Settings.getSaveOcrCrop()) {
                console.debug(SnippingTool.logTag, "Saving Image");
                this.saveHandler.downloadImage(croppedDataURL, 'snippet.png');
            }
        } catch (error) {
            console.error(SnippingTool.logTag, 'Failed when creating selection and performing OCR', error);
        }
    }
}

const snippingTool = new SnippingTool();
snippingTool.setupMessageListener();
