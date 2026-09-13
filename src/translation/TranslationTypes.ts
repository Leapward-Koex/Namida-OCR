export interface TranslationSettings {
    /** Unset means translate automatically only when the selected pair is ready. */
    enabled?: boolean;
    targetLanguage: string;
}

export interface TranslationStatus {
    state: 'unsupported' | 'unavailable' | 'downloadable' | 'downloading' | 'available' | 'error';
    message?: string;
}

export type TranslationResult =
    | { ok: true; text: string }
    | { ok: false; reason: 'unsupported' | 'unavailable' | 'setup-required' | 'cancelled' | 'timeout' | 'error'; message: string };

export interface TranslationRequest {
    requestId: string;
    text: string;
    targetLanguage: string;
}

export interface TranslationStatusRequest {
    targetLanguage: string;
    ensureHost?: boolean;
}

export interface TranslationCancelRequest {
    requestId: string;
}
