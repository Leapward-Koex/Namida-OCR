import { runtime } from 'webextension-polyfill';
import * as ort from 'onnxruntime-web';
import { PSM } from 'tesseract.js';
import type { OcrBackend } from './OcrBackend';
import { DEFAULT_OCR_MODEL } from '../../interfaces/Storage';
import { buildOcrRecognitionCandidate, serializeOcrCandidate, type OcrRecognitionCandidate } from './OcrTextScoring';
import { TesseractOcrBackend } from './TesseractOcrBackend';

type WorkingCanvas = OffscreenCanvas | HTMLCanvasElement;
type DrawingContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

type DetectorConfig = {
    model_path: string;
    config_path: string;
    limit_side_len: number;
    limit_type: 'min' | 'max';
    max_side_len: number;
    mean: [number, number, number];
    std: [number, number, number];
    threshold: number;
    box_score_threshold: number;
    dilation_radius: number;
    min_box_size: number;
    box_padding: number;
};

type RecognizerConfig = {
    model_path: string;
    config_path: string;
    dict_path: string;
    image_height: number;
    min_image_width: number;
    max_image_width: number;
    mean: [number, number, number];
    std: [number, number, number];
    rotation_aspect_threshold: number;
};

type PaddleOnnxManifest = {
    version: string;
    source_repo: string;
    detector: DetectorConfig;
    recognizer: RecognizerConfig;
};

type SessionBundle = {
    promise: Promise<ort.InferenceSession>;
    session: ort.InferenceSession | null;
};

type DetectedBox = {
    averageScore: number;
    bottom: number;
    centerX: number;
    centerY: number;
    height: number;
    left: number;
    right: number;
    top: number;
    width: number;
};

type RecognitionAttempt = {
    candidate: OcrRecognitionCandidate | null;
    rotated: boolean;
};

export class PaddleOnnxOcrBackend implements OcrBackend {
    private static readonly logTag = `[${PaddleOnnxOcrBackend.name}]`;
    private static readonly detectorSessionKey = 'detector';
    private static readonly recognizerSessionKey = 'recognizer';
    private static readonly sessions = new Map<string, SessionBundle>();
    private static readonly tesseractFallbackBackend = new TesseractOcrBackend();
    private static manifestPromise: Promise<PaddleOnnxManifest> | null = null;
    private static dictionaryPromise: Promise<string[]> | null = null;
    private static ortConfigured = false;

    public async init(): Promise<void> {
        await Promise.all([
            this.ensureDetectorSession(),
            this.ensureRecognizerSession(),
            this.getDictionary(),
        ]);
    }

    public async recognize(dataUrl: string, pageSegMode: PSM, model: string = DEFAULT_OCR_MODEL): Promise<string | undefined> {
        const startedAt = performance.now();
        const manifest = await this.getManifest();
        const sourceCanvas = await canvasFromDataUrl(dataUrl);
        const detectorSession = await this.ensureDetectorSession();
        const recognizerSession = await this.ensureRecognizerSession();
        const dictionary = await this.getDictionary();

        const detectionInput = prepareDetectionTensor(sourceCanvas, manifest.detector);
        const detectionOutput = await detectorSession.run({ x: detectionInput.tensor });
        const probabilityTensor = detectionOutput[detectorSession.outputNames[0]];
        const detectedBoxes = extractDetectedBoxes(
            probabilityTensor,
            manifest.detector,
            detectionInput.originalWidth,
            detectionInput.originalHeight,
            detectionInput.resizedWidth,
            detectionInput.resizedHeight,
        );

        console.debug(
            PaddleOnnxOcrBackend.logTag,
            `Detected ${detectedBoxes.length} candidate text regions`,
        );

        const mergedBoxes = detectedBoxes.length > 0
            ? mergeBoxesForPageSegMode(detectedBoxes, pageSegMode, sourceCanvas.width, sourceCanvas.height)
            : [];
        const segmentCandidates: OcrRecognitionCandidate[] = [];

        for (const [index, box] of mergedBoxes.entries()) {
            const cropCanvas = cropCanvasRegion(sourceCanvas, box, manifest.detector.box_padding);
            const attempt = await this.recognizeCrop(
                cropCanvas,
                recognizerSession,
                dictionary,
                manifest.recognizer,
                `box-${index}`,
            );

            if (attempt?.candidate?.cleanedText) {
                segmentCandidates.push(attempt.candidate);
            }
        }

        const combinedText = normalizeJoinedLines(segmentCandidates.map((candidate) => candidate.cleanedText));
        const combinedCandidate = combinedText
            ? buildOcrRecognitionCandidate(
                'detected-groups',
                combinedText,
                average(segmentCandidates.map((candidate) => candidate.confidence)),
                segmentCandidates.flatMap((candidate) => [candidate.averageSymbolConfidence]),
            )
            : null;
        const fallbackAttempt = await this.recognizeCrop(
            sourceCanvas,
            recognizerSession,
            dictionary,
            manifest.recognizer,
            'fallback',
        );
        const paddleCandidate = [combinedCandidate, fallbackAttempt?.candidate ?? null]
            .filter((candidate): candidate is OcrRecognitionCandidate => candidate !== null)
            .sort((left, right) => right.score - left.score)[0] ?? null;
        const shouldRunTesseractFallback = this.shouldUseTesseractFallback(paddleCandidate, pageSegMode);
        const tesseractCandidate = shouldRunTesseractFallback
            ? await this.runTesseractFallback(dataUrl, pageSegMode, model)
            : null;
        const finalCandidate = [paddleCandidate, tesseractCandidate]
            .filter((candidate): candidate is OcrRecognitionCandidate => candidate !== null)
            .sort((left, right) => right.score - left.score)[0] ?? null;

        console.debug(
            PaddleOnnxOcrBackend.logTag,
            'OCR candidates',
            {
                durationMs: Math.round(performance.now() - startedAt),
                paddle: paddleCandidate ? serializeOcrCandidate(paddleCandidate) : null,
                usedTesseractFallback: shouldRunTesseractFallback,
                tesseract: tesseractCandidate ? serializeOcrCandidate(tesseractCandidate) : null,
                selected: finalCandidate ? serializeOcrCandidate(finalCandidate) : null,
            },
        );

        if (finalCandidate?.cleanedText) {
            return finalCandidate.cleanedText;
        }

        console.debug(
            PaddleOnnxOcrBackend.logTag,
            'No usable OCR candidate was produced for the crop',
        );
        return undefined;
    }

    public async terminate(): Promise<void> {
        PaddleOnnxOcrBackend.sessions.clear();
        await PaddleOnnxOcrBackend.tesseractFallbackBackend.terminate();
    }

    private async recognizeCrop(
        cropCanvas: WorkingCanvas,
        recognizerSession: ort.InferenceSession,
        dictionary: string[],
        recognizerConfig: RecognizerConfig,
        id: string,
    ): Promise<RecognitionAttempt | null> {
        const attempts: RecognitionAttempt[] = [];
        const tallAspectRatio = cropCanvas.height / Math.max(cropCanvas.width, 1);
        const shouldRotate = tallAspectRatio >= recognizerConfig.rotation_aspect_threshold;

        if (shouldRotate) {
            const rotatedCanvas = rotateCanvasClockwise(cropCanvas);
            attempts.push({
                candidate: await this.runRecognition(rotatedCanvas, recognizerSession, dictionary, recognizerConfig, `${id}-rotated`),
                rotated: true,
            });
        }

        attempts.push({
            candidate: await this.runRecognition(cropCanvas, recognizerSession, dictionary, recognizerConfig, `${id}-plain`),
            rotated: false,
        });

        const bestAttempt = attempts
            .filter((attempt) => attempt.candidate !== null)
            .sort((left, right) => (right.candidate?.score ?? -Infinity) - (left.candidate?.score ?? -Infinity))[0] ?? null;

        if (bestAttempt?.candidate) {
            console.debug(
                PaddleOnnxOcrBackend.logTag,
                'Selected recognition candidate',
                {
                    ...serializeOcrCandidate(bestAttempt.candidate),
                    rotated: bestAttempt.rotated,
                },
            );
        }

        return bestAttempt;
    }

    private async runRecognition(
        sourceCanvas: WorkingCanvas,
        recognizerSession: ort.InferenceSession,
        dictionary: string[],
        recognizerConfig: RecognizerConfig,
        id: string,
    ): Promise<OcrRecognitionCandidate | null> {
        const tensor = prepareRecognitionTensor(sourceCanvas, recognizerConfig);
        const result = await recognizerSession.run({ x: tensor });
        const outputTensor = result[recognizerSession.outputNames[0]];
        return decodeRecognitionTensor(outputTensor, dictionary, id);
    }

    private async ensureDetectorSession(): Promise<ort.InferenceSession> {
        return this.ensureSession(
            PaddleOnnxOcrBackend.detectorSessionKey,
            async () => {
                const manifest = await this.getManifest();
                const sessionUrl = runtime.getURL(`libs/paddleocr/${manifest.detector.model_path}`);
                return ort.InferenceSession.create(sessionUrl, {
                    executionProviders: ['wasm'],
                    graphOptimizationLevel: 'all',
                });
            },
        );
    }

    private async ensureRecognizerSession(): Promise<ort.InferenceSession> {
        return this.ensureSession(
            PaddleOnnxOcrBackend.recognizerSessionKey,
            async () => {
                const manifest = await this.getManifest();
                const sessionUrl = runtime.getURL(`libs/paddleocr/${manifest.recognizer.model_path}`);
                return ort.InferenceSession.create(sessionUrl, {
                    executionProviders: ['wasm'],
                    graphOptimizationLevel: 'all',
                });
            },
        );
    }

    private async ensureSession(
        key: string,
        createSession: () => Promise<ort.InferenceSession>,
    ): Promise<ort.InferenceSession> {
        this.configureOnnxRuntime();

        const existingBundle = PaddleOnnxOcrBackend.sessions.get(key);
        if (existingBundle) {
            return existingBundle.session ?? existingBundle.promise;
        }

        const bundle: SessionBundle = {
            session: null,
            promise: createSession().then((session) => {
                bundle.session = session;
                return session;
            }).catch((error) => {
                PaddleOnnxOcrBackend.sessions.delete(key);
                throw error;
            }),
        };

        PaddleOnnxOcrBackend.sessions.set(key, bundle);
        return bundle.promise;
    }

    private configureOnnxRuntime() {
        if (PaddleOnnxOcrBackend.ortConfigured) {
            return;
        }

        ort.env.wasm.proxy = false;
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.wasmPaths = {
            mjs: runtime.getURL('libs/onnxruntime/ort-wasm-simd-threaded.mjs'),
            wasm: runtime.getURL('libs/onnxruntime/ort-wasm-simd-threaded.wasm'),
        };

        PaddleOnnxOcrBackend.ortConfigured = true;
    }

    private async getManifest(): Promise<PaddleOnnxManifest> {
        if (!PaddleOnnxOcrBackend.manifestPromise) {
            PaddleOnnxOcrBackend.manifestPromise = fetch(runtime.getURL('libs/paddleocr/manifest.json'))
                .then(async (response) => {
                    if (!response.ok) {
                        throw new Error(`Failed to load paddleocr manifest: ${response.status} ${response.statusText}`);
                    }

                    return response.json() as Promise<PaddleOnnxManifest>;
                });
        }

        return PaddleOnnxOcrBackend.manifestPromise;
    }

    private async getDictionary(): Promise<string[]> {
        if (!PaddleOnnxOcrBackend.dictionaryPromise) {
            PaddleOnnxOcrBackend.dictionaryPromise = this.getManifest()
                .then(async (manifest) => {
                    const response = await fetch(runtime.getURL(`libs/paddleocr/${manifest.recognizer.dict_path}`));
                    if (!response.ok) {
                        throw new Error(`Failed to load paddleocr dictionary: ${response.status} ${response.statusText}`);
                    }

                    const dictionaryBody = await response.text();
                    return dictionaryBody
                        .split(/\r?\n/u)
                        .map((line) => line.replace(/\r/u, ''))
                        .filter((line) => line.length > 0);
                });
        }

        return PaddleOnnxOcrBackend.dictionaryPromise;
    }

    private shouldUseTesseractFallback(
        paddleCandidate: OcrRecognitionCandidate | null,
        pageSegMode: PSM,
    ) {
        if (!paddleCandidate) {
            return true;
        }

        if (pageSegMode === PSM.SINGLE_BLOCK_VERT_TEXT) {
            return paddleCandidate.score < 130
                || paddleCandidate.japaneseRatio < 0.82
                || paddleCandidate.normalizedText.length < 3;
        }

        return paddleCandidate.score < 105
            || paddleCandidate.japaneseRatio < 0.65
            || paddleCandidate.normalizedText.length < 2;
    }

    private async runTesseractFallback(
        dataUrl: string,
        pageSegMode: PSM,
        model: string,
    ): Promise<OcrRecognitionCandidate | null> {
        const normalizedModel = this.normalizeModelName(model);

        try {
            return await PaddleOnnxOcrBackend.tesseractFallbackBackend.recognizeCandidate(
                dataUrl,
                pageSegMode,
                normalizedModel,
            );
        } catch (error) {
            console.warn(
                PaddleOnnxOcrBackend.logTag,
                `Fallback Tesseract OCR failed for model '${normalizedModel}'`,
                error,
            );
            return null;
        }
    }

    private normalizeModelName(model: string | undefined) {
        const trimmedModel = model?.trim();

        if (trimmedModel && /^[A-Za-z0-9_-]+$/.test(trimmedModel)) {
            return trimmedModel;
        }

        return DEFAULT_OCR_MODEL;
    }
}

function prepareDetectionTensor(sourceCanvas: WorkingCanvas, config: DetectorConfig) {
    const resizeInfo = computeDetectionSize(
        sourceCanvas.width,
        sourceCanvas.height,
        config.limit_side_len,
        config.limit_type,
        config.max_side_len,
    );
    const resizedCanvas = resizeCanvas(sourceCanvas, resizeInfo.width, resizeInfo.height, '#ffffff');
    const tensorData = imageToTensorData(resizedCanvas, config.mean, config.std);

    return {
        tensor: new ort.Tensor('float32', tensorData, [1, 3, resizeInfo.height, resizeInfo.width]),
        originalHeight: sourceCanvas.height,
        originalWidth: sourceCanvas.width,
        resizedHeight: resizeInfo.height,
        resizedWidth: resizeInfo.width,
    };
}

function prepareRecognitionTensor(sourceCanvas: WorkingCanvas, config: RecognizerConfig) {
    const aspectRatio = sourceCanvas.width / Math.max(sourceCanvas.height, 1);
    const unclampedWidth = Math.max(
        config.min_image_width,
        roundUp(Math.ceil(config.image_height * aspectRatio), 4),
    );
    const targetWidth = clamp(unclampedWidth, config.min_image_width, config.max_image_width);
    const drawWidth = clamp(Math.round(config.image_height * aspectRatio), 1, targetWidth);
    const resizedCanvas = createWorkingCanvas(targetWidth, config.image_height);
    const context = get2DContext(resizedCanvas);

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, targetWidth, config.image_height);
    context.drawImage(sourceCanvas, 0, 0, drawWidth, config.image_height);

    const tensorData = imageToTensorData(resizedCanvas, config.mean, config.std);
    return new ort.Tensor('float32', tensorData, [1, 3, config.image_height, targetWidth]);
}

function imageToTensorData(
    canvas: WorkingCanvas,
    mean: [number, number, number],
    std: [number, number, number],
): Float32Array {
    const context = get2DContext(canvas);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const channelSize = canvas.width * canvas.height;
    const tensorData = new Float32Array(channelSize * 3);

    for (let index = 0; index < channelSize; index += 1) {
        const sourceOffset = index * 4;
        const red = data[sourceOffset] / 255;
        const green = data[sourceOffset + 1] / 255;
        const blue = data[sourceOffset + 2] / 255;

        tensorData[index] = (red - mean[0]) / std[0];
        tensorData[channelSize + index] = (green - mean[1]) / std[1];
        tensorData[(channelSize * 2) + index] = (blue - mean[2]) / std[2];
    }

    return tensorData;
}

function computeDetectionSize(
    width: number,
    height: number,
    limitSideLen: number,
    limitType: 'min' | 'max',
    maxSideLen: number,
) {
    const minSide = Math.min(width, height);
    const maxSide = Math.max(width, height);

    let scale = 1;
    if (limitType === 'min' && minSide < limitSideLen) {
        scale = limitSideLen / Math.max(minSide, 1);
    } else if (limitType === 'max' && maxSide > limitSideLen) {
        scale = limitSideLen / Math.max(maxSide, 1);
    }

    if ((maxSide * scale) > maxSideLen) {
        scale = maxSideLen / Math.max(maxSide, 1);
    }

    return {
        width: Math.max(32, roundUp(Math.round(width * scale), 32)),
        height: Math.max(32, roundUp(Math.round(height * scale), 32)),
    };
}

function extractDetectedBoxes(
    probabilityTensor: ort.Tensor,
    config: DetectorConfig,
    originalWidth: number,
    originalHeight: number,
    resizedWidth: number,
    resizedHeight: number,
): DetectedBox[] {
    const probabilityData = probabilityTensor.data;
    if (!(probabilityData instanceof Float32Array)) {
        return [];
    }

    const width = probabilityTensor.dims[3] ?? resizedWidth;
    const height = probabilityTensor.dims[2] ?? resizedHeight;
    const binaryMask = dilateMask(
        createBinaryMask(probabilityData, width, height, config.threshold),
        width,
        height,
        config.dilation_radius,
    );
    const visited = new Uint8Array(width * height);
    const boxes: DetectedBox[] = [];
    const scaleX = originalWidth / Math.max(resizedWidth, 1);
    const scaleY = originalHeight / Math.max(resizedHeight, 1);
    const queue = new Int32Array(width * height);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const startIndex = (y * width) + x;
            if (binaryMask[startIndex] === 0 || visited[startIndex] === 1) {
                continue;
            }

            let queueStart = 0;
            let queueEnd = 0;
            queue[queueEnd++] = startIndex;
            visited[startIndex] = 1;

            let minX = x;
            let maxX = x;
            let minY = y;
            let maxY = y;
            let scoreSum = 0;
            let pixelCount = 0;

            while (queueStart < queueEnd) {
                const index = queue[queueStart++];
                const currentX = index % width;
                const currentY = Math.floor(index / width);

                minX = Math.min(minX, currentX);
                maxX = Math.max(maxX, currentX);
                minY = Math.min(minY, currentY);
                maxY = Math.max(maxY, currentY);
                scoreSum += probabilityData[index] ?? 0;
                pixelCount += 1;

                for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
                    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                        if (offsetX === 0 && offsetY === 0) {
                            continue;
                        }

                        const nextX = currentX + offsetX;
                        const nextY = currentY + offsetY;
                        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
                            continue;
                        }

                        const nextIndex = (nextY * width) + nextX;
                        if (binaryMask[nextIndex] === 0 || visited[nextIndex] === 1) {
                            continue;
                        }

                        visited[nextIndex] = 1;
                        queue[queueEnd++] = nextIndex;
                    }
                }
            }

            const averageScore = scoreSum / Math.max(pixelCount, 1);
            const boxWidth = maxX - minX + 1;
            const boxHeight = maxY - minY + 1;

            if (averageScore < config.box_score_threshold) {
                continue;
            }

            if (Math.max(boxWidth, boxHeight) < config.min_box_size) {
                continue;
            }

            const paddingX = Math.max(config.box_padding, Math.round(boxWidth * 0.08)) * scaleX;
            const paddingY = Math.max(config.box_padding, Math.round(boxHeight * 0.08)) * scaleY;
            const left = clamp(Math.floor((minX * scaleX) - paddingX), 0, originalWidth - 1);
            const top = clamp(Math.floor((minY * scaleY) - paddingY), 0, originalHeight - 1);
            const right = clamp(Math.ceil(((maxX + 1) * scaleX) + paddingX), left + 1, originalWidth);
            const bottom = clamp(Math.ceil(((maxY + 1) * scaleY) + paddingY), top + 1, originalHeight);

            const scaledWidth = right - left;
            const scaledHeight = bottom - top;

            if (Math.max(scaledWidth, scaledHeight) < config.min_box_size) {
                continue;
            }

            boxes.push({
                averageScore,
                bottom,
                centerX: left + (scaledWidth / 2),
                centerY: top + (scaledHeight / 2),
                height: scaledHeight,
                left,
                right,
                top,
                width: scaledWidth,
            });
        }
    }

    return boxes
        .sort((left, right) => right.averageScore - left.averageScore)
        .slice(0, 32);
}

function createBinaryMask(
    probabilityData: Float32Array,
    width: number,
    height: number,
    threshold: number,
) {
    const binaryMask = new Uint8Array(width * height);

    for (let index = 0; index < width * height; index += 1) {
        binaryMask[index] = probabilityData[index] >= threshold ? 1 : 0;
    }

    return binaryMask;
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number) {
    if (radius <= 0) {
        return mask;
    }

    const dilated = new Uint8Array(mask.length);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = (y * width) + x;
            if (mask[index] === 0) {
                continue;
            }

            for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
                for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
                    const nextX = x + offsetX;
                    const nextY = y + offsetY;

                    if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) {
                        continue;
                    }

                    dilated[(nextY * width) + nextX] = 1;
                }
            }
        }
    }

    return dilated;
}

function decodeRecognitionTensor(
    outputTensor: ort.Tensor,
    dictionary: string[],
    id: string,
) {
    const outputData = outputTensor.data;
    if (!(outputData instanceof Float32Array)) {
        return null;
    }

    const sequenceLength = outputTensor.dims[1] ?? 0;
    const classCount = outputTensor.dims[2] ?? 0;
    let previousIndex = -1;
    let text = '';
    const symbolConfidences: number[] = [];

    for (let step = 0; step < sequenceLength; step += 1) {
        const offset = step * classCount;
        let maxIndex = 0;
        let maxLogit = Number.NEGATIVE_INFINITY;

        for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
            const value = outputData[offset + classIndex] ?? Number.NEGATIVE_INFINITY;
            if (value > maxLogit) {
                maxLogit = value;
                maxIndex = classIndex;
            }
        }

        if (maxIndex === 0 || maxIndex === previousIndex) {
            previousIndex = maxIndex;
            continue;
        }

        const character = dictionary[maxIndex - 1];
        if (!character) {
            previousIndex = maxIndex;
            continue;
        }

        const confidence = computeSoftmaxConfidence(outputData, offset, classCount, maxLogit);
        text += character;
        symbolConfidences.push(confidence * 100);
        previousIndex = maxIndex;
    }

    const averageConfidence = symbolConfidences.length > 0
        ? symbolConfidences.reduce((sum, confidence) => sum + confidence, 0) / symbolConfidences.length
        : 0;

    return buildOcrRecognitionCandidate(
        id,
        text,
        averageConfidence,
        symbolConfidences,
    );
}

function computeSoftmaxConfidence(
    outputData: Float32Array,
    offset: number,
    classCount: number,
    maxLogit: number,
) {
    let sum = 0;

    for (let classIndex = 0; classIndex < classCount; classIndex += 1) {
        sum += Math.exp((outputData[offset + classIndex] ?? Number.NEGATIVE_INFINITY) - maxLogit);
    }

    return 1 / Math.max(sum, 1);
}

function mergeBoxesForPageSegMode(
    boxes: DetectedBox[],
    pageSegMode: PSM,
    imageWidth: number,
    imageHeight: number,
) {
    const orientation = inferReadingOrientation(boxes, pageSegMode, imageWidth, imageHeight);
    const groupingThreshold = orientation === 'vertical'
        ? Math.max(8, average(boxes.map((box) => box.width)) * 0.8)
        : Math.max(8, average(boxes.map((box) => box.height)) * 0.8);

    return buildAxisGroups(boxes, orientation, groupingThreshold)
        .map((group) => mergeDetectedBoxGroup(group));
}

function inferReadingOrientation(
    boxes: DetectedBox[],
    pageSegMode: PSM,
    imageWidth: number,
    imageHeight: number,
) {
    if (pageSegMode === PSM.SINGLE_BLOCK_VERT_TEXT) {
        return 'vertical' as const;
    }

    if (pageSegMode === PSM.SINGLE_BLOCK) {
        return 'horizontal' as const;
    }

    let verticalVotes = 0;
    let horizontalVotes = 0;

    for (const box of boxes) {
        if (box.height > (box.width * 1.2)) {
            verticalVotes += 1;
        } else if (box.width > (box.height * 1.2)) {
            horizontalVotes += 1;
        }
    }

    if (verticalVotes === horizontalVotes) {
        return imageHeight >= imageWidth ? 'vertical' as const : 'horizontal' as const;
    }

    return verticalVotes > horizontalVotes ? 'vertical' as const : 'horizontal' as const;
}

function buildAxisGroups(
    boxes: DetectedBox[],
    orientation: 'vertical' | 'horizontal',
    threshold: number,
) {
    const sortedBoxes = [...boxes].sort((left, right) => {
        if (orientation === 'vertical') {
            return right.centerX - left.centerX;
        }

        return left.centerY - right.centerY;
    });

    const groups: Array<{ center: number; items: DetectedBox[] }> = [];

    for (const box of sortedBoxes) {
        const axisValue = orientation === 'vertical' ? box.centerX : box.centerY;
        const targetGroup = groups.find((group) => Math.abs(group.center - axisValue) <= threshold);

        if (targetGroup) {
            targetGroup.items.push(box);
            targetGroup.center = average(
                targetGroup.items.map((item) => orientation === 'vertical' ? item.centerX : item.centerY),
            );
        } else {
            groups.push({
                center: axisValue,
                items: [box],
            });
        }
    }

    return groups
        .sort((left, right) => orientation === 'vertical'
            ? right.center - left.center
            : left.center - right.center)
        .map((group) => group.items.sort((left, right) => orientation === 'vertical'
            ? left.top - right.top
            : left.left - right.left));
}

function mergeDetectedBoxGroup(boxes: DetectedBox[]): DetectedBox {
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    const right = Math.max(...boxes.map((box) => box.right));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    const width = right - left;
    const height = bottom - top;

    return {
        averageScore: average(boxes.map((box) => box.averageScore)),
        bottom,
        centerX: left + (width / 2),
        centerY: top + (height / 2),
        height,
        left,
        right,
        top,
        width,
    };
}

function cropCanvasRegion(
    sourceCanvas: WorkingCanvas,
    box: DetectedBox,
    padding: number,
) {
    const left = clamp(box.left - padding, 0, sourceCanvas.width - 1);
    const top = clamp(box.top - padding, 0, sourceCanvas.height - 1);
    const right = clamp(box.right + padding, left + 1, sourceCanvas.width);
    const bottom = clamp(box.bottom + padding, top + 1, sourceCanvas.height);
    const width = right - left;
    const height = bottom - top;
    const cropCanvas = createWorkingCanvas(width, height);
    const context = get2DContext(cropCanvas);

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.drawImage(sourceCanvas, left, top, width, height, 0, 0, width, height);

    return cropCanvas;
}

function rotateCanvasClockwise(sourceCanvas: WorkingCanvas) {
    const rotatedCanvas = createWorkingCanvas(sourceCanvas.height, sourceCanvas.width);
    const context = get2DContext(rotatedCanvas);

    context.translate(rotatedCanvas.width, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(sourceCanvas, 0, 0);

    return rotatedCanvas;
}

async function canvasFromDataUrl(dataUrl: string) {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const imageBitmap = await createImageBitmap(blob);

    try {
        const canvas = createWorkingCanvas(imageBitmap.width, imageBitmap.height);
        const context = get2DContext(canvas);
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(imageBitmap, 0, 0);
        return canvas;
    } finally {
        imageBitmap.close();
    }
}

function resizeCanvas(
    sourceCanvas: WorkingCanvas,
    width: number,
    height: number,
    background: string,
) {
    const targetCanvas = createWorkingCanvas(width, height);
    const context = get2DContext(targetCanvas);

    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(sourceCanvas, 0, 0, width, height);

    return targetCanvas;
}

function createWorkingCanvas(width: number, height: number): WorkingCanvas {
    if (typeof OffscreenCanvas !== 'undefined') {
        return new OffscreenCanvas(width, height);
    }

    if (typeof document !== 'undefined') {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }

    throw new Error('Canvas support is unavailable for Paddle ONNX OCR.');
}

function get2DContext(canvas: WorkingCanvas): DrawingContext {
    const context = canvas.getContext('2d', {
        alpha: false,
        willReadFrequently: true,
    } as CanvasRenderingContext2DSettings) as DrawingContext | null;

    if (!context) {
        throw new Error('Could not acquire a 2D canvas context for Paddle ONNX OCR.');
    }

    return context;
}

function normalizeJoinedLines(lines: string[]) {
    const joinedText = lines
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join('\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();

    return joinedText || undefined;
}

function average(values: number[]) {
    if (values.length === 0) {
        return 0;
    }

    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundUp(value: number, factor: number) {
    return Math.ceil(value / factor) * factor;
}

function clamp(value: number, minValue: number, maxValue: number) {
    return Math.min(Math.max(value, minValue), maxValue);
}

export { PaddleOnnxOcrBackend as ConfiguredOcrBackend };
