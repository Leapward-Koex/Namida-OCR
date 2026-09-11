import type UpscalerJS from 'upscaler';
import { runtime } from 'webextension-polyfill';
import { NamidaMessageAction, type NamidaTensorflowUpscaleData } from '../interfaces/message';
import type { Tensor3D } from '@tensorflow/tfjs';

type TensorImage = Pick<NamidaTensorflowUpscaleData, 'imageData' | 'shape'>;
type UpscaledImage = TensorImage | { dataUrl: string };
type AiRuntime = { tf: typeof import('@tensorflow/tfjs'); upscaler: InstanceType<typeof UpscalerJS> };

function assertTensorImage(value: unknown): asserts value is TensorImage {
    const image = value as Partial<TensorImage> | null;
    if (!image || !Array.isArray(image.shape) || image.shape.length !== 3
        || !image.shape.every(dimension => Number.isSafeInteger(dimension) && dimension > 0)
        || image.shape[2] !== 3 || !Array.isArray(image.imageData)
        || image.imageData.length !== image.shape[0] * image.shape[1] * image.shape[2]
        || !image.imageData.every(Number.isFinite)) {
        throw new Error('AI upscaling requires a valid RGB image and matching dimensions.');
    }
}

export class Upscaler {
    private static aiRuntime: Promise<AiRuntime> | null = null;

    private static getAiRuntime(): Promise<AiRuntime> {
        return this.aiRuntime ??= (async () => {
            // Defer module evaluation without a DOM chunk loader: Chromium can
            // call this from its service worker. All library/model bytes stay bundled.
            const [{ default: UpscalerConstructor }, tf] = await Promise.all([
                import(/* webpackMode: "eager" */ 'upscaler'),
                import(/* webpackMode: "eager" */ '@tensorflow/tfjs'),
            ]);
            await tf.ready();
            const upscaler = new UpscalerConstructor({
                model: { scale: 2, path: runtime.getURL('libs/tensorflow/x2/model.json') },
            });
            try {
                await upscaler.ready;
                return { tf, upscaler };
            } catch (error) {
                // dispose() itself awaits ready, so clean up a loaded model directly
                // if initialization failed after loading it (for example, warmup).
                const loaded = await upscaler.getModel().catch(() => undefined);
                loaded?.model.dispose();
                throw error;
            }
        })().catch(error => {
            this.aiRuntime = null;
            throw error;
        });
    }

    public static async upscaleImageWithAIFromBackground(data: NamidaTensorflowUpscaleData): Promise<UpscaledImage> {
        const useDataUrl = typeof globalThis.Image === 'function' && typeof data?.dataUrl === 'string' && data.dataUrl.length > 0;
        if (!useDataUrl) assertTensorImage(data);
        const { tf, upscaler } = await this.getAiRuntime();
        if (useDataUrl) {
            // Firefox's background document can decode/encode images itself,
            // avoiding cross-context ImageData restrictions in its content script.
            const dataUrl = await upscaler.upscale(data.dataUrl!);
            if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
                throw new Error('AI upscaling returned no image.');
            }
            return { dataUrl };
        }

        const input = tf.tensor3d(data.imageData, data.shape, 'int32');
        let output: Tensor3D | undefined;
        try {
            output = await upscaler.upscale(input, { output: 'tensor' });
            if (!output || typeof output.data !== 'function') {
                throw new Error('AI upscaling returned no tensor image.');
            }
            const result = { imageData: Array.from(await output.data()), shape: [...output.shape] as [number, number, number] };
            assertTensorImage(result);
            return result;
        } finally {
            // UpscalerJS clones its tensor input; both these tensors belong to us.
            // Keep them alive through async inference/data reads, then release them.
            try {
                if (output !== input) output?.dispose?.();
            } finally {
                input.dispose();
            }
        }
    }

    public static async upscaleImageWithAIFromContent(inputCanvas: HTMLCanvasElement) {
        const context = inputCanvas.getContext('2d');
        if (!context) throw new Error('Unable to get canvas context for AI upscaling.');
        const rgba = context.getImageData(0, 0, inputCanvas.width, inputCanvas.height).data;
        const imageData = new Array<number>(inputCanvas.width * inputCanvas.height * 3);
        for (let pixel = 0; pixel < inputCanvas.width * inputCanvas.height; pixel += 1) {
            imageData[pixel * 3] = rgba[pixel * 4];
            imageData[pixel * 3 + 1] = rgba[pixel * 4 + 1];
            imageData[pixel * 3 + 2] = rgba[pixel * 4 + 2];
        }
        // Canvas pixels preserve the tensor fallback without loading TensorFlow
        // (or allocating its tensors/models) inside every page's content script.
        const result: unknown = await runtime.sendMessage({
            action: NamidaMessageAction.UpscaleImage, data: {
                imageData,
                shape: [inputCanvas.height, inputCanvas.width, 3],
                dataUrl: inputCanvas.toDataURL('image/png'),
            } as NamidaTensorflowUpscaleData
        });
        if (result && typeof result === 'object' && 'dataUrl' in result
            && typeof result.dataUrl === 'string' && result.dataUrl.startsWith('data:image/')) {
            return result.dataUrl;
        }
        if (!result) throw new Error('AI upscaling returned no image.');
        assertTensorImage(result);
        const canvas = document.createElement('canvas');
        canvas.height = result.shape[0];
        canvas.width = result.shape[1];
        const outputContext = canvas.getContext('2d');
        if (!outputContext) throw new Error('Unable to get canvas context for AI upscaling.');
        const pixels = outputContext.createImageData(canvas.width, canvas.height);
        for (let pixel = 0; pixel < canvas.width * canvas.height; pixel += 1) {
            // UpscalerJS tensor output is RGB in 0–255, including fractional values.
            // ImageData clamps/rounds these just like its built-in PNG encoder.
            pixels.data[pixel * 4] = result.imageData[pixel * 3];
            pixels.data[pixel * 4 + 1] = result.imageData[pixel * 3 + 1];
            pixels.data[pixel * 4 + 2] = result.imageData[pixel * 3 + 2];
            pixels.data[pixel * 4 + 3] = 255;
        }
        outputContext.putImageData(pixels, 0, 0);
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
