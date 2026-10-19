import type { OcrCase } from './ocr-cases';
import { scoreOcrText } from '../scripts/ocr-scoring.mjs';
export { normalizeOcrText, normalizeSpacingSensitiveOcrText } from '../scripts/ocr-scoring.mjs';

export type OcrCaseResult = {
    caseIndex: number;
    name: string;
    image: string;
    expectedText: string;
    actualText: string;
    input?: {
        mode: string;
        sha256?: string;
    };
} & ReturnType<typeof scoreOcrText>;

export function scoreOcrCase(
    ocrCase: OcrCase,
    actualText: string | null | undefined,
    caseIndex: number,
): OcrCaseResult {
    return {
        caseIndex,
        name: ocrCase.name,
        image: ocrCase.image,
        expectedText: ocrCase.expectedText,
        actualText: actualText ?? '',
        ...scoreOcrText(ocrCase.expectedText, actualText ?? ''),
    };
}



