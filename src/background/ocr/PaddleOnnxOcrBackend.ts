import { runtime } from 'webextension-polyfill';
import * as ort from 'onnxruntime-web';
import { PSM } from 'tesseract.js';
import type { OcrBackend } from './OcrBackend';
import { DEFAULT_OCR_MODEL } from '../../interfaces/Storage';
import { buildOcrRecognitionCandidate, serializeOcrCandidate, type OcrRecognitionCandidate } from './OcrTextScoring';
import type { OcrDebugCandidateSnapshot, OcrDebugCropSnapshot, OcrDebugSnapshot } from './OcrDebugSnapshot';

type WorkingCanvas = OffscreenCanvas | HTMLCanvasElement;
type DrawingContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

const PADDLE_ONNX_LOG_TAG = '[PaddleOnnxOcrBackend]';
const PADDLE_ONNX_MANIFEST_PATH = 'libs/paddleocr/paddleocr-manifest.json';
const PADDLE_OUTPUT_VARIANTS: Record<string, string> = {
    '亂': '乱',
    '來': '来',
    '兩': '両',
    '兒': '児',
    '關': '関',
    '處': '処',
    '劍': '剣',
    '區': '区',
    '參': '参',
    '變': '変',
    '國': '国',
    '圖': '図',
    '聲': '声',
    '學': '学',
    '實': '実',
    '寫': '写',
    '廣': '広',
    '應': '応',
    '戰': '戦',
    '數': '数',
    '樂': '楽',
    '氣': '気',
    '醫': '医',
    '圍': '囲',
    '畫': '画',
    '發': '発',
    '會': '会',
    '權': '権',
    '歡': '歓',
    '號': '号',
    '轉': '転',
    '书': '書',
    '关': '関',
    '图': '図',
    '处': '処',
    '实': '実',
    '应': '応',
    '战': '戦',
    '气': '気',
    '医': '医',
    '围': '囲',
    '权': '権',
    '欢': '歓',
    '转': '転',
    '达': '達',
    '时': '時',
    '门': '門',
};

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
    providerNames: string[];
    session: ort.InferenceSession | null;
    usesAcceleratedProvider: boolean;
};

type CreatedSession = {
    providerNames: string[];
    session: ort.InferenceSession;
    usesAcceleratedProvider: boolean;
};

type PreparedCanvas = {
    canvas: WorkingCanvas;
    inverted: boolean;
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
    canvas: WorkingCanvas;
    candidate: OcrRecognitionCandidate | null;
    id: string;
    normalized: boolean;
    rotated: boolean;
};

type CropRecognitionResult = {
    attempts: RecognitionAttempt[];
    candidate: OcrRecognitionCandidate | null;
};

type SegmentRecognitionTrace = {
    box: DetectedBox;
    cropCanvas: WorkingCanvas;
    result: CropRecognitionResult;
};

type SegmentRecognitionResult = {
    candidate: OcrRecognitionCandidate | null;
    segments: SegmentRecognitionTrace[];
};

type RecognizedSegment = {
    box: DetectedBox;
    candidate: OcrRecognitionCandidate;
    index: number;
};

type NavigatorWithHardwareAcceleration = Navigator & {
    gpu?: unknown;
    ml?: unknown;
};

const ACCELERATED_SESSION_INIT_TIMEOUT_MS = 20_000;
const ACCELERATED_INFERENCE_TIMEOUT_MS = 15_000;
const DISABLE_WASM_FALLBACK = __NAMIDA_PADDLE_ONNX_DISABLE_WASM_FALLBACK__;

export class PaddleOnnxOcrBackend implements OcrBackend {
    private static readonly logTag = PADDLE_ONNX_LOG_TAG;
    private static readonly detectorSessionKey = 'detector';
    private static readonly recognizerSessionKey = 'recognizer';
    private static readonly sessions = new Map<string, SessionBundle>();
    private static manifestPromise: Promise<PaddleOnnxManifest> | null = null;
    private static dictionaryPromise: Promise<string[]> | null = null;
    private static ortConfigured = false;
    private static readonly disableWasmFallback = DISABLE_WASM_FALLBACK;
    private static forceWasmOnly = false;
    private static gpuEnabled = true;
    private debugEnabled = false;
    private lastDebugSnapshot: OcrDebugSnapshot | null = null;

    public async init(): Promise<void> {
        await Promise.all([
            this.ensureRecognizerSession(),
            this.getDictionary(),
        ]);
    }

    public async setDebugEnabled(enabled: boolean): Promise<void> {
        this.debugEnabled = enabled;

        if (!enabled) {
            this.lastDebugSnapshot = null;
        }
    }

    public async setGpuEnabled(enabled: boolean): Promise<void> {
        if (PaddleOnnxOcrBackend.gpuEnabled === enabled) {
            return;
        }

        PaddleOnnxOcrBackend.gpuEnabled = enabled;
        PaddleOnnxOcrBackend.forceWasmOnly = false;
        PaddleOnnxOcrBackend.sessions.clear();
    }

    public async getLastDebugSnapshot(): Promise<OcrDebugSnapshot | null> {
        return this.lastDebugSnapshot;
    }

    public async recognize(dataUrl: string, pageSegMode: PSM, _model: string = DEFAULT_OCR_MODEL): Promise<string | undefined> {
        this.lastDebugSnapshot = null;
        const startedAt = performance.now();
        const manifest = await this.getManifest();
        const sourceCanvas = await canvasFromDataUrl(dataUrl);
        const workingCanvas = padCanvas(sourceCanvas, Math.max(8, manifest.detector.box_padding));
        const preparedWorkingCanvas = normalizeCanvasForOcr(workingCanvas);
        const recognizerSession = await this.ensureRecognizerSession();
        const dictionary = await this.getDictionary();
        const fullCropResult = await this.recognizeCrop(
            workingCanvas,
            preparedWorkingCanvas,
            recognizerSession,
            dictionary,
            manifest.recognizer,
            'full-crop',
            true,
        );
        const projectedPageSegMode = resolveProjectedPageSegMode(pageSegMode, workingCanvas);
        const projectedBoxes = projectedPageSegMode === null
            ? []
            : extractProjectedBoxes(
                preparedWorkingCanvas.canvas,
                projectedPageSegMode,
                manifest.detector.box_padding,
            );
        const projectedResult = await this.recognizeSegmentBoxes(
            workingCanvas,
            preparedWorkingCanvas.canvas,
            preparedWorkingCanvas.inverted,
            projectedBoxes,
            recognizerSession,
            dictionary,
            manifest.recognizer,
            'projected-groups',
        );
        const projectedCandidate = projectedResult.candidate;
        let detectedResult: SegmentRecognitionResult | null = null;
        let detectedCandidate: OcrRecognitionCandidate | null = null;

        {
            const detectorSession = await this.ensureDetectorSession();
            const detectedBoxes: DetectedBox[] = [];
            const preparedDetectedBoxes = await this.detectTextBoxes(
                detectorSession,
                preparedWorkingCanvas.canvas,
                manifest.detector,
            );
            detectedBoxes.push(...preparedDetectedBoxes);

            const originalDetectedBoxes = await this.detectTextBoxes(
                detectorSession,
                workingCanvas,
                manifest.detector,
            );
            detectedBoxes.push(...originalDetectedBoxes);

            console.debug(
                PaddleOnnxOcrBackend.logTag,
                `Detected ${detectedBoxes.length} candidate text regions`,
                {
                    original: originalDetectedBoxes.length,
                    prepared: preparedDetectedBoxes.length,
                },
            );

            const mergedBoxes = detectedBoxes.length > 0
                ? mergeBoxesForPageSegMode(detectedBoxes, pageSegMode, workingCanvas.width, workingCanvas.height)
                : [];
            detectedResult = await this.recognizeSegmentBoxes(
                workingCanvas,
                preparedWorkingCanvas.canvas,
                preparedWorkingCanvas.inverted,
                mergedBoxes,
                recognizerSession,
                dictionary,
                manifest.recognizer,
                'detected-groups',
            );
            detectedCandidate = detectedResult.candidate;
        }

        const paddleCandidate = chooseFinalCandidate([
            {
                candidate: projectedCandidate,
                source: 'projected',
            },
            {
                candidate: detectedCandidate,
                source: 'detected',
            },
            {
                candidate: fullCropResult.candidate,
                source: 'full',
            },
        ]);
        const finalCandidate = paddleCandidate;

        if (this.debugEnabled) {
            this.lastDebugSnapshot = await this.buildDebugSnapshot(
                workingCanvas,
                pageSegMode,
                fullCropResult,
                projectedResult,
                detectedResult,
                finalCandidate,
            );
        }

        console.debug(
            PaddleOnnxOcrBackend.logTag,
            'OCR candidates',
                {
                    durationMs: Math.round(performance.now() - startedAt),
                    projected: projectedCandidate ? serializeOcrCandidate(projectedCandidate) : null,
                    detected: detectedCandidate ? serializeOcrCandidate(detectedCandidate) : null,
                    paddle: paddleCandidate ? serializeOcrCandidate(paddleCandidate) : null,
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

    private async recognizeSegmentBoxes(
        sourceCanvas: WorkingCanvas,
        preparedSourceCanvas: WorkingCanvas,
        allowOriginalFallback: boolean,
        boxes: DetectedBox[],
        recognizerSession: ort.InferenceSession,
        dictionary: string[],
        recognizerConfig: RecognizerConfig,
        id: string,
    ): Promise<SegmentRecognitionResult> {
        const recognizedSegments: RecognizedSegment[] = [];
        const segments: SegmentRecognitionTrace[] = [];

        for (const [index, box] of boxes.entries()) {
            const cropCanvas = cropCanvasRegion(sourceCanvas, box, 0);
            const preparedCropCanvas = cropCanvasRegion(preparedSourceCanvas, box, 0);
            const allowMultiLineSplit = isVerticalMultiLineSplitCandidate(cropCanvas);
            const result = await this.recognizeCrop(
                cropCanvas,
                {
                    canvas: preparedCropCanvas,
                    inverted: allowOriginalFallback,
                },
                recognizerSession,
                dictionary,
                recognizerConfig,
                `${id}-box-${index}`,
                allowMultiLineSplit,
            );
            segments.push({ box, cropCanvas, result });

            if (result.candidate?.cleanedText && shouldIncludeSegmentCandidate(result.candidate)) {
                recognizedSegments.push({
                    box,
                    candidate: result.candidate,
                    index,
                });
            }
        }

        const segmentCandidates = selectDistinctSegmentCandidates(recognizedSegments);

        if (segmentCandidates.length === 0) {
            return {
                candidate: null,
                segments,
            };
        }

        if (segmentCandidates.length === 1) {
            return {
                candidate: segmentCandidates[0],
                segments,
            };
        }

        const combinedText = normalizeJoinedLines(segmentCandidates.map((candidate) => candidate.cleanedText));
        if (!combinedText) {
            return {
                candidate: null,
                segments,
            };
        }

        return {
            candidate: buildOcrRecognitionCandidate(
                id,
                combinedText,
                average(segmentCandidates.map((candidate) => candidate.confidence)),
                segmentCandidates.flatMap((candidate) => [candidate.averageSymbolConfidence]),
            ),
            segments,
        };
    }

    public async terminate(): Promise<void> {
        this.lastDebugSnapshot = null;
        PaddleOnnxOcrBackend.sessions.clear();
    }

    private async recognizeCrop(
        cropCanvas: WorkingCanvas,
        preparedCropCanvas: PreparedCanvas,
        recognizerSession: ort.InferenceSession,
        dictionary: string[],
        recognizerConfig: RecognizerConfig,
        id: string,
        allowMultiLineSplit: boolean,
    ): Promise<CropRecognitionResult> {
        const attempts: RecognitionAttempt[] = [];
        const dominantAspectRatio = Math.max(cropCanvas.width, cropCanvas.height)
            / Math.max(Math.min(cropCanvas.width, cropCanvas.height), 1);
        const shouldTryBinarized = preparedCropCanvas.inverted || dominantAspectRatio >= 3;
        const variants = [
            {
                canvas: preparedCropCanvas.canvas,
                normalized: true,
                suffix: 'prepared',
            },
            ...(shouldTryBinarized
                ? [{
                    canvas: binarizeCanvas(preparedCropCanvas.canvas),
                    normalized: true,
                    suffix: 'binarized',
                }]
                : []),
            {
                canvas: cropCanvas,
                normalized: false,
                suffix: 'original',
            },
        ];

        for (const variant of variants) {
            const tallAspectRatio = variant.canvas.height / Math.max(variant.canvas.width, 1);
            const shouldRotate = tallAspectRatio >= recognizerConfig.rotation_aspect_threshold;

            if (shouldRotate) {
                const rotatedCanvas = rotateCanvasCounterclockwise(variant.canvas);
                attempts.push({
                    canvas: rotatedCanvas,
                    candidate: refineRecognitionCandidate(
                        await this.runRecognition(
                            rotatedCanvas,
                            recognizerSession,
                            dictionary,
                            recognizerConfig,
                            `${id}-${variant.suffix}-rotated`,
                        ),
                        rotatedCanvas,
                    ),
                    id: `${id}-${variant.suffix}-rotated`,
                    normalized: variant.normalized,
                    rotated: true,
                });

                if (allowMultiLineSplit && variant.suffix === 'prepared') {
                    const splitLinesCandidate = await this.recognizeVerticalColumnCrop(
                        cropCanvas,
                        recognizerSession,
                        dictionary,
                        recognizerConfig,
                        `${id}-original-column-split`,
                    );

                    if (splitLinesCandidate) {
                        attempts.push({
                            canvas: rotatedCanvas,
                            candidate: splitLinesCandidate,
                            id: `${id}-${variant.suffix}-rotated-split`,
                            normalized: variant.normalized,
                            rotated: true,
                        });
                    }
                }
            }

            attempts.push({
                canvas: variant.canvas,
                candidate: refineRecognitionCandidate(
                    await this.runRecognition(
                        variant.canvas,
                        recognizerSession,
                        dictionary,
                        recognizerConfig,
                        `${id}-${variant.suffix}-plain`,
                    ),
                    variant.canvas,
                ),
                id: `${id}-${variant.suffix}-plain`,
                normalized: variant.normalized,
                rotated: false,
            });
        }

        const hasPlausibleRotatedAlternative = attempts.some((attempt) => (
            attempt.rotated
            && attempt.candidate !== null
            && attempt.candidate.normalizedText.length >= 2
            && attempt.candidate.japaneseRatio >= 0.5
            && attempt.candidate.score >= 18
        ));
        const bestAttempt = attempts
            .filter((attempt) => attempt.candidate !== null)
            .sort((left, right) => (
                rankRecognitionAttempt(right, dominantAspectRatio, hasPlausibleRotatedAlternative)
                - rankRecognitionAttempt(left, dominantAspectRatio, hasPlausibleRotatedAlternative)
            ))[0] ?? null;

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

        return {
            attempts,
            candidate: bestAttempt?.candidate ?? null,
        };
    }

    private async recognizeVerticalColumnCrop(
        sourceCanvas: WorkingCanvas,
        recognizerSession: ort.InferenceSession,
        dictionary: string[],
        recognizerConfig: RecognizerConfig,
        id: string,
    ): Promise<OcrRecognitionCandidate | null> {
        if (!isVerticalMultiLineSplitCandidate(sourceCanvas)) {
            return null;
        }

        const detectedColumnBoxes = extractVerticalTextColumns(sourceCanvas);
        const columnBoxSets = detectedColumnBoxes.length === 2
            ? [detectedColumnBoxes]
            : buildHeuristicVerticalSplitColumnSets(sourceCanvas);

        if (columnBoxSets.length === 0) {
            return null;
        }

        const cropPadding = Math.max(6, Math.round(sourceCanvas.width * 0.03));
        const splitCandidates: OcrRecognitionCandidate[] = [];

        for (const [setIndex, columnBoxes] of columnBoxSets.entries()) {
            const lineCandidates: OcrRecognitionCandidate[] = [];

            for (const [index, box] of columnBoxes.entries()) {
                const columnCanvas = cropCanvasRegion(sourceCanvas, box, cropPadding);
                const lineCanvas = rotateCanvasCounterclockwise(columnCanvas);
                const lineCandidate = refineRecognitionCandidate(
                    await this.runRecognition(
                        lineCanvas,
                        recognizerSession,
                        dictionary,
                        recognizerConfig,
                        `${id}-set-${setIndex}-line-${index}`,
                    ),
                    lineCanvas,
                );

                if (lineCandidate?.cleanedText && shouldIncludeLineCandidate(lineCandidate)) {
                    lineCandidates.push(lineCandidate);
                }
            }

            if (lineCandidates.length < 2) {
                continue;
            }

            const combinedText = normalizeJoinedLines(lineCandidates.map((candidate) => candidate.cleanedText));
            if (!combinedText) {
                continue;
            }

            const splitCandidate = refineRecognitionCandidate(
                buildOcrRecognitionCandidate(
                    `${id}-set-${setIndex}`,
                    combinedText,
                    average(lineCandidates.map((candidate) => candidate.confidence)),
                    lineCandidates.flatMap((candidate) => [candidate.averageSymbolConfidence]),
                ),
                rotateCanvasCounterclockwise(sourceCanvas),
            );

            if (splitCandidate) {
                splitCandidates.push(splitCandidate);
            }
        }

        return splitCandidates
            .sort((left, right) => right.score - left.score)[0] ?? null;
    }

    private async buildDebugSnapshot(
        workingCanvas: WorkingCanvas,
        pageSegMode: PSM,
        fullCropResult: CropRecognitionResult,
        projectedResult: SegmentRecognitionResult,
        detectedResult: SegmentRecognitionResult | null,
        finalCandidate: OcrRecognitionCandidate | null,
    ): Promise<OcrDebugSnapshot> {
        const workingImageDataUrl = await canvasToDataUrl(workingCanvas);

        return {
            backend: 'paddleonnx',
            candidates: {
                detected: serializeDebugCandidate(detectedResult?.candidate ?? null),
                fullCrop: serializeDebugCandidate(fullCropResult.candidate),
                projected: serializeDebugCandidate(projectedResult.candidate),
                selected: serializeDebugCandidate(finalCandidate),
            },
            createdAt: new Date().toISOString(),
            detectedGroups: await Promise.all(
                (detectedResult?.segments ?? []).map((segment, index) => this.buildDebugCropSnapshot(
                    'detector',
                    `detected-group-${index}`,
                    segment.cropCanvas,
                    segment.box,
                    segment.result,
                )),
            ),
            fullCrop: await this.buildDebugCropSnapshot(
                'full-crop',
                'full-crop',
                workingCanvas,
                null,
                fullCropResult,
                workingImageDataUrl,
            ),
            pageSegMode,
            projectedGroups: await Promise.all(
                projectedResult.segments.map((segment, index) => this.buildDebugCropSnapshot(
                    'projection',
                    `projected-group-${index}`,
                    segment.cropCanvas,
                    segment.box,
                    segment.result,
                )),
            ),
            workingImageDataUrl,
        };
    }

    private async buildDebugCropSnapshot(
        source: OcrDebugCropSnapshot['source'],
        id: string,
        cropCanvas: WorkingCanvas,
        box: DetectedBox | null,
        result: CropRecognitionResult,
        imageDataUrl?: string,
    ): Promise<OcrDebugCropSnapshot> {
        const selectedCandidate = result.candidate;

        return {
            attempts: await Promise.all(result.attempts.map(async (attempt) => ({
                candidate: serializeDebugCandidate(attempt.candidate),
                id: attempt.id,
                imageDataUrl: await canvasToDataUrl(attempt.canvas),
                normalized: attempt.normalized,
                rotated: attempt.rotated,
                selected: attempt.candidate !== null && attempt.candidate === selectedCandidate,
            }))),
            box: serializeDebugBox(box),
            id,
            imageDataUrl: imageDataUrl ?? await canvasToDataUrl(cropCanvas),
            selectedCandidate: serializeDebugCandidate(selectedCandidate),
            source,
        };
    }

    private async runRecognition(
        sourceCanvas: WorkingCanvas,
        recognizerSession: ort.InferenceSession,
        dictionary: string[],
        recognizerConfig: RecognizerConfig,
        id: string,
    ): Promise<OcrRecognitionCandidate | null> {
        const tensor = prepareRecognitionTensor(sourceCanvas, recognizerConfig);
        const result = await this.runSessionWithFallback(
            PaddleOnnxOcrBackend.recognizerSessionKey,
            recognizerSession,
            () => this.ensureRecognizerSession(),
            (session) => session.run({ x: tensor }),
        );
        const outputTensor = result[recognizerSession.outputNames[0]];
        return decodeRecognitionTensor(outputTensor, dictionary, id);
    }

    private async detectTextBoxes(
        detectorSession: ort.InferenceSession,
        sourceCanvas: WorkingCanvas,
        config: DetectorConfig,
    ): Promise<DetectedBox[]> {
        const detectionInput = prepareDetectionTensor(sourceCanvas, config);
        const detectionOutput = await this.runSessionWithFallback(
            PaddleOnnxOcrBackend.detectorSessionKey,
            detectorSession,
            () => this.ensureDetectorSession(),
            (session) => session.run({ x: detectionInput.tensor }),
        );
        const probabilityTensor = detectionOutput[detectorSession.outputNames[0]];
        return extractDetectedBoxes(
            probabilityTensor,
            config,
            detectionInput.originalWidth,
            detectionInput.originalHeight,
            detectionInput.resizedWidth,
            detectionInput.resizedHeight,
        );
    }

    private async ensureDetectorSession(): Promise<ort.InferenceSession> {
        return this.ensureSession(
            PaddleOnnxOcrBackend.detectorSessionKey,
            async () => {
                const manifest = await this.getManifest();
                const sessionUrl = runtime.getURL(`libs/paddleocr/${manifest.detector.model_path}`);
                return this.createSession(sessionUrl);
            },
        );
    }

    private async ensureRecognizerSession(): Promise<ort.InferenceSession> {
        return this.ensureSession(
            PaddleOnnxOcrBackend.recognizerSessionKey,
            async () => {
                const manifest = await this.getManifest();
                const sessionUrl = runtime.getURL(`libs/paddleocr/${manifest.recognizer.model_path}`);
                return this.createSession(sessionUrl);
            },
        );
    }

    private async createSession(sessionUrl: string): Promise<CreatedSession> {
        let lastError: unknown;
        const sessionOptionCandidates = getSessionOptionCandidates(
            PaddleOnnxOcrBackend.forceWasmOnly,
            PaddleOnnxOcrBackend.disableWasmFallback,
            PaddleOnnxOcrBackend.gpuEnabled,
        );

        if (sessionOptionCandidates.length === 0) {
            throw new Error('No accelerated ONNX execution provider is available and Paddle ONNX WASM fallback is disabled for this build.');
        }

        for (const sessionOptions of sessionOptionCandidates) {
            const providerNames = getExecutionProviderNames(sessionOptions.executionProviders);

            try {
                const session = await withTimeout(
                    ort.InferenceSession.create(sessionUrl, sessionOptions),
                    includesAcceleratedProvider(sessionOptions.executionProviders)
                        ? ACCELERATED_SESSION_INIT_TIMEOUT_MS
                        : 0,
                    () => new Error(`Timed out creating ONNX session with providers: ${providerNames.join(', ')}`),
                );

                return {
                    providerNames,
                    session,
                    usesAcceleratedProvider: includesAcceleratedProvider(sessionOptions.executionProviders),
                };
            } catch (error) {
                lastError = error;
                console.warn(
                    PaddleOnnxOcrBackend.logTag,
                    'Failed to create ONNX session',
                    {
                        error,
                        providers: providerNames,
                        sessionUrl,
                    },
                );
            }
        }

        throw lastError ?? new Error(`Failed to create ONNX session for ${sessionUrl}`);
    }

    private async runSessionWithFallback<T>(
        sessionKey: string,
        session: ort.InferenceSession,
        ensureSession: () => Promise<ort.InferenceSession>,
        runInference: (activeSession: ort.InferenceSession) => Promise<T>,
    ): Promise<T> {
        let activeSession = await this.resolveActiveSession(sessionKey, session, ensureSession);
        let hasRetriedWithWasm = false;

        while (true) {
            try {
                return await withTimeout(
                    runInference(activeSession),
                    this.getInferenceTimeoutMs(sessionKey, activeSession),
                    () => new Error(`Timed out running ONNX inference with accelerated provider for ${sessionKey}`),
                );
            } catch (error) {
                if (
                    PaddleOnnxOcrBackend.disableWasmFallback
                    || !shouldFallbackToWasm(error)
                    || hasRetriedWithWasm
                    || !this.isAcceleratedSession(sessionKey, activeSession)
                ) {
                    throw error;
                }

                console.warn(
                    PaddleOnnxOcrBackend.logTag,
                    'Disabling accelerated execution provider after runtime failure',
                    {
                        error,
                        sessionKey,
                    },
                );

                PaddleOnnxOcrBackend.forceWasmOnly = true;
                PaddleOnnxOcrBackend.sessions.clear();
                activeSession = await ensureSession();
                hasRetriedWithWasm = true;
            }
        }
    }

    private async ensureSession(
        key: string,
        createSession: () => Promise<CreatedSession>,
    ): Promise<ort.InferenceSession> {
        this.configureOnnxRuntime();

        const existingBundle = PaddleOnnxOcrBackend.sessions.get(key);
        if (existingBundle) {
            return existingBundle.session ?? existingBundle.promise;
        }

        const bundle: SessionBundle = {
            providerNames: [],
            session: null,
            usesAcceleratedProvider: false,
            promise: createSession().then((createdSession) => {
                bundle.providerNames = createdSession.providerNames;
                bundle.session = createdSession.session;
                bundle.usesAcceleratedProvider = createdSession.usesAcceleratedProvider;
                console.info(
                    PaddleOnnxOcrBackend.logTag,
                    'Initialized ONNX session',
                    {
                        accelerated: createdSession.usesAcceleratedProvider,
                        providers: createdSession.providerNames,
                        sessionKey: key,
                        wasmFallbackDisabled: PaddleOnnxOcrBackend.disableWasmFallback,
                        wasmOnly: PaddleOnnxOcrBackend.forceWasmOnly,
                    },
                );
                return createdSession.session;
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

        if (PaddleOnnxOcrBackend.disableWasmFallback) {
            console.info(
                PaddleOnnxOcrBackend.logTag,
                'Paddle ONNX WASM fallback is disabled for this build; accelerated provider failures will be fatal.',
            );
        }

        ort.env.wasm.proxy = false;
        ort.env.wasm.wasmPaths = {
            mjs: runtime.getURL('libs/onnxruntime/ort-wasm-simd-threaded.jsep.mjs'),
            wasm: runtime.getURL('libs/onnxruntime/ort-wasm-simd-threaded.jsep.wasm'),
        };

        PaddleOnnxOcrBackend.ortConfigured = true;
    }

    private getInferenceTimeoutMs(sessionKey: string, session: ort.InferenceSession): number {
        return this.isAcceleratedSession(sessionKey, session)
            ? ACCELERATED_INFERENCE_TIMEOUT_MS
            : 0;
    }

    private async resolveActiveSession(
        sessionKey: string,
        session: ort.InferenceSession,
        ensureSession: () => Promise<ort.InferenceSession>,
    ): Promise<ort.InferenceSession> {
        const bundle = PaddleOnnxOcrBackend.sessions.get(sessionKey);

        if (bundle?.session) {
            return bundle.session;
        }

        if (PaddleOnnxOcrBackend.forceWasmOnly) {
            return ensureSession();
        }

        return session;
    }

    private isAcceleratedSession(sessionKey: string, session: ort.InferenceSession): boolean {
        const bundle = PaddleOnnxOcrBackend.sessions.get(sessionKey);

        if (!bundle || bundle.session !== session) {
            return true;
        }

        return bundle.usesAcceleratedProvider;
    }

    private async getManifest(): Promise<PaddleOnnxManifest> {
        if (!PaddleOnnxOcrBackend.manifestPromise) {
            PaddleOnnxOcrBackend.manifestPromise = fetch(runtime.getURL(PADDLE_ONNX_MANIFEST_PATH))
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

}

function getSessionOptionCandidates(
    forceWasmOnly: boolean,
    disableWasmFallback: boolean,
    gpuEnabled: boolean,
): ort.InferenceSession.SessionOptions[] {
    if (!gpuEnabled) {
        return disableWasmFallback
            ? []
            : [
                buildSessionOptions([{ name: 'wasm' }]),
            ];
    }

    if (forceWasmOnly && !disableWasmFallback) {
        return [
            buildSessionOptions([{ name: 'wasm' }]),
        ];
    }

    const browserNavigator = getNavigatorWithHardwareAcceleration();
    const candidates: ort.InferenceSession.SessionOptions[] = [];

    if (browserNavigator?.gpu) {
        candidates.push(buildSessionOptions([{ name: 'webgpu' }]));
    }

    if (browserNavigator?.ml) {
        candidates.push(buildSessionOptions([{ 
            deviceType: 'gpu',
            name: 'webnn',
            powerPreference: 'high-performance',
        }]));
    }

    if (!disableWasmFallback) {
        candidates.push(buildSessionOptions([{ name: 'wasm' }]));
    }

    return candidates;
}

function buildSessionOptions(
    executionProviders: readonly ort.InferenceSession.ExecutionProviderConfig[],
): ort.InferenceSession.SessionOptions {
    return {
        executionProviders,
        graphOptimizationLevel: 'all',
    };
}

function includesAcceleratedProvider(
    executionProviders: readonly ort.InferenceSession.ExecutionProviderConfig[] | undefined,
): boolean {
    return getExecutionProviderNames(executionProviders).some((providerName) => providerName !== 'wasm');
}

function getExecutionProviderNames(
    executionProviders: readonly ort.InferenceSession.ExecutionProviderConfig[] | undefined,
): string[] {
    return (executionProviders ?? []).map((provider) => typeof provider === 'string' ? provider : provider.name);
}

function getNavigatorWithHardwareAcceleration(): NavigatorWithHardwareAcceleration | null {
    if (typeof navigator === 'undefined') {
        return null;
    }

    return navigator as NavigatorWithHardwareAcceleration;
}

function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    createError: () => Error,
): Promise<T> {
    if (timeoutMs <= 0) {
        return promise;
    }

    return new Promise<T>((resolve, reject) => {
        const timeoutId = globalThis.setTimeout(() => {
            reject(createError());
        }, timeoutMs);

        promise.then(
            (value) => {
                globalThis.clearTimeout(timeoutId);
                resolve(value);
            },
            (error) => {
                globalThis.clearTimeout(timeoutId);
                reject(error);
            },
        );
    });
}

function shouldFallbackToWasm(error: unknown): boolean {
    const errorText = error instanceof Error
        ? `${error.message}\n${error.stack ?? ''}`
        : String(error);

    return errorText.includes('Timed out running ONNX inference with accelerated provider')
        || errorText.includes('using ceil() in shape computation is not yet supported for MaxPool')
        || (errorText.includes('MaxPool') && errorText.includes('not yet supported'));
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
        .slice(0, 24);
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

function dilateMaskRect(
    mask: Uint8Array,
    width: number,
    height: number,
    radiusX: number,
    radiusY: number,
) {
    if (radiusX <= 0 && radiusY <= 0) {
        return mask;
    }

    const dilated = new Uint8Array(mask.length);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = (y * width) + x;
            if (mask[index] === 0) {
                continue;
            }

            for (let offsetY = -radiusY; offsetY <= radiusY; offsetY += 1) {
                for (let offsetX = -radiusX; offsetX <= radiusX; offsetX += 1) {
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
        normalizePaddleOutputText(text),
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

function normalizePaddleOutputText(text: string) {
    return text
        .replace(/[亂來兩兒關處劍區參變國圖聲學實寫廣應戰數樂氣醫圍畫發會權歡號轉书关图处实应战气医围权欢转达时门]/gu, (char) => (
            PADDLE_OUTPUT_VARIANTS[char] ?? char
        ))
        .replace(/(?<=[々〆ヶぁ-ゖァ-ヺ一-龯])[-ｰ](?=[々〆ヶぁ-ゖァ-ヺ一-龯])/gu, 'ー');
}

function refineRecognitionCandidate(
    candidate: OcrRecognitionCandidate | null,
    sourceCanvas: WorkingCanvas,
): OcrRecognitionCandidate | null {
    if (!candidate) {
        return null;
    }

    const textLength = candidate.normalizedText.length;
    const asciiLetterCount = (candidate.normalizedText.match(/[A-Za-z]/g) ?? []).length;
    const digitCount = (candidate.normalizedText.match(/[0-9]/g) ?? []).length;
    const lineAspectRatio = Math.max(sourceCanvas.width, sourceCanvas.height)
        / Math.max(Math.min(sourceCanvas.width, sourceCanvas.height), 1);
    const nonJapaneseCount = Math.max(
        0,
        textLength - Math.round(candidate.japaneseRatio * textLength),
    );

    let adjustedScore = candidate.score;

    if (textLength <= 2 && candidate.japaneseRatio === 0) {
        adjustedScore -= 28;
    }

    if (textLength <= 3 && (asciiLetterCount + digitCount) === textLength) {
        adjustedScore -= 22;
    }

    if (lineAspectRatio >= 18 && textLength <= 1) {
        adjustedScore -= 24;
    }

    adjustedScore -= digitCount * 6;
    adjustedScore -= Math.max(0, asciiLetterCount - 1) * 4;
    adjustedScore -= Math.max(0, nonJapaneseCount - 1) * 1.5;

    if (lineAspectRatio >= 4 && textLength < 3) {
        adjustedScore -= 10;
    }

    if (lineAspectRatio >= 8 && textLength < 2) {
        adjustedScore -= 18;
    }

    if (lineAspectRatio >= 14 && textLength < 3) {
        adjustedScore -= 12;
    }

    if (lineAspectRatio >= 20 && textLength < 4) {
        adjustedScore -= 8;
    }

    if (candidate.japaneseRatio < 0.34 && textLength <= 3) {
        adjustedScore -= 10;
    }

    return {
        ...candidate,
        score: adjustedScore,
    };
}

function shouldIncludeSegmentCandidate(candidate: OcrRecognitionCandidate) {
    return candidate.score >= 10
        || (candidate.japaneseRatio >= 0.75 && candidate.normalizedText.length >= 2);
}

function shouldIncludeLineCandidate(candidate: OcrRecognitionCandidate) {
    return candidate.score >= 14
        || (candidate.japaneseRatio >= 0.8 && candidate.normalizedText.length >= 4);
}

function selectDistinctSegmentCandidates(segments: RecognizedSegment[]) {
    const selected: RecognizedSegment[] = [];

    for (const segment of segments) {
        let merged = false;

        for (let index = 0; index < selected.length; index += 1) {
            const existing = selected[index];
            if (computeOverlapCoverage(segment.box, existing.box) < 0.72) {
                continue;
            }

            if (rankOverlappingSegmentCandidate(segment) >= rankOverlappingSegmentCandidate(existing)) {
                selected[index] = segment;
            }

            merged = true;
            break;
        }

        if (!merged) {
            selected.push(segment);
        }
    }

    return selected
        .sort((left, right) => left.index - right.index)
        .map((segment) => segment.candidate);
}

function rankOverlappingSegmentCandidate(segment: RecognizedSegment) {
    const normalizedTextLength = segment.candidate.normalizedText.length;
    const area = segment.box.width * segment.box.height;
    return segment.candidate.score
        + Math.min(normalizedTextLength, 16) * 0.75
        + Math.log10(Math.max(area, 10));
}

function computeOverlapCoverage(left: DetectedBox, right: DetectedBox) {
    const intersectionLeft = Math.max(left.left, right.left);
    const intersectionTop = Math.max(left.top, right.top);
    const intersectionRight = Math.min(left.right, right.right);
    const intersectionBottom = Math.min(left.bottom, right.bottom);
    const intersectionWidth = Math.max(0, intersectionRight - intersectionLeft);
    const intersectionHeight = Math.max(0, intersectionBottom - intersectionTop);
    const intersectionArea = intersectionWidth * intersectionHeight;

    if (intersectionArea === 0) {
        return 0;
    }

    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    return intersectionArea / Math.max(1, Math.min(leftArea, rightArea));
}

function chooseFinalCandidate(
    candidates: Array<{
        candidate: OcrRecognitionCandidate | null;
        source: 'detected' | 'full' | 'projected';
    }>,
) {
    return candidates
        .filter((entry): entry is { candidate: OcrRecognitionCandidate; source: 'detected' | 'full' | 'projected' } => (
            entry.candidate !== null
        ))
        .sort((left, right) => rankSourceCandidate(right) - rankSourceCandidate(left))[0]
        ?.candidate ?? null;
}

function rankSourceCandidate(
    entry: {
        candidate: OcrRecognitionCandidate;
        source: 'detected' | 'full' | 'projected';
    },
) {
    const sourceBonus = entry.source === 'detected'
        ? 3
        : entry.source === 'projected'
            ? 2
            : 0;

    return entry.candidate.score + sourceBonus;
}

function rankRecognitionAttempt(
    attempt: RecognitionAttempt,
    sourceAspectRatio: number,
    hasPlausibleRotatedAlternative: boolean,
) {
    const candidate = attempt.candidate;
    const candidateScore = candidate?.score ?? Number.NEGATIVE_INFINITY;
    const binarizedPenalty = attempt.id.includes('-binarized-') ? 2 : 0;
    let adjustedScore = candidateScore - binarizedPenalty;

    if (
        candidate
        && !attempt.rotated
        && hasPlausibleRotatedAlternative
        && sourceAspectRatio >= 2.2
        && candidate.normalizedText.length <= 1
    ) {
        adjustedScore -= 14;
    }

    return adjustedScore;
}

function mergeBoxesForPageSegMode(
    boxes: DetectedBox[],
    pageSegMode: PSM,
    imageWidth: number,
    imageHeight: number,
) {
    const orientation = inferReadingOrientation(boxes, pageSegMode, imageWidth, imageHeight);
    const groupingThreshold = orientation === 'vertical'
        ? Math.max(8, average(boxes.map((box) => box.width)) * 0.55)
        : Math.max(8, average(boxes.map((box) => box.height)) * 0.55);

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

function rotateCanvasCounterclockwise(sourceCanvas: WorkingCanvas) {
    const rotatedCanvas = createWorkingCanvas(sourceCanvas.height, sourceCanvas.width);
    const context = get2DContext(rotatedCanvas);

    context.translate(0, rotatedCanvas.height);
    context.rotate(-Math.PI / 2);
    context.drawImage(sourceCanvas, 0, 0);

    return rotatedCanvas;
}

function padCanvas(
    sourceCanvas: WorkingCanvas,
    padding: number,
    background = '#ffffff',
) {
    if (padding <= 0) {
        return sourceCanvas;
    }

    const paddedCanvas = createWorkingCanvas(
        sourceCanvas.width + (padding * 2),
        sourceCanvas.height + (padding * 2),
    );
    const context = get2DContext(paddedCanvas);

    context.fillStyle = background;
    context.fillRect(0, 0, paddedCanvas.width, paddedCanvas.height);
    context.drawImage(sourceCanvas, padding, padding);

    return paddedCanvas;
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

function normalizeCanvasForOcr(sourceCanvas: WorkingCanvas): PreparedCanvas {
    const width = sourceCanvas.width;
    const height = sourceCanvas.height;
    const sourceContext = get2DContext(sourceCanvas);
    const imageData = sourceContext.getImageData(0, 0, width, height);
    const { data } = imageData;
    const borderSize = Math.max(2, Math.round(Math.min(width, height) * 0.08));
    let minLuma = 255;
    let maxLuma = 0;
    let totalLuma = 0;
    let borderLuma = 0;
    let borderPixelCount = 0;

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const offset = ((y * width) + x) * 4;
            const luma = (
                (data[offset] * 0.299)
                + (data[offset + 1] * 0.587)
                + (data[offset + 2] * 0.114)
            );

            minLuma = Math.min(minLuma, luma);
            maxLuma = Math.max(maxLuma, luma);
            totalLuma += luma;

            if (
                x < borderSize
                || y < borderSize
                || x >= (width - borderSize)
                || y >= (height - borderSize)
            ) {
                borderLuma += luma;
                borderPixelCount += 1;
            }
        }
    }

    const averageLuma = totalLuma / Math.max(width * height, 1);
    const averageBorderLuma = borderLuma / Math.max(borderPixelCount, 1);
    const invert = averageBorderLuma < 140 || (averageLuma < 120 && maxLuma > 190);
    const lumaRange = Math.max(maxLuma - minLuma, 1);
    const normalizedCanvas = createWorkingCanvas(width, height);
    const normalizedContext = get2DContext(normalizedCanvas);

    for (let offset = 0; offset < data.length; offset += 4) {
        const luma = (
            (data[offset] * 0.299)
            + (data[offset + 1] * 0.587)
            + (data[offset + 2] * 0.114)
        );
        let normalized = ((luma - minLuma) * 255) / lumaRange;

        if (invert) {
            normalized = 255 - normalized;
        }

        const clamped = clamp(Math.round(normalized), 0, 255);
        data[offset] = clamped;
        data[offset + 1] = clamped;
        data[offset + 2] = clamped;
        data[offset + 3] = 255;
    }

    normalizedContext.putImageData(imageData, 0, 0);
    return {
        canvas: normalizedCanvas,
        inverted: invert,
    };
}

function binarizeCanvas(sourceCanvas: WorkingCanvas) {
    const width = sourceCanvas.width;
    const height = sourceCanvas.height;
    const context = get2DContext(sourceCanvas);
    const imageData = context.getImageData(0, 0, width, height);
    const { data } = imageData;
    const histogram = new Uint32Array(256);

    for (let offset = 0; offset < data.length; offset += 4) {
        histogram[data[offset]] += 1;
    }

    const threshold = computeOtsuThreshold(histogram, width * height);
    const binarizedCanvas = createWorkingCanvas(width, height);
    const binarizedContext = get2DContext(binarizedCanvas);

    for (let offset = 0; offset < data.length; offset += 4) {
        const value = data[offset] <= threshold ? 0 : 255;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
    }

    binarizedContext.putImageData(imageData, 0, 0);
    return binarizedCanvas;
}

function computeOtsuThreshold(histogram: Uint32Array, totalPixels: number) {
    let totalSum = 0;

    for (let value = 0; value < histogram.length; value += 1) {
        totalSum += value * histogram[value];
    }

    let sumBackground = 0;
    let weightBackground = 0;
    let maxVariance = -1;
    let threshold = 127;

    for (let value = 0; value < histogram.length; value += 1) {
        weightBackground += histogram[value];
        if (weightBackground === 0) {
            continue;
        }

        const weightForeground = totalPixels - weightBackground;
        if (weightForeground === 0) {
            break;
        }

        sumBackground += value * histogram[value];
        const meanBackground = sumBackground / weightBackground;
        const meanForeground = (totalSum - sumBackground) / weightForeground;
        const meanDifference = meanBackground - meanForeground;
        const variance = weightBackground * weightForeground * meanDifference * meanDifference;

        if (variance > maxVariance) {
            maxVariance = variance;
            threshold = value;
        }
    }

    return threshold;
}

async function canvasToDataUrl(canvas: WorkingCanvas) {
    if ('convertToBlob' in canvas) {
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return blobToDataUrl(blob);
    }

    return canvas.toDataURL('image/png');
}

async function blobToDataUrl(blob: Blob) {
    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';

    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }

    return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
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

function extractProjectedBoxes(
    sourceCanvas: WorkingCanvas,
    pageSegMode: PSM,
    padding: number,
) {
    const orientation = pageSegMode === PSM.SINGLE_BLOCK ? 'horizontal' : 'vertical';
    const binarizedCanvas = binarizeCanvas(sourceCanvas);
    const projectionMask = createProjectionMask(binarizedCanvas);
    const dilatedMask = dilateMaskRect(
        projectionMask,
        sourceCanvas.width,
        sourceCanvas.height,
        orientation === 'vertical'
            ? clamp(Math.round(sourceCanvas.width * 0.03), 2, 14)
            : clamp(Math.round(sourceCanvas.width * 0.012), 1, 8),
        orientation === 'vertical'
            ? clamp(Math.round(sourceCanvas.height * 0.015), 2, 12)
            : clamp(Math.round(sourceCanvas.height * 0.03), 2, 14),
    );
    const componentBoxes = extractMaskBoxes(
        dilatedMask,
        sourceCanvas.width,
        sourceCanvas.height,
        orientation === 'vertical'
            ? Math.max(6, Math.round(sourceCanvas.width * 0.02))
            : Math.max(24, Math.round(sourceCanvas.width * 0.12)),
        orientation === 'vertical'
            ? Math.max(24, Math.round(sourceCanvas.height * 0.12))
            : Math.max(6, Math.round(sourceCanvas.height * 0.02)),
    );

    if (componentBoxes.length === 0) {
        return [] satisfies DetectedBox[];
    }
    const mergedBoxes = mergeBoxesForPageSegMode(
        componentBoxes,
        pageSegMode,
        sourceCanvas.width,
        sourceCanvas.height,
    );
    const axisLength = orientation === 'vertical' ? sourceCanvas.width : sourceCanvas.height;
    const minimumAxisSize = Math.max(
        padding * 6,
        Math.round(axisLength * 0.14),
        Math.round(axisLength / Math.max(mergedBoxes.length * 2.4, 1)),
    );
    const boxes = mergedBoxes
        .map((box) => expandProjectedComponentBox(
            box,
            orientation,
            sourceCanvas.width,
            sourceCanvas.height,
            padding,
            minimumAxisSize,
        ))
        .sort((left, right) => orientation === 'vertical'
            ? right.centerX - left.centerX
            : left.centerY - right.centerY);

    console.debug(
        PADDLE_ONNX_LOG_TAG,
        `Projected ${boxes.length} text groups from the crop`,
        { orientation },
    );

    return boxes.slice(0, 12);
}

function extractVerticalTextColumns(sourceCanvas: WorkingCanvas) {
    const width = sourceCanvas.width;
    const height = sourceCanvas.height;
    if (width < 48 || height < 24) {
        return [] satisfies DetectedBox[];
    }

    const binarizedCanvas = binarizeCanvas(sourceCanvas);
    const context = get2DContext(binarizedCanvas);
    const { data } = context.getImageData(0, 0, width, height);
    const columnInkCounts = new Uint16Array(width);

    for (let x = 0; x < width; x += 1) {
        let inkCount = 0;

        for (let y = 0; y < height; y += 1) {
            const offset = ((y * width) + x) * 4;
            if (data[offset] < 128) {
                inkCount += 1;
            }
        }

        columnInkCounts[x] = inkCount;
    }

    const peakInk = columnInkCounts.reduce((maxInk, inkCount) => Math.max(maxInk, inkCount), 0);
    const minimumInk = Math.max(
        12,
        Math.round(height * 0.05),
        Math.round(peakInk * 0.12),
    );
    const maxBridgeGap = Math.max(1, Math.round(width * 0.003));
    const padding = Math.max(4, Math.round(width * 0.025));
    const minimumColumnWidth = Math.max(18, Math.round(width * 0.12));
    const columns: Array<{ left: number; right: number }> = [];
    let activeLeft = -1;
    let lastInkColumn = -1;

    for (let x = 0; x < width; x += 1) {
        if (columnInkCounts[x] >= minimumInk) {
            if (activeLeft === -1) {
                activeLeft = x;
            }
            lastInkColumn = x;
            continue;
        }

        if (activeLeft === -1 || lastInkColumn === -1) {
            continue;
        }

        if ((x - lastInkColumn) <= maxBridgeGap) {
            continue;
        }

        columns.push({
            left: activeLeft,
            right: lastInkColumn + 1,
        });
        activeLeft = -1;
        lastInkColumn = -1;
    }

    if (activeLeft !== -1 && lastInkColumn !== -1) {
        columns.push({
            left: activeLeft,
            right: lastInkColumn + 1,
        });
    }

    let filteredColumns = columns
        .map((column) => ({
            left: clamp(column.left - padding, 0, width - 1),
            right: clamp(column.right + padding, 1, width),
        }))
        .filter((column) => (column.right - column.left) >= minimumColumnWidth);

    if (filteredColumns.length !== 2) {
        filteredColumns = splitVerticalColumnsByValley(
            columnInkCounts,
            width,
            height,
            peakInk,
            padding,
            minimumColumnWidth,
        );
    }

    if (filteredColumns.length !== 2) {
        filteredColumns = splitVerticalColumnsByLocalBands(
            data,
            width,
            height,
            padding,
            minimumColumnWidth,
        );
    }

    if (filteredColumns.length !== 2) {
        return [] satisfies DetectedBox[];
    }

    const sortedColumns = [...filteredColumns].sort((left, right) => left.left - right.left);
    const columnGap = sortedColumns[1].left - sortedColumns[0].right;
    const leftColumnWidth = sortedColumns[0].right - sortedColumns[0].left;
    const rightColumnWidth = sortedColumns[1].right - sortedColumns[1].left;
    const maxColumnWidth = Math.max(leftColumnWidth, rightColumnWidth);
    const minColumnWidth = Math.max(1, Math.min(leftColumnWidth, rightColumnWidth));

    if (columnGap < Math.max(6, Math.round(width * 0.04))) {
        return [] satisfies DetectedBox[];
    }

    if ((maxColumnWidth / minColumnWidth) > 2.4) {
        return [] satisfies DetectedBox[];
    }

    const occupiedWidth = filteredColumns.reduce((sum, column) => sum + (column.right - column.left), 0);

    if (occupiedWidth > Math.round(width * 0.88)) {
        return [] satisfies DetectedBox[];
    }

    return filteredColumns
        .sort((left, right) => right.left - left.left)
        .map((column) => createDetectedBox(column.left, 0, column.right, height));
}

function isVerticalMultiLineSplitCandidate(sourceCanvas: WorkingCanvas) {
    return sourceCanvas.height >= Math.round(sourceCanvas.width * 1.35);
}

function splitVerticalColumnsByValley(
    columnInkCounts: Uint16Array,
    width: number,
    height: number,
    peakInk: number,
    padding: number,
    minimumColumnWidth: number,
) {
    if (width < 96 || peakInk <= 0) {
        return [] satisfies Array<{ left: number; right: number }>;
    }

    const smoothingRadius = clamp(Math.round(width * 0.01), 2, 8);
    const smoothedCounts = new Float32Array(width);

    for (let x = 0; x < width; x += 1) {
        let sum = 0;
        let count = 0;

        for (let offset = -smoothingRadius; offset <= smoothingRadius; offset += 1) {
            const sampleX = x + offset;
            if (sampleX < 0 || sampleX >= width) {
                continue;
            }

            sum += columnInkCounts[sampleX] ?? 0;
            count += 1;
        }

        smoothedCounts[x] = count > 0 ? (sum / count) : 0;
    }

    const searchStart = Math.round(width * 0.2);
    const searchEnd = Math.round(width * 0.8);
    let splitX = -1;
    let minInk = Number.POSITIVE_INFINITY;

    for (let x = searchStart; x <= searchEnd; x += 1) {
        const ink = smoothedCounts[x] ?? 0;
        if (ink < minInk) {
            minInk = ink;
            splitX = x;
        }
    }

    if (splitX === -1 || minInk > Math.max(10, Math.round(peakInk * 0.28))) {
        return [] satisfies Array<{ left: number; right: number }>;
    }

    const bandThreshold = Math.max(
        10,
        Math.round(height * 0.03),
        Math.round(peakInk * 0.22),
    );
    const leftBand = collectColumnBand(columnInkCounts, 0, splitX, bandThreshold);
    const rightBand = collectColumnBand(columnInkCounts, splitX, width, bandThreshold);

    if (!leftBand || !rightBand) {
        return [] satisfies Array<{ left: number; right: number }>;
    }

    const paddedBands = [leftBand, rightBand]
        .map((band) => ({
            left: clamp(band.left - padding, 0, width - 1),
            right: clamp(band.right + padding, 1, width),
        }))
        .filter((band) => (band.right - band.left) >= minimumColumnWidth);

    if (paddedBands.length !== 2) {
        return [] satisfies Array<{ left: number; right: number }>;
    }

    return paddedBands;
}

function collectColumnBand(
    columnInkCounts: Uint16Array,
    start: number,
    end: number,
    threshold: number,
) {
    let left = -1;
    let right = -1;

    for (let x = start; x < end; x += 1) {
        if ((columnInkCounts[x] ?? 0) < threshold) {
            continue;
        }

        if (left === -1) {
            left = x;
        }
        right = x + 1;
    }

    if (left === -1 || right === -1 || right <= left) {
        return null;
    }

    return { left, right };
}

function splitVerticalColumnsByLocalBands(
    imageData: Uint8ClampedArray,
    width: number,
    height: number,
    padding: number,
    minimumColumnWidth: number,
) {
    if (width < 96 || height < 160) {
        return [] satisfies Array<{ left: number; right: number }>;
    }

    const bandHeight = clamp(Math.round(width * 0.45), 96, Math.min(320, height));
    const bandStep = Math.max(48, Math.round(bandHeight * 0.5));
    const maxBridgeGap = Math.max(1, Math.round(width * 0.003));
    const minimumBandWidth = Math.max(24, Math.round(width * 0.08));
    const maximumBandWidth = Math.max(
        minimumBandWidth + 12,
        Math.round(width * 0.62),
    );
    const bandPadding = Math.max(2, Math.round(padding * 0.35));
    const bandStarts: number[] = [];
    const lastBandTop = Math.max(0, height - bandHeight);

    for (let top = 0; top <= lastBandTop; top += bandStep) {
        bandStarts.push(top);
    }

    if (bandStarts.length === 0 || bandStarts[bandStarts.length - 1] !== lastBandTop) {
        bandStarts.push(lastBandTop);
    }

    const bandSegments: Array<{
        left: number;
        right: number;
        top: number;
        bottom: number;
        centerX: number;
    }> = [];

    for (const bandTop of bandStarts) {
        const bandBottom = Math.min(height, bandTop + bandHeight);
        const bandColumnInkCounts = new Uint16Array(width);
        let bandPeakInk = 0;

        for (let x = 0; x < width; x += 1) {
            let inkCount = 0;

            for (let y = bandTop; y < bandBottom; y += 1) {
                const offset = ((y * width) + x) * 4;
                if (imageData[offset] < 128) {
                    inkCount += 1;
                }
            }

            bandColumnInkCounts[x] = inkCount;
            bandPeakInk = Math.max(bandPeakInk, inkCount);
        }

        if (bandPeakInk <= 0) {
            continue;
        }

        const minimumBandInk = Math.max(
            8,
            Math.round((bandBottom - bandTop) * 0.08),
            Math.round(bandPeakInk * 0.18),
        );
        const widestSegments = collectColumnBands(
            bandColumnInkCounts,
            width,
            minimumBandInk,
            maxBridgeGap,
        )
            .map((segment) => ({
                left: clamp(segment.left - bandPadding, 0, width - 1),
                right: clamp(segment.right + bandPadding, 1, width),
            }))
            .filter((segment) => {
                const segmentWidth = segment.right - segment.left;
                return segmentWidth >= minimumBandWidth && segmentWidth <= maximumBandWidth;
            })
            .sort((left, right) => (right.right - right.left) - (left.right - left.left))
            .slice(0, 2);

        for (const segment of widestSegments) {
            bandSegments.push({
                ...segment,
                top: bandTop,
                bottom: bandBottom,
                centerX: segment.left + ((segment.right - segment.left) / 2),
            });
        }
    }

    if (bandSegments.length < 4) {
        return [] satisfies Array<{ left: number; right: number }>;
    }

    const sortedSegments = [...bandSegments].sort((left, right) => left.centerX - right.centerX);
    let splitIndex = -1;
    let widestGap = 0;

    for (let index = 2; index <= (sortedSegments.length - 2); index += 1) {
        const gap = sortedSegments[index].centerX - sortedSegments[index - 1].centerX;
        if (gap <= widestGap) {
            continue;
        }

        widestGap = gap;
        splitIndex = index;
    }

    if (splitIndex === -1 || widestGap < Math.max(18, Math.round(width * 0.08))) {
        return [] satisfies Array<{ left: number; right: number }>;
    }

    const splitCenterX = (sortedSegments[splitIndex - 1].centerX + sortedSegments[splitIndex].centerX) / 2;
    const splitLeftBoundary = clamp(Math.floor(splitCenterX) - 2, 1, width - 2);
    const splitRightBoundary = clamp(Math.ceil(splitCenterX) + 2, 2, width - 1);
    const groupedSegments = [
        sortedSegments.slice(0, splitIndex),
        sortedSegments.slice(splitIndex),
    ];

    const mergedGroups = groupedSegments.map((segments, index) => {
        const left = Math.min(...segments.map((segment) => segment.left));
        const top = Math.min(...segments.map((segment) => segment.top));
        const right = Math.max(...segments.map((segment) => segment.right));
        const bottom = Math.max(...segments.map((segment) => segment.bottom));
        const boundedLeft = index === 0 ? left : Math.max(left, splitRightBoundary);
        const boundedRight = index === 0 ? Math.min(right, splitLeftBoundary) : right;
        return {
            bottom,
            height: bottom - top,
            left: boundedLeft,
            right: boundedRight,
            segmentCount: segments.length,
            top,
            width: boundedRight - boundedLeft,
        };
    });
    const sortedGroups = [...mergedGroups].sort((left, right) => left.left - right.left);
    const leftGroup = sortedGroups[0];
    const rightGroup = sortedGroups[1];
    const verticalOverlap = Math.min(leftGroup.bottom, rightGroup.bottom) - Math.max(leftGroup.top, rightGroup.top);
    const centerGap = rightGroup.left - leftGroup.right;
    const maxColumnWidth = Math.max(leftGroup.width, rightGroup.width);
    const minColumnWidth = Math.max(1, Math.min(leftGroup.width, rightGroup.width));
    const occupiedWidth = leftGroup.width + rightGroup.width;

    if (
        leftGroup.segmentCount < 2
        || rightGroup.segmentCount < 2
        || leftGroup.height < Math.round(height * 0.2)
        || rightGroup.height < Math.round(height * 0.2)
        || verticalOverlap < Math.max(48, Math.round(Math.min(leftGroup.height, rightGroup.height) * 0.22))
        || centerGap < Math.max(12, Math.round(width * 0.03))
        || (maxColumnWidth / minColumnWidth) > 2.6
        || occupiedWidth > Math.round(width * 0.9)
    ) {
        return [] satisfies Array<{ left: number; right: number }>;
    }

    return sortedGroups
        .map((group, index) => ({
            left: index === 0
                ? clamp(group.left - padding, 0, splitLeftBoundary - 1)
                : clamp(Math.max(group.left - padding, splitRightBoundary), 0, width - 1),
            right: index === 0
                ? clamp(Math.min(group.right + padding, splitLeftBoundary), 1, width)
                : clamp(group.right + padding, splitRightBoundary + 1, width),
        }))
        .filter((group) => (group.right - group.left) >= minimumColumnWidth);
}

function collectColumnBands(
    columnInkCounts: Uint16Array,
    width: number,
    threshold: number,
    maxBridgeGap: number,
) {
    const segments: Array<{ left: number; right: number }> = [];
    let activeLeft = -1;
    let lastInkColumn = -1;

    for (let x = 0; x < width; x += 1) {
        if ((columnInkCounts[x] ?? 0) >= threshold) {
            if (activeLeft === -1) {
                activeLeft = x;
            }
            lastInkColumn = x;
            continue;
        }

        if (activeLeft === -1 || lastInkColumn === -1) {
            continue;
        }

        if ((x - lastInkColumn) <= maxBridgeGap) {
            continue;
        }

        segments.push({
            left: activeLeft,
            right: lastInkColumn + 1,
        });
        activeLeft = -1;
        lastInkColumn = -1;
    }

    if (activeLeft !== -1 && lastInkColumn !== -1) {
        segments.push({
            left: activeLeft,
            right: lastInkColumn + 1,
        });
    }

    return segments;
}

function buildHeuristicVerticalSplitColumnSets(sourceCanvas: WorkingCanvas) {
    const width = sourceCanvas.width;
    const height = sourceCanvas.height;
    if (width < 240 || height < Math.round(width * 4)) {
        return [] satisfies DetectedBox[][];
    }

    const gap = Math.max(6, Math.round(width * 0.018));
    const minimumColumnWidth = Math.max(72, Math.round(width * 0.26));
    const splitRatios = [0.54];
    const columnSets = splitRatios
        .map((ratio) => {
            const splitX = clamp(
                Math.round(width * ratio),
                Math.round(width * 0.4),
                Math.round(width * 0.6),
            );
            const leftRight = clamp(splitX - Math.floor(gap / 2), minimumColumnWidth, width - minimumColumnWidth);
            const rightLeft = clamp(splitX + Math.ceil(gap / 2), minimumColumnWidth, width - minimumColumnWidth);

            if ((leftRight < minimumColumnWidth) || ((width - rightLeft) < minimumColumnWidth)) {
                return null;
            }

            return [
                createDetectedBox(rightLeft, 0, width, height),
                createDetectedBox(0, 0, leftRight, height),
            ] satisfies DetectedBox[];
        })
        .filter((columnSet): columnSet is DetectedBox[] => columnSet !== null);

    return columnSets.filter((columnSet, index) => {
        return columnSets.findIndex((otherSet) => (
            otherSet[0].left === columnSet[0].left
            && otherSet[1].right === columnSet[1].right
        )) === index;
    });
}

function resolveProjectedPageSegMode(pageSegMode: PSM, sourceCanvas: WorkingCanvas): PSM | null {
    if (pageSegMode !== PSM.AUTO) {
        return pageSegMode;
    }

    if (sourceCanvas.height >= Math.round(sourceCanvas.width * 1.6)) {
        return PSM.SINGLE_BLOCK_VERT_TEXT;
    }

    if (sourceCanvas.width >= Math.round(sourceCanvas.height * 1.6)) {
        return PSM.SINGLE_BLOCK;
    }

    return null;
}

function createProjectionMask(sourceCanvas: WorkingCanvas) {
    const context = get2DContext(sourceCanvas);
    const { data } = context.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const mask = new Uint8Array(sourceCanvas.width * sourceCanvas.height);

    for (let y = 0; y < sourceCanvas.height; y += 1) {
        for (let x = 0; x < sourceCanvas.width; x += 1) {
            const index = (y * sourceCanvas.width) + x;
            const sourceOffset = index * 4;
            mask[index] = data[sourceOffset] < 128 ? 1 : 0;
        }
    }

    return mask;
}

function extractMaskBoxes(
    mask: Uint8Array,
    width: number,
    height: number,
    minWidth: number,
    minHeight: number,
) {
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    const boxes: DetectedBox[] = [];

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const startIndex = (y * width) + x;
            if (mask[startIndex] === 0 || visited[startIndex] === 1) {
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
            let pixelCount = 0;

            while (queueStart < queueEnd) {
                const index = queue[queueStart++];
                const currentX = index % width;
                const currentY = Math.floor(index / width);

                minX = Math.min(minX, currentX);
                maxX = Math.max(maxX, currentX);
                minY = Math.min(minY, currentY);
                maxY = Math.max(maxY, currentY);
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
                        if (mask[nextIndex] === 0 || visited[nextIndex] === 1) {
                            continue;
                        }

                        visited[nextIndex] = 1;
                        queue[queueEnd++] = nextIndex;
                    }
                }
            }

            const boxWidth = maxX - minX + 1;
            const boxHeight = maxY - minY + 1;
            const boxArea = boxWidth * boxHeight;
            const fillRatio = pixelCount / Math.max(boxArea, 1);

            if (boxWidth < minWidth || boxHeight < minHeight) {
                continue;
            }

            if (fillRatio < 0.05) {
                continue;
            }

            boxes.push(createDetectedBox(minX, minY, maxX + 1, maxY + 1));
        }
    }

    return boxes
        .sort((left, right) => (right.width * right.height) - (left.width * left.height))
        .slice(0, 24);
}

function expandProjectedComponentBox(
    box: DetectedBox,
    orientation: 'vertical' | 'horizontal',
    imageWidth: number,
    imageHeight: number,
    padding: number,
    minimumAxisSize: number,
) {
    if (orientation === 'vertical') {
        const axisPadding = Math.max(
            padding * 2,
            Math.ceil(Math.max(0, minimumAxisSize - box.width) / 2),
        );
        const crossPadding = Math.max(
            padding,
            Math.round(box.height * 0.04),
            4,
        );
        const left = clamp(box.left - axisPadding, 0, imageWidth - 1);
        const top = clamp(box.top - crossPadding, 0, imageHeight - 1);
        const right = clamp(box.right + axisPadding, left + 1, imageWidth);
        const bottom = clamp(box.bottom + crossPadding, top + 1, imageHeight);
        return createDetectedBox(left, top, right, bottom);
    }

    const axisPadding = Math.max(
        padding * 2,
        Math.ceil(Math.max(0, minimumAxisSize - box.height) / 2),
    );
    const crossPadding = Math.max(
        padding,
        Math.round(box.width * 0.04),
        4,
    );
    const left = clamp(box.left - crossPadding, 0, imageWidth - 1);
    const top = clamp(box.top - axisPadding, 0, imageHeight - 1);
    const right = clamp(box.right + crossPadding, left + 1, imageWidth);
    const bottom = clamp(box.bottom + axisPadding, top + 1, imageHeight);
    return createDetectedBox(left, top, right, bottom);
}

function createDetectedBox(left: number, top: number, right: number, bottom: number): DetectedBox {
    const width = right - left;
    const height = bottom - top;

    return {
        averageScore: 1,
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

function serializeDebugCandidate(candidate: OcrRecognitionCandidate | null): OcrDebugCandidateSnapshot | null {
    if (!candidate) {
        return null;
    }

    return {
        artifactCount: candidate.artifactCount,
        averageSymbolConfidence: Number(candidate.averageSymbolConfidence.toFixed(1)),
        confidence: Number(candidate.confidence.toFixed(1)),
        id: candidate.id,
        japaneseRatio: Number(candidate.japaneseRatio.toFixed(2)),
        score: Number(candidate.score.toFixed(1)),
        text: candidate.cleanedText,
    };
}

function serializeDebugBox(box: DetectedBox | null) {
    if (!box) {
        return null;
    }

    return {
        averageScore: Number(box.averageScore.toFixed(3)),
        bottom: box.bottom,
        height: box.height,
        left: box.left,
        right: box.right,
        top: box.top,
        width: box.width,
    };
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
