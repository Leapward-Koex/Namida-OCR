import { runtime } from 'webextension-polyfill';
import * as ort from 'onnxruntime-web';
import { PSM } from 'tesseract.js';
import type { OcrBackend } from './OcrBackend';
import { PaddleOnnxRuntime } from './PaddleOnnxRuntime';
import { assertDetectionTensor, assertRecognitionTensor } from './PaddleOnnxModelContract';
import {
    prepareDetectorInput, prepareRecognizerInput, decodeCtcProbabilities,
    type PaddleModelManifest, type CtcResult, type PreparedModelInput,
} from './PaddleModelPipeline';
import { postProcessDb, type DbBox } from './PaddleDbPostProcess';
import { rectifyTextLine } from './PaddleCropGeometry';
import { decodePaddleImage, encodePaddleImage } from './PaddleImage';
import { orderTextRegions, regionBounds } from './PaddleReadingOrder';
import type { OcrDebugCandidateSnapshot, OcrDebugCropSnapshot, OcrDebugSnapshot } from './OcrDebugSnapshot';

const MANIFEST_PATH = 'libs/paddleocr/paddleocr-manifest.json';

/** Local PP-OCRv6: detector -> DB quadrilaterals -> rectified lines -> greedy CTC.
 * Optional upstream document/orientation models are not part of the bundled pair.
 * Layout and recovery must not silently change the model's input/output contract.
 */
export class PaddleOnnxOcrBackend implements OcrBackend {
    private static readonly onnx = new PaddleOnnxRuntime();
    private static manifestPromise: Promise<PaddleModelManifest> | null = null;
    private static dictionaryPromise: Promise<string[]> | null = null;
    private static queue: Promise<void> = Promise.resolve();
    private debugEnabled = false;
    private lastDebugSnapshot: OcrDebugSnapshot | null = null;

    public init(): Promise<void> {
        return PaddleOnnxOcrBackend.enqueue(async () => {
            const manifest = await this.getManifest();
            await Promise.all([
                this.getDictionary(),
                PaddleOnnxOcrBackend.onnx.ensureSession('detector', manifest.detector.model_path),
                PaddleOnnxOcrBackend.onnx.ensureSession('recognizer', manifest.recognizer.model_path),
            ]);
        });
    }

    public setDebugEnabled(enabled: boolean): void {
        this.debugEnabled = enabled;
        if (!enabled) this.lastDebugSnapshot = null;
    }

    public setGpuEnabled(enabled: boolean): Promise<void> {
        return PaddleOnnxOcrBackend.enqueue(() => PaddleOnnxOcrBackend.onnx.setGpuEnabled(enabled));
    }

    public getLastDebugSnapshot(): OcrDebugSnapshot | null { return this.lastDebugSnapshot; }

    public terminate(): Promise<void> {
        return PaddleOnnxOcrBackend.enqueue(() => PaddleOnnxOcrBackend.onnx.terminate());
    }

    public recognize(dataUrl: string, pageSegMode: PSM): Promise<string> {
        // One request owns both shared sessions through its complete pipeline.
        return PaddleOnnxOcrBackend.enqueue(() => this.recognizeImage(dataUrl, pageSegMode));
    }

    private static enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const job = this.queue.then(operation);
        this.queue = job.then(() => undefined, () => undefined);
        return job;
    }

    private async recognizeImage(dataUrl: string, pageSegMode: PSM): Promise<string> {
        this.lastDebugSnapshot = null;
        const startedAt = performance.now();
        const debug = this.debugEnabled;
        const [manifest, dictionary, image] = await Promise.all([
            this.getManifest(), this.getDictionary(), decodePaddleImage(dataUrl),
        ]);
        const detectorInput = prepareDetectorInput(image, manifest.detector);
        const boxes = await this.detect(detectorInput, manifest);
        const layout = orderTextRegions(boxes,
            pageSegMode === PSM.SINGLE_BLOCK_VERT_TEXT ? 'vertical'
                : pageSegMode === PSM.SINGLE_BLOCK ? 'horizontal' : undefined);
        const recognized: CtcResult[] = [];
        const debugGroups: OcrDebugCropSnapshot[] = [];
        let recognitionRuns = 0;

        for (const [index, box] of layout.regions.entries()) {
            const crop = rectifyTextLine(image, box.points);
            if (!crop.width || !crop.height) continue;
            const input = prepareRecognizerInput(crop, manifest.recognizer);
            const result = await this.recognizeLine(input, manifest, dictionary);
            recognitionRuns += 1;
            const accepted = result.text.length > 0 && result.confidence >= manifest.recognizer.score_threshold;
            if (accepted) recognized.push(result);
            if (debug) {
                const id = `line-${index}`;
                const candidate = debugCandidate(id, result);
                const imageDataUrl = await encodePaddleImage(crop);
                debugGroups.push({
                    id, source: 'detector', imageDataUrl,
                    box: { ...regionBounds(box), averageScore: box.score, points: box.points },
                    selectedCandidate: accepted ? candidate : null,
                    attempts: [{
                        id, candidate, imageDataUrl, normalized: false, rotated: crop.rotated,
                        selected: accepted, tokens: result.tokens, inputShape: input.dims,
                        contentWidth: input.contentWidth, widthClamped: input.widthClamped,
                    }],
                });
            }
        }

        const text = recognized.map(line => line.text).join('\n');
        if (debug && this.debugEnabled) {
            const tokens = recognized.flatMap(line => line.tokens);
            const selected = text.length ? debugCandidate('detected-lines', {
                text, tokens,
                confidence: tokens.reduce((sum, token) => sum + token.confidence, 0) / Math.max(1, tokens.length),
            }) : null;
            this.lastDebugSnapshot = {
                schemaVersion: 2, backend: 'paddleonnx', createdAt: new Date().toISOString(), pageSegMode,
                workingImageDataUrl: dataUrl,
                candidates: { detected: selected, selected, fullCrop: null, projected: null },
                detectedGroups: debugGroups, projectedGroups: [], fullCrop: null,
                pipeline: {
                    modelVariant: manifest.variant, direction: layout.direction,
                    detectorInputShape: detectorInput.dims,
                    detectorParameters: { ...manifest.detector }, recognitionParameters: { ...manifest.recognizer },
                    detectorRuns: 1, recognitionRuns,
                    elapsedMs: performance.now() - startedAt, recovery: [],
                },
            };
        }
        console.debug('[PaddleOnnxOcrBackend]', 'Recognized detected text lines', {
            detected: boxes.length, recognized: recognized.length, direction: layout.direction,
            elapsedMs: Math.round(performance.now() - startedAt),
        });
        return text;
    }

    private detect(input: PreparedModelInput, manifest: PaddleModelManifest): Promise<DbBox[]> {
        return this.runModel('detector', manifest.detector.model_path, input, output => {
            assertDetectionTensor(output);
            return postProcessDb(output.data as Float32Array, output.dims[3], output.dims[2],
                input.sourceWidth, input.sourceHeight, {
                    threshold: manifest.detector.threshold,
                    boxThreshold: manifest.detector.box_score_threshold,
                    unclipRatio: manifest.detector.unclip_ratio,
                    maxCandidates: manifest.detector.max_candidates,
                });
        });
    }

    private recognizeLine(input: PreparedModelInput, manifest: PaddleModelManifest, dictionary: string[]): Promise<CtcResult> {
        return this.runModel('recognizer', manifest.recognizer.model_path, input, output => {
            assertRecognitionTensor(output, dictionary);
            return decodeCtcProbabilities(output.data as Float32Array, output.dims[1], dictionary);
        });
    }

    private async runModel<T>(key: string, modelPath: string, input: PreparedModelInput, read: (output: ort.Tensor | undefined) => T): Promise<T> {
        const initialSession = await PaddleOnnxOcrBackend.onnx.ensureSession(key, modelPath);
        return PaddleOnnxOcrBackend.onnx.run(key, initialSession, async session => {
            const tensor = new ort.Tensor('float32', input.data, input.dims);
            let outputs: ort.InferenceSession.ReturnType | undefined;
            try {
                outputs = await session.run({ [session.inputNames[0]]: tensor });
                return read(outputs[session.outputNames[0]]);
            } finally {
                // Dispose inside the actual operation: provider timeout does not
                // cancel a run, so the outer timeout must not free its tensors.
                for (const output of Object.values(outputs ?? {})) output.dispose();
                tensor.dispose();
            }
        });
    }

    private getManifest(): Promise<PaddleModelManifest> {
        return PaddleOnnxOcrBackend.manifestPromise ??= fetch(runtime.getURL(MANIFEST_PATH)).then(async response => {
            if (!response.ok) throw new Error(`Failed to load local PaddleOCR manifest: ${response.status}`);
            const manifest = await response.json() as PaddleModelManifest;
            if (manifest.model_version !== 'PP-OCRv6' || manifest.detector.channel_order !== 'BGR'
                || manifest.recognizer.channel_order !== 'BGR' || manifest.detector.use_dilation
                || manifest.detector.score_mode !== 'fast' || manifest.detector.min_box_size !== 3
                || manifest.recognizer.normalized_padding !== 0 || manifest.recognizer.output_activation !== 'softmax'
                || manifest.recognizer.blank_index !== 0 || manifest.recognizer.rotation_aspect_threshold !== 1.5
                || !Number.isFinite(manifest.recognizer.score_threshold)
                || manifest.recognizer.score_threshold < 0 || manifest.recognizer.score_threshold > 1) {
                throw new Error('The bundled PaddleOCR metadata does not match the supported PP-OCRv6 inference contract.');
            }
            return manifest;
        }).catch(error => { PaddleOnnxOcrBackend.manifestPromise = null; throw error; });
    }

    private getDictionary(): Promise<string[]> {
        return PaddleOnnxOcrBackend.dictionaryPromise ??= this.getManifest().then(async manifest => {
            const response = await fetch(runtime.getURL(`libs/paddleocr/${manifest.recognizer.dict_path}`));
            if (!response.ok) throw new Error(`Failed to load local PaddleOCR dictionary: ${response.status}`);
            // Remove only the file terminator. A literal space is a model class.
            const dictionary = (await response.text()).replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
            if (dictionary.some(token => !token.length) || dictionary.length + 1 !== manifest.recognizer.output_classes) {
                throw new Error('PaddleOCR dictionary does not match the declared CTC output classes.');
            }
            return dictionary;
        }).catch(error => { PaddleOnnxOcrBackend.dictionaryPromise = null; throw error; });
    }
}

function debugCandidate(id: string, result: CtcResult): OcrDebugCandidateSnapshot {
    return { id, text: result.text, confidence: result.confidence * 100 };
}

export { PaddleOnnxOcrBackend as ConfiguredOcrBackend };
