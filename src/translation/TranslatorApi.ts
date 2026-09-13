export type TranslatorAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export interface TranslatorLanguagePair {
    sourceLanguage: string;
    targetLanguage: string;
}

export interface TranslatorDownloadProgressEvent {
    loaded: number;
}

export interface TranslatorDownloadMonitor {
    addEventListener(type: 'downloadprogress', listener: (event: TranslatorDownloadProgressEvent) => void): void;
}

export interface TranslatorSession {
    translate(text: string, options?: { signal?: AbortSignal }): Promise<string>;
    destroy(): void;
}

export interface TranslatorFactory {
    availability(options: TranslatorLanguagePair): Promise<TranslatorAvailability>;
    create(options: TranslatorLanguagePair & {
        signal?: AbortSignal;
        monitor?: (monitor: TranslatorDownloadMonitor) => void;
    }): Promise<TranslatorSession>;
}

export function isTranslationPlatformSupported(): boolean {
    return __NAMIDA_TRANSLATION_ENABLED__
        && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function getTranslatorApi(): TranslatorFactory | null {
    if (!isTranslationPlatformSupported()) return null;
    // Use feature detection in each document. Browser identity alone says nothing
    // about API availability (policy, platform and browser versions all vary).
    if ('Translator' in self) {
        const api = (self as typeof self & { Translator?: TranslatorFactory }).Translator;
        if (api && typeof api.availability === 'function' && typeof api.create === 'function') return api;
    }
    return null;
}
