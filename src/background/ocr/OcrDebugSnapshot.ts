import type { PSM } from 'tesseract.js';

export type OcrDebugCandidateSnapshot = {
    /** Legacy heuristic fields are absent in the reference Paddle pipeline. */
    artifactCount?: number;
    averageSymbolConfidence?: number;
    confidence: number;
    id: string;
    japaneseRatio?: number;
    score?: number;
    text: string;
};

export type OcrDebugBoxSnapshot = {
    averageScore: number;
    bottom: number;
    height: number;
    left: number;
    right: number;
    top: number;
    width: number;
    points?: readonly { x: number; y: number }[];
};

export type OcrDebugAttemptSnapshot = {
    candidate: OcrDebugCandidateSnapshot | null;
    id: string;
    imagePath?: string;
    imageDataUrl: string;
    normalized: boolean;
    rotated: boolean;
    selected: boolean;
    tokens?: readonly { text: string; confidence: number; timestep: number; classIndex: number }[];
    inputShape?: readonly number[];
    contentWidth?: number;
    widthClamped?: boolean;
};

export type OcrDebugCropSnapshot = {
    attempts: OcrDebugAttemptSnapshot[];
    box: OcrDebugBoxSnapshot | null;
    id: string;
    imagePath?: string;
    imageDataUrl: string;
    selectedCandidate: OcrDebugCandidateSnapshot | null;
    source: 'detector' | 'full-crop' | 'projection';
};

export type OcrDebugSnapshot = {
    schemaVersion?: number;
    backend: string;
    candidates: {
        detected: OcrDebugCandidateSnapshot | null;
        fullCrop: OcrDebugCandidateSnapshot | null;
        projected: OcrDebugCandidateSnapshot | null;
        selected: OcrDebugCandidateSnapshot | null;
    };
    createdAt: string;
    detectedGroups: OcrDebugCropSnapshot[];
    fullCrop: OcrDebugCropSnapshot | null;
    pageSegMode: PSM;
    projectedGroups: OcrDebugCropSnapshot[];
    workingImagePath?: string;
    workingImageDataUrl: string;
    pipeline?: {
        modelVariant: string;
        direction: 'horizontal' | 'vertical';
        detectorInputShape: readonly number[];
        detectorParameters: Record<string, unknown>;
        recognitionParameters: Record<string, unknown>;
        detectorRuns: number;
        recognitionRuns: number;
        elapsedMs: number;
        recovery: string[];
    };
};
