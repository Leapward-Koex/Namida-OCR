import UpscalerJS from 'upscaler';
import { runtime } from 'webextension-polyfill';
import { NamidaMessageAction, NamidaTensorflowUpscaleData } from '../interfaces/message';
import { browser, PixelData, Rank, tensor, Tensor2D } from '@tensorflow/tfjs';

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

    public static async upscaleImageWithAIFromBackground(data: NamidaTensorflowUpscaleData) {
        console.debug(Upscaler.logTag, "Creating upscaler");
        console.debug(Upscaler.logTag, "Created upscaler");
        try {
            if (globalThis.Image && data.dataUrl) {
                console.debug(Upscaler.logTag, "Upscaling image using base64 image");
                const upscaledImage = await Upscaler.upscaler.upscale(data.dataUrl)
                console.debug(Upscaler.logTag, "Upscaled image");
                return { dataUrl: upscaledImage } as NamidaTensorflowUpscaleData;;
            }
            else {
                console.debug(Upscaler.logTag, "Upscaling image using tensor image");
                const tensorData = tensor<Rank.R3>(new Int32Array(data.imageData), data.shape);
                const upscaledImage = await Upscaler.upscaler.upscale(tensorData, { output: "tensor" })
                console.debug(Upscaler.logTag, "Upscaled image");
                const upscaledShape = upscaledImage.shape
                const upscaledData = await upscaledImage.data()

                return { imageData: Array.from(upscaledData), shape: upscaledShape } as NamidaTensorflowUpscaleData;
            }
        }
        catch (ex) {
            return console.error(Upscaler.logTag, "Failed to upscale image using AI", ex);
        }
    }

    public static async upscaleImageWithAIFromContent(inputCanvas: HTMLCanvasElement) {
        const inputDataUrl = inputCanvas.toDataURL('image/png');
        const pixels = browser.fromPixels(inputCanvas)
        const data = await pixels.data()
        const upscaledImageTensorData = await runtime.sendMessage({
            action: NamidaMessageAction.UpscaleImage, data: {
                imageData: Array.from(data),
                shape: pixels.shape,
                dataUrl: inputDataUrl
            } as NamidaTensorflowUpscaleData
        }) as NamidaTensorflowUpscaleData;
        if (upscaledImageTensorData.dataUrl) {
            // Some browsers can perform this upscaling using image elements (e.g. firefox). They are also not able to use tensors to upscale images as they cannot be converted back to image data on the content side.
            // See for more details https://discourse.mozilla.org/t/invalidstateerror-canvasrenderingcontext2d-putimagedata-failed-to-extract-uint8clampedarray-from-imagedata-security-check-failed/122595/7
            return upscaledImageTensorData.dataUrl;
        }
        // Rest of the browsers have to rely on tensors and converting them back to image data
        const upscaledTensor = tensor<Rank.R3>(new Int32Array(upscaledImageTensorData.imageData), upscaledImageTensorData.shape);
        const canvas = document.createElement('canvas');
        canvas.height = upscaledTensor.shape[0];
        canvas.width = upscaledTensor.shape[1];
        await browser.toPixels(upscaledTensor, canvas);
        return canvas.toDataURL('image/png');
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