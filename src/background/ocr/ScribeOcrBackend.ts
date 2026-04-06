import { PSM } from 'tesseract.js';
import type { TessRecognizeResult, TessWorker } from 'scribe.js-ocr/tess/TessWorker.js';
import { TessWorker as ScribeTessWorker } from 'scribe.js-ocr/tess/TessWorker.js';
import type { OcrBackend } from './OcrBackend';
import { DEFAULT_OCR_MODEL } from '../../interfaces/Storage';
import { buildOcrRecognitionCandidate, serializeOcrCandidate } from './OcrTextScoring';

type WorkerBundle = {
    promise: Promise<TessWorker>;
    worker: TessWorker | null;
};

type ScribeSymbol = {
    confidence: number;
};

export class ScribeOcrBackend implements OcrBackend {
    private static logTag = `[${ScribeOcrBackend.name}]`;
    private static workers = new Map<string, WorkerBundle>();

    public async init(model: string = DEFAULT_OCR_MODEL): Promise<void> {
        await this.ensureWorker(this.normalizeModelName(model));
    }

    public async recognize(dataUrl: string, pageSegMode: PSM, model: string = DEFAULT_OCR_MODEL): Promise<string | undefined> {
        const normalizedModel = this.normalizeModelName(model);

        try {
            const worker = await this.ensureWorker(normalizedModel);
            await worker.setParameters({
                tessedit_pageseg_mode: pageSegMode,
            });

            const result = await worker.recognize(dataUrl, {}, {
                text: true,
                blocks: true,
            });
            const candidate = this.buildCandidate(`primary-${normalizedModel}`, result);

            if (candidate) {
                console.debug(
                    ScribeOcrBackend.logTag,
                    'Selected primary OCR candidate',
                    serializeOcrCandidate(candidate),
                );
                return candidate.cleanedText;
            }
        } catch (error) {
            console.warn(ScribeOcrBackend.logTag, `OCR failed for model '${normalizedModel}'`, error);
        }

        return undefined;
    }

    public async terminate(): Promise<void> {
        const bundles = [...ScribeOcrBackend.workers.values()];
        ScribeOcrBackend.workers.clear();

        await Promise.all(bundles.map(async (bundle) => {
            try {
                const worker = bundle.worker ?? await bundle.promise;
                await worker.terminate();
            } catch (error) {
                console.warn(ScribeOcrBackend.logTag, 'Failed to terminate OCR worker', error);
            }
        }));
    }

    private normalizeModelName(model: string | undefined): string {
        const trimmedModel = model?.trim();

        if (trimmedModel && /^[A-Za-z0-9_-]+$/.test(trimmedModel)) {
            return trimmedModel;
        }

        return DEFAULT_OCR_MODEL;
    }

    private buildCandidate(id: string, result: TessRecognizeResult) {
        const symbolConfidences = (result.data.symbols ?? [])
            .map((symbol: ScribeSymbol) => symbol.confidence)
            .filter((confidence): confidence is number => Number.isFinite(confidence));

        return buildOcrRecognitionCandidate(
            id,
            result.data.text ?? '',
            result.data.confidence ?? 0,
            symbolConfidences,
        );
    }

    private async ensureWorker(model: string): Promise<TessWorker> {
        const existingBundle = ScribeOcrBackend.workers.get(model);

        if (existingBundle) {
            return existingBundle.worker ?? existingBundle.promise;
        }

        console.debug(ScribeOcrBackend.logTag, 'Creating OCR worker', model);

        const bundle: WorkerBundle = {
            worker: null,
            promise: ScribeTessWorker.create(
                [model],
                ScribeTessWorker.OEM.LSTM_ONLY,
                {
                    gzip: true,
                    langPath: '/libs/tesseract-lang',
                    legacyCore: false,
                    legacyLang: false,
                    logger: (message) => console.debug(ScribeOcrBackend.logTag, model, message),
                    errorHandler: (error) => console.warn(ScribeOcrBackend.logTag, `Worker error for model '${model}'`, error),
                },
            ).then((worker) => {
                bundle.worker = worker;
                return worker;
            }).catch((error) => {
                ScribeOcrBackend.workers.delete(model);
                throw error;
            }),
        };

        ScribeOcrBackend.workers.set(model, bundle);
        return bundle.promise;
    }
}

export { ScribeOcrBackend as ConfiguredOcrBackend };
