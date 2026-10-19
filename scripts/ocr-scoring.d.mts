export function normalizeOcrText(text: string | null | undefined): string;
export function normalizeSpacingSensitiveOcrText(text: string | null | undefined): string;
export function scoreOcrText(expectedText: string, actualText: string): {
    normalizedExpectedText: string;
    normalizedActualText: string;
    exactMatch: boolean;
    editDistance: number;
    characterAccuracy: number;
    spacingSensitiveExpectedText: string;
    spacingSensitiveActualText: string;
    spacingSensitiveExactMatch: boolean;
    spacingSensitiveEditDistance: number;
    spacingSensitiveCharacterAccuracy: number;
    rawExactMatch: boolean;
};
