export type OcrRecognitionCandidate = {
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

export function buildOcrRecognitionCandidate(
    id: string,
    text: string,
    confidence: number,
    symbolConfidences: number[] = [],
): OcrRecognitionCandidate | null {
    const cleanedText = cleanRecognizedText(text);
    const normalizedText = cleanedText.replace(/\s+/g, '');

    if (!normalizedText) {
        return null;
    }

    const japaneseMatches = normalizedText.match(JAPANESE_CHARS) ?? [];
    const japaneseRatio = japaneseMatches.length / Math.max(normalizedText.length, 1);
    const artifactCount = (text.match(ARTIFACT_CHARS) ?? []).length;
    const asciiLetterCount = (normalizedText.match(/[A-Za-z]/g) ?? []).length;
    const averageSymbolConfidence = symbolConfidences.length > 0
        ? symbolConfidences.reduce((sum, symbolConfidence) => sum + symbolConfidence, 0) / symbolConfidences.length
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

export function serializeOcrCandidate(candidate: OcrRecognitionCandidate) {
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

function cleanRecognizedText(text: string): string {
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
