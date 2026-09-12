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
                // Load Paddle while the user selects a region. Selection and
                // capture must not wait for initialization or fail with it.
                void runtime.sendMessage({ action: NamidaMessageAction.PreloadOcr }).catch((error) => {
                    console.warn(SnippingTool.logTag, 'OCR preload failed; the scan can retry initialization', error);
                });
            }
            return undefined;
        });
    }

    private async onSelectionComplete(selection: SelectionRect) {
        const screenshotHandler = new ScreenshotHandler(selection);
        try {
            console.debug(SnippingTool.logTag, "Capturing screen");
            const [upscalingMethod, ocrBackend] = await Promise.all([
                Settings.getUpscalingMode(),
                Settings.getOcrBackend(),
            ]);

            const restoreWindow = FloatingWindow.hideForCapture();
            let croppedDataURL: string;
            try {
                croppedDataURL = await screenshotHandler.captureAndCrop(upscalingMethod);
            } finally {
                restoreWindow();
            }
            if (ocrBackend === 'paddleonnx') {
                FloatingWindow.showStatus("Scanning text...");
            }
            const recognizedText = await this.ocr.recognizeFromContent(croppedDataURL);
            // Paddle's multilingual dictionary includes meaningful spaces. Keep
            // model output intact; Tesseract retains its existing Japanese cleanup.
            const outputText = ocrBackend === 'paddleonnx'
                ? recognizedText
                : TextProcessorHandler.removeSpaces(recognizedText);
            let furigana: string | undefined;

            if (outputText) {
                try {
                    furigana = await FuriganaHandler.generateFuriganaFromContent(outputText);
                } catch (error) {
                    console.warn(SnippingTool.logTag, 'Failed to generate furigana; continuing with plain text output', error);
                }
            }

            ClipboardHandler.copyText(outputText);
            new FloatingWindow({ text: outputText, html: furigana });
            if (await Settings.getSaveOcrCrop()) {
                console.debug(SnippingTool.logTag, "Saving Image");
                this.saveHandler.downloadImage(croppedDataURL, 'snippet.png');
            }
        } catch (error) {
            console.error(SnippingTool.logTag, 'Failed when creating selection and performing OCR', error);
            FloatingWindow.showFailure();
        }
    }
}

const snippingTool = new SnippingTool();
snippingTool.setupMessageListener();
