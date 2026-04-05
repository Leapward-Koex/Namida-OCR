import { createWorker, OEM, PSM, Worker } from 'tesseract.js';
import type { OcrBackend } from './OcrBackend';
import { DEFAULT_OCR_MODEL } from '../interfaces/Storage';

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

type RecognitionCandidate = {
    id: string;
    text: string;
    cleanedText: string;
    normalizedText: string;
    confidence: number;
    averageSymbolConfidence: number;
    japaneseRatio: number;
    artifactCount: number;
    score: number;
};

const ARTIFACT_CHARS = /[\\/|:;_`~]/g;
const JAPANESE_CHARS = /[々〆ヶぁ-ゖァ-ヺ一-龯]/gu;
const JAPANESE_CONTEXT = /([々〆ヶぁ-ゖァ-ヺ一-龯…。、！？「」『』ー])[\\/|](?=[々〆ヶぁ-ゖァ-ヺ一-龯…。、！？「」『』ー])/gu;
const STRIP_LINE_ARTIFACTS = /^[\\/|:;_`~]+|[\\/|:;_`~]+$/g;

export class TesseractOcrBackend implements OcrBackend {
    private static logTag = `[${TesseractOcrBackend.name}]`;
    private static workers = new Map<string, WorkerBundle>();

    public async init(model: string = DEFAULT_OCR_MODEL): Promise<void> {
        await this.ensureWorker([this.normalizeModelName(model)]);
    }

    public async recognize(dataUrl: string, pageSegMode: PSM, model: string = DEFAULT_OCR_MODEL): Promise<string | undefined> {
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
                this.serializeCandidate(primaryCandidate),
            );
            return primaryCandidate.cleanedText;
        }

        return undefined;
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

    private async executePlan(plan: RecognitionPlan, dataUrl: string): Promise<RecognitionCandidate | null> {
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

    private buildCandidate(
        id: string,
        text: string,
        confidence: number,
        symbols: Array<{ confidence: number }>,
    ): RecognitionCandidate | null {
        const cleanedText = this.cleanRecognizedText(text);
        const normalizedText = cleanedText.replace(/\s+/g, '');

        if (!normalizedText) {
            return null;
        }

        const japaneseMatches = normalizedText.match(JAPANESE_CHARS) ?? [];
        const japaneseRatio = japaneseMatches.length / Math.max(normalizedText.length, 1);
        const artifactCount = (text.match(ARTIFACT_CHARS) ?? []).length;
        const asciiLetterCount = (normalizedText.match(/[A-Za-z]/g) ?? []).length;
        const averageSymbolConfidence = symbols.length > 0
            ? symbols.reduce((sum, symbol) => sum + symbol.confidence, 0) / symbols.length
            : confidence;
        const score = confidence
            + (averageSymbolConfidence * 0.35)
            + (japaneseRatio * 30)
            + Math.min(normalizedText.length, 12)
            - (artifactCount * 10)
            - (asciiLetterCount * 6);

        return {
            id,
            text,
            cleanedText,
            normalizedText,
            confidence,
            averageSymbolConfidence,
            japaneseRatio,
            artifactCount,
            score,
        };
    }

    private cleanRecognizedText(text: string): string {
        const cleanedLines = text
            .replace(JAPANESE_CONTEXT, '$1')
            .split('\n')
            .map((line) => line.replace(STRIP_LINE_ARTIFACTS, '').trim())
            .filter((line) => line.length > 0 && !/^[\\/|:;_`~]+$/.test(line));

        if (cleanedLines.length === 0) {
            return '';
        }

        return cleanedLines.join('\n');
    }

    private serializeCandidate(candidate: RecognitionCandidate) {
        return {
            id: candidate.id,
            confidence: Number(candidate.confidence.toFixed(1)),
            averageSymbolConfidence: Number(candidate.averageSymbolConfidence.toFixed(1)),
            japaneseRatio: Number(candidate.japaneseRatio.toFixed(2)),
            artifactCount: candidate.artifactCount,
            score: Number(candidate.score.toFixed(1)),
            text: candidate.cleanedText,
        };
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
