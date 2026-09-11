import type { RgbaImage } from './PaddleModelPipeline';

/** Browser image I/O only. Tensor preparation and geometry use deterministic pixels. */
export async function decodePaddleImage(dataUrl: string): Promise<RgbaImage> {
    if (!dataUrl.startsWith('data:image/')) {
        throw new Error('PaddleOCR expects an image data URL from the local capture.');
    }
    const response = await fetch(dataUrl);
    const bitmap = await createImageBitmap(await response.blob());
    try {
        const canvas = makeCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
        if (!context) throw new Error('Unable to decode the PaddleOCR image');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, bitmap.width, bitmap.height);
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height);
    } finally {
        bitmap.close();
    }
}

export async function encodePaddleImage(image: RgbaImage): Promise<string> {
    const canvas = makeCanvas(image.width, image.height);
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error('Unable to encode a PaddleOCR debug image');
    const pixels = context.createImageData(image.width, image.height);
    pixels.data.set(image.data);
    context.putImageData(pixels, 0, 0);
    if ('toDataURL' in canvas) return canvas.toDataURL('image/png');
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}
