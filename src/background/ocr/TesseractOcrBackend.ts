import { createWorker, OEM, PSM, Worker } from 'tesseract.js';
import type { OcrBackend } from './OcrBackend';
import { DEFAULT_OCR_MODEL } from '../../interfaces/Storage';
import { buildOcrRecognitionCandidate, OcrRecognitionCandidate, serializeOcrCandidate } from './OcrTextScoring';

type WorkerBundle = {
    promise: Promise<Worker>;
    worker: Worker | null;
    queue: Promise<void>;
};

type RecognitionPlan = {
    id: string;
    langs: string[];
    pageSegMode: PSM;
    rotateAuto?: boolean;
    rotateRadians?: number;
};

export class TesseractOcrBackend implements OcrBackend {
    private static logTag = `[${TesseractOcrBackend.name}]`;
    private static workers = new Map<string, WorkerBundle>();

    public async init(model: string = DEFAULT_OCR_MODEL): Promise<void> {
        await this.ensureWorker([this.normalizeModelName(model)]).promise;
    }

    public async recognize(dataUrl: string, pageSegMode: PSM, model: string = DEFAULT_OCR_MODEL): Promise<string | undefined> {
        const candidate = await this.recognizeCandidate(dataUrl, pageSegMode, model);
        return candidate?.cleanedText;
    }

    public async recognizeCandidate(
        dataUrl: string,
        pageSegMode: PSM,
        model: string = DEFAULT_OCR_MODEL,
    ): Promise<OcrRecognitionCandidate | null> {
        const normalizedModel = this.normalizeModelName(model);
        const plan: RecognitionPlan = { id: `primary-${normalizedModel}`, langs: [normalizedModel], pageSegMode };
        try {
            // Queue the whole request, including any retry, so termination drains
            // all accepted work and concurrent snips cannot share mutable state.
            const bundle = this.ensureWorker(plan.langs);
            const job = bundle.queue.then(async () => {
                const worker = await bundle.promise;
                const primary = await this.executePlan(plan, dataUrl, worker);
                let selected = primary;
                if (!primary || primary.confidence < 85) {
                    try {
                        const retryImage = await this.prepareRetryImage(dataUrl);
                        const retry = await this.executePlan({ ...plan, id: `resized-border-${normalizedModel}` }, retryImage, worker);
                        // Confidence alone can favor truncated or non-Japanese
                        // output. Keep the original unless all these signals agree.
                        if (retry && (!primary || (
                            retry.confidence > primary.confidence
                            && retry.score > primary.score
                            && retry.japaneseRatio >= primary.japaneseRatio
                            && retry.normalizedText.length >= primary.normalizedText.length * 0.75
                        ))) {
                            selected = retry;
                        }
                    } catch (error) {
                        console.warn(TesseractOcrBackend.logTag, 'OCR image retry failed; keeping original result', error);
                    }
                }
                if (selected) {
                    console.debug(TesseractOcrBackend.logTag, 'Selected OCR candidate', serializeOcrCandidate(selected));
                }
                return selected;
            });
            bundle.queue = job.then(() => undefined, () => undefined);
            return await job;
        } catch (error) {
            console.warn(TesseractOcrBackend.logTag, 'OCR request failed', error);
            return null;
        }
    }

    private async prepareRetryImage(dataUrl: string): Promise<string> {
        // Image.decode() can hang in Chromium's hidden offscreen document.
        const image = await createImageBitmap(await (await fetch(dataUrl)).blob());
        try {
            // Screenshots are normally upscaled 4x before reaching this backend.
            // Try smaller glyphs on uncertain results, but preserve small inputs.
            const scale = Math.min(image.width, image.height) >= 80 ? 0.5 : 1;
            const width = Math.max(1, Math.round(image.width * scale));
            const height = Math.max(1, Math.round(image.height * scale));
            const border = 10;
            const canvas = document.createElement('canvas');
            canvas.width = width + border * 2;
            canvas.height = height + border * 2;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Unable to prepare Tesseract retry image');
            context.fillStyle = '#fff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.imageSmoothingEnabled = true;
            context.imageSmoothingQuality = 'high';
            context.drawImage(image, border, border, width, height);
            return canvas.toDataURL('image/png');
        } finally {
            image.close();
        }
    }

    private normalizeModelName(model: string | undefined): string {
        const trimmedModel = model?.trim();

        if (trimmedModel && /^[A-Za-z0-9_-]+$/.test(trimmedModel)) {
            return trimmedModel;
        }

        return DEFAULT_OCR_MODEL;
    }

    public async terminate(): Promise<void> {
        const bundles = [...TesseractOcrBackend.workers.values()];
        TesseractOcrBackend.workers.clear();

        await Promise.all(bundles.map(async (bundle) => {
            try {
                await bundle.queue;
                const worker = bundle.worker ?? await bundle.promise;
                await worker.terminate();
            } catch (error) {
                console.warn(TesseractOcrBackend.logTag, 'Failed to terminate OCR worker', error);
            }
        }));
    }

    private async executePlan(plan: RecognitionPlan, dataUrl: string, worker: Worker): Promise<OcrRecognitionCandidate | null> {
        try {
            // Tesseract.js saves/restores parameters passed to recognize().
            const recognizeOptions = {
                tessedit_pageseg_mode: plan.pageSegMode,
                rotateAuto: plan.rotateAuto,
                rotateRadians: plan.rotateRadians,
            };
            const result = await worker.recognize(dataUrl, recognizeOptions, {
                text: true,
                blocks: true, // Symbol confidence is used by candidate scoring.
                hocr: false,
                tsv: false,
            });
            return this.buildCandidate(plan.id, result.data.text ?? '', result.data.confidence, result.data.symbols ?? []);
        } catch (error) {
            console.warn(TesseractOcrBackend.logTag, `OCR plan '${plan.id}' failed`, error);
            return null;
        }
    }

    private buildCandidate(id: string, text: string, confidence: number, symbols: Array<{ confidence: number }>) {
        return buildOcrRecognitionCandidate(
            id,
            text,
            confidence,
            symbols.map((symbol) => symbol.confidence),
        );
    }

    private ensureWorker(langs: string[]): WorkerBundle {
        const key = langs.join('+');
        const existingBundle = TesseractOcrBackend.workers.get(key);

        if (existingBundle) {
            return existingBundle;
        }

        console.debug(TesseractOcrBackend.logTag, 'Creating OCR worker', key);

        const bundle: WorkerBundle = {
            worker: null,
            queue: Promise.resolve(),
            promise: undefined as unknown as Promise<Worker>,
        };
        bundle.promise = new Promise<Worker>((resolve, reject) => {
            createWorker(
                langs,
                OEM.LSTM_ONLY,
                {
                    workerBlobURL: false,
                    corePath: '/libs/tesseract-core',
                    workerPath: '/libs/tesseract-worker/worker.min.js',
                    langPath: '/libs/tesseract-lang',
                    gzip: false,
                    logger: (message) => console.debug(TesseractOcrBackend.logTag, key, message),
                    errorHandler: (error) => {
                        console.warn(TesseractOcrBackend.logTag, key, error);
                        // v5 does not consistently reject createWorker() when
                        // language loading or initialization fails.
                        if (!bundle.worker) reject(error);
                    },
                },
            ).then(resolve, reject);
        }).then((worker) => {
            bundle.worker = worker;
            return worker;
        }).catch((error) => {
            if (TesseractOcrBackend.workers.get(key) === bundle) {
                TesseractOcrBackend.workers.delete(key);
            }
            throw error;
        });

        TesseractOcrBackend.workers.set(key, bundle);
        return bundle;
    }
}

export { TesseractOcrBackend as ConfiguredOcrBackend };
