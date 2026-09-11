/** PP-OCRv6 image/CTC contracts, independent of canvas, ONNX sessions and layout.
 * Reference: PaddleX c50f5da858020db473a2285f089bb8c7bbd6afdc,
 * paddlex/inference/models/text_detection/processors.py (DetResizeForTest) and
 * text_recognition/processors.py (OCRReisizeNormImg, CTCLabelDecode).
 */
export interface RgbaImage {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8Array | Uint8ClampedArray;
}

export interface DetectorOptions {
    limit_side_len: number;
    limit_type: 'min' | 'max' | 'resize_long';
    max_side_len: number;
    mean: readonly number[];
    std: readonly number[];
}

export interface RecognizerOptions {
    image_height: number;
    base_image_width: number;
    max_image_width: number;
}

export interface PaddleModelManifest {
    version: string;
    model_version: string;
    variant: string;
    detector: DetectorOptions & {
        model_path: string;
        config_path: string;
        channel_order: 'BGR';
        threshold: number;
        box_score_threshold: number;
        unclip_ratio: number;
        max_candidates: number;
        min_box_size: number;
        use_dilation: boolean;
        score_mode: 'fast';
    };
    recognizer: RecognizerOptions & {
        model_path: string;
        config_path: string;
        dict_path: string;
        channel_order: 'BGR';
        normalized_padding: 0;
        output_activation: 'softmax';
        blank_index: 0;
        output_classes: number;
        score_threshold: number;
        rotation_aspect_threshold: number;
    };
}

export interface PreparedModelInput {
    data: Float32Array;
    dims: [1, 3, number, number];
    width: number;
    height: number;
    sourceWidth: number;
    sourceHeight: number;
    contentWidth: number;
    widthClamped: boolean;
    scaleX: number;
    scaleY: number;
}

export interface CtcToken {
    text: string;
    classIndex: number;
    timestep: number;
    /** The winning model probability, in [0, 1]; no second softmax. */
    confidence: number;
}

export interface CtcResult {
    text: string;
    /** Arithmetic mean over emitted tokens, including spaces; empty = 0. */
    confidence: number;
    tokens: CtcToken[];
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = {
    // Pinned PaddleX standalone PP-OCRv6 predictor defaults; the additional
    // browser ceiling bounds explicit overrides, not the graph's dynamic shape.
    limit_side_len: 960, limit_type: 'max', max_side_len: 1536,
    mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225],
};

export const DEFAULT_RECOGNIZER_OPTIONS: RecognizerOptions = {
    image_height: 48, base_image_width: 320, max_image_width: 3200,
};

export function prepareDetectorInput(image: RgbaImage, options: DetectorOptions = DEFAULT_DETECTOR_OPTIONS): PreparedModelInput {
    validateImage(image);
    positiveInteger(options.limit_side_len, 'detector limit_side_len');
    positiveInteger(options.max_side_len, 'detector max_side_len');
    if (options.mean.length !== 3 || options.std.length !== 3
        || options.mean.some(value => !Number.isFinite(value))
        || options.std.some(value => !Number.isFinite(value) || value <= 0)) {
        throw new Error('PaddleOCR detector requires three finite means and positive standard deviations');
    }
    // The reference pads exceptionally tiny images at the bottom/right in black.
    const source = image.width + image.height < 64 ? padTinyImage(image) : image;
    const longest = Math.max(source.width, source.height);
    const shortest = Math.min(source.width, source.height);
    let ratio: number;
    switch (options.limit_type) {
        case 'max': ratio = Math.min(1, options.limit_side_len / longest); break;
        case 'min': ratio = Math.max(1, options.limit_side_len / shortest); break;
        case 'resize_long': ratio = options.limit_side_len / longest; break;
        default: throw new Error(`Unsupported PaddleOCR detector limit_type: ${options.limit_type}`);
    }
    let height = Math.trunc(source.height * ratio);
    let width = Math.trunc(source.width * ratio);
    if (Math.max(height, width) > options.max_side_len) {
        const capRatio = options.max_side_len / Math.max(height, width);
        height = Math.trunc(height * capRatio);
        width = Math.trunc(width * capRatio);
    }
    // Python round uses ties-to-even, unlike Math.round. The difference matters
    // at exact half-stride dimensions (e.g. 80 -> 64 rather than 96).
    height = Math.max(32, roundToEven(height / 32) * 32);
    width = Math.max(32, roundToEven(width / 32) * 32);
    const resized = resizeBilinearRgba(source, width, height);
    const data = normalizeBgr(resized, width, options.mean, options.std);
    return {
        data, dims: [1, 3, height, width], width, height,
        sourceWidth: image.width, sourceHeight: image.height,
        scaleX: width / source.width, scaleY: height / source.height,
        contentWidth: width, widthClamped: false,
    };
}

export function prepareRecognizerInput(image: RgbaImage, options: RecognizerOptions = DEFAULT_RECOGNIZER_OPTIONS): PreparedModelInput {
    validateImage(image);
    const height = positiveInteger(options.image_height, 'recognizer image_height');
    const baseWidth = positiveInteger(options.base_image_width, 'recognizer base_image_width');
    const maxWidth = positiveInteger(options.max_image_width, 'recognizer max_image_width');
    if (baseWidth > maxWidth) throw new Error('PaddleOCR recognition base width cannot exceed its maximum');
    const ratio = image.width / image.height;
    const requestedWidth = Math.trunc(height * Math.max(baseWidth / height, ratio));
    const width = Math.min(requestedWidth, maxWidth);
    // The upstream resource cap compresses exceptionally long lines; it does not
    // truncate their right-hand pixels. Surface this in debug metadata.
    const widthClamped = requestedWidth > maxWidth;
    const contentWidth = widthClamped ? width : Math.min(width, Math.ceil(height * ratio));
    const resized = resizeBilinearRgba(image, contentWidth, height);
    const data = normalizeBgr(resized, width, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    return {
        data, dims: [1, 3, height, width], width, height,
        sourceWidth: image.width, sourceHeight: image.height,
        contentWidth, widthClamped,
        scaleX: contentWidth / image.width, scaleY: height / image.height,
    };
}

/** Greedy CTC over the graph's already-normalized [T, dictionary.length + 1] output. */
export function decodeCtcProbabilities(probabilities: Float32Array, steps: number, dictionary: readonly string[]): CtcResult {
    positiveInteger(steps, 'CTC timesteps');
    if (dictionary.length === 0 || dictionary.some(token => token.length === 0)) {
        throw new Error('PaddleOCR CTC dictionary cannot be empty or contain empty tokens');
    }
    const classes = dictionary.length + 1;
    if (!Number.isSafeInteger(steps * classes) || probabilities.length !== steps * classes) {
        throw new Error('PaddleOCR CTC output does not match its timestep/dictionary dimensions');
    }
    const tokens: CtcToken[] = [];
    let previous = 0;
    for (let timestep = 0; timestep < steps; timestep += 1) {
        const offset = timestep * classes;
        let best = 0;
        let confidence = -Infinity;
        for (let classIndex = 0; classIndex < classes; classIndex += 1) {
            const probability = probabilities[offset + classIndex];
            if (!Number.isFinite(probability) || probability < -1e-6 || probability > 1 + 1e-6) {
                throw new Error('PaddleOCR CTC output must contain probabilities, not logits or non-finite values');
            }
            if (probability > confidence) {
                best = classIndex;
                confidence = probability;
            }
        }
        if (best !== 0 && best !== previous) {
            tokens.push({ text: dictionary[best - 1], classIndex: best, timestep, confidence });
        }
        previous = best;
    }
    return {
        text: tokens.map(token => token.text).join(''),
        confidence: tokens.length === 0 ? 0 : tokens.reduce((sum, token) => sum + token.confidence, 0) / tokens.length,
        tokens,
    };
}

/** Half-pixel, edge-replicated linear resize corresponding to cv2.resize's default.
 * Byte rounding can differ by one from OpenCV's SIMD/fixed-point paths; unlike
 * canvas scaling this is deterministic across browser rendering backends.
 * Transparent input is composited onto white, matching the screenshot surface.
 */
export function resizeBilinearRgba(image: RgbaImage, width: number, height: number): RgbaImage {
    validateImage(image);
    positiveInteger(width, 'resize width');
    positiveInteger(height, 'resize height');
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        const sourceY = Math.max(0, (y + 0.5) * image.height / height - 0.5);
        const y0 = Math.min(image.height - 1, Math.floor(sourceY));
        const y1 = Math.min(image.height - 1, y0 + 1);
        const fy = sourceY - y0;
        for (let x = 0; x < width; x += 1) {
            const sourceX = Math.max(0, (x + 0.5) * image.width / width - 0.5);
            const x0 = Math.min(image.width - 1, Math.floor(sourceX));
            const x1 = Math.min(image.width - 1, x0 + 1);
            const fx = sourceX - x0;
            const offsets = [(y0 * image.width + x0) * 4, (y0 * image.width + x1) * 4,
                (y1 * image.width + x0) * 4, (y1 * image.width + x1) * 4];
            const target = (y * width + x) * 4;
            for (let channel = 0; channel < 3; channel += 1) {
                const a = opaqueChannel(image.data, offsets[0], channel);
                const b = opaqueChannel(image.data, offsets[1], channel);
                const c = opaqueChannel(image.data, offsets[2], channel);
                const d = opaqueChannel(image.data, offsets[3], channel);
                data[target + channel] = Math.round((a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy);
            }
            data[target + 3] = 255;
        }
    }
    return { width, height, data };
}

function normalizeBgr(image: RgbaImage, tensorWidth: number, mean: readonly number[], std: readonly number[]): Float32Array {
    const plane = tensorWidth * image.height;
    // Float32Array's zeros are normalized padding, never white pixel padding.
    const tensor = new Float32Array(plane * 3);
    for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
            const source = (y * image.width + x) * 4;
            const target = y * tensorWidth + x;
            for (let channel = 0; channel < 3; channel += 1) {
                tensor[channel * plane + target] = (image.data[source + 2 - channel] / 255 - mean[channel]) / std[channel];
            }
        }
    }
    return tensor;
}

function opaqueChannel(data: RgbaImage['data'], offset: number, channel: number): number {
    const alpha = data[offset + 3] / 255;
    return data[offset + channel] * alpha + 255 * (1 - alpha);
}

function padTinyImage(image: RgbaImage): RgbaImage {
    const width = Math.max(32, image.width);
    const height = Math.max(32, image.height);
    const data = new Uint8ClampedArray(width * height * 4);
    for (let index = 3; index < data.length; index += 4) data[index] = 255;
    for (let y = 0; y < image.height; y += 1) data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), y * width * 4);
    return { width, height, data };
}

function roundToEven(value: number): number {
    const floor = Math.floor(value);
    return value - floor === 0.5 ? floor + floor % 2 : Math.round(value);
}

function positiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`PaddleOCR ${label} must be a positive safe integer`);
    return value;
}

function validateImage(image: RgbaImage): void {
    positiveInteger(image.width, 'image width');
    positiveInteger(image.height, 'image height');
    if (!Number.isSafeInteger(image.width * image.height * 4) || image.data.length !== image.width * image.height * 4) {
        throw new Error('PaddleOCR RGBA buffer length does not match image dimensions');
    }
}
