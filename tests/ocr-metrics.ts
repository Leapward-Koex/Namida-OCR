import type { OcrCase } from './ocr-cases';

export type OcrCaseResult = {
    caseIndex: number;
    name: string;
    image: string;
    expectedText: string;
    actualText: string;
    normalizedExpectedText: string;
    normalizedActualText: string;
    exactMatch: boolean;
    editDistance: number;
    characterAccuracy: number;
};

export function normalizeOcrText(text: string | null | undefined): string {
    return (text ?? '').replace(/\s+/g, '');
}

export function scoreOcrCase(
    ocrCase: OcrCase,
    actualText: string | null | undefined,
    caseIndex: number,
): OcrCaseResult {
    const normalizedExpectedText = normalizeOcrText(ocrCase.expectedText);
    const normalizedActualText = normalizeOcrText(actualText);
    const editDistance = levenshteinDistance(normalizedExpectedText, normalizedActualText);
    const lengthBase = Math.max(
        normalizedExpectedText.length,
        normalizedActualText.length,
        1,
    );
    const characterAccuracy = 1 - (editDistance / lengthBase);

    return {
        caseIndex,
        name: ocrCase.name,
        image: ocrCase.image,
        expectedText: ocrCase.expectedText,
        actualText: actualText ?? '',
        normalizedExpectedText,
        normalizedActualText,
        exactMatch: normalizedExpectedText === normalizedActualText,
        editDistance,
        characterAccuracy,
    };
}

function levenshteinDistance(left: string, right: string): number {
    const rows = left.length + 1;
    const cols = right.length + 1;
    const distances = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

    for (let row = 0; row < rows; row += 1) {
        distances[row][0] = row;
    }

    for (let col = 0; col < cols; col += 1) {
        distances[0][col] = col;
    }

    for (let row = 1; row < rows; row += 1) {
        for (let col = 1; col < cols; col += 1) {
            const substitutionCost = left[row - 1] === right[col - 1] ? 0 : 1;

            distances[row][col] = Math.min(
                distances[row - 1][col] + 1,
                distances[row][col - 1] + 1,
                distances[row - 1][col - 1] + substitutionCost,
            );
        }
    }

    return distances[rows - 1][cols - 1];
}



