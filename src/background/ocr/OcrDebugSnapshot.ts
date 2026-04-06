import type { PSM } from 'tesseract.js';

export type OcrDebugCandidateSnapshot = {
    artifactCount: number;
    averageSymbolConfidence: number;
    confidence: number;
    id: string;
    japaneseRatio: number;
    score: number;
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
};

export type OcrDebugAttemptSnapshot = {
    candidate: OcrDebugCandidateSnapshot | null;
    id: string;
    imagePath?: string;
    imageDataUrl: string;
    normalized: boolean;
    rotated: boolean;
    selected: boolean;
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
};
