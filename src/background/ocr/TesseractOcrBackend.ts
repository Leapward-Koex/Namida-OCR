import { createWorker, OEM, PSM, Worker } from 'tesseract.js';
import type { OcrBackend } from './OcrBackend';
import { DEFAULT_OCR_MODEL } from '../../interfaces/Storage';
import { buildOcrRecognitionCandidate, OcrRecognitionCandidate, serializeOcrCandidate } from './OcrTextScoring';

type WorkerBundle = {
    promise: Promise<Worker>;
    worker: Worker | null;
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
        await this.ensureWorker([this.normalizeModelName(model)]);
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
        const primaryCandidate = await this.executePlan(
            {
                id: `primary-${normalizedModel}`,
                langs: [normalizedModel],
                pageSegMode,
            },
            dataUrl,
        );

        if (primaryCandidate) {
            console.debug(
                TesseractOcrBackend.logTag,
                'Selected primary OCR candidate',
                serializeOcrCandidate(primaryCandidate),
            );
        }

        return primaryCandidate;
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
                const worker = bundle.worker ?? await bundle.promise;
                await worker.terminate();
            } catch (error) {
                console.warn(TesseractOcrBackend.logTag, 'Failed to terminate OCR worker', error);
            }
        }));
    }

    private async executePlan(plan: RecognitionPlan, dataUrl: string): Promise<OcrRecognitionCandidate | null> {
        try {
            const worker = await this.ensureWorker(plan.langs);
            await worker.setParameters({
                tessedit_pageseg_mode: plan.pageSegMode,
            });

            const recognizeOptions = (plan.rotateAuto !== undefined || plan.rotateRadians !== undefined)
                ? {
                    rotateAuto: plan.rotateAuto,
                    rotateRadians: plan.rotateRadians,
                }
                : undefined;

            const result = recognizeOptions
                ? await worker.recognize(dataUrl, recognizeOptions)
                : await worker.recognize(dataUrl);

            return this.buildCandidate(plan.id, result.data.text ?? '', result.data.confidence, result.data.symbols);
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

    private async ensureWorker(langs: string[]): Promise<Worker> {
        const key = langs.join('+');
        const existingBundle = TesseractOcrBackend.workers.get(key);

        if (existingBundle) {
            return existingBundle.worker ?? existingBundle.promise;
        }

        console.debug(TesseractOcrBackend.logTag, 'Creating OCR worker', key);

        const bundle: WorkerBundle = {
            worker: null,
            promise: createWorker(
                langs,
                OEM.LSTM_ONLY,
                {
                    workerBlobURL: false,
                    corePath: '/libs/tesseract-core',
                    workerPath: '/libs/tesseract-worker/worker.min.js',
                    langPath: '/libs/tesseract-lang',
                    gzip: true,
                    logger: (message) => console.debug(TesseractOcrBackend.logTag, key, message),
                },
            ).then((worker) => {
                bundle.worker = worker;
                return worker;
            }).catch((error) => {
                TesseractOcrBackend.workers.delete(key);
                throw error;
            }),
        };

        TesseractOcrBackend.workers.set(key, bundle);
        return bundle.promise;
    }
}

export { TesseractOcrBackend as ConfiguredOcrBackend };
