// Chrome's documented Translator catalog. Availability is still checked per pair.
// https://developer.chrome.com/docs/ai/translator-api#supported-languages
export const TRANSLATION_LANGUAGES: readonly { code: string; label: string }[] = [
    { code: 'ar', label: 'Arabic' },
    { code: 'bn', label: 'Bengali' },
    { code: 'bg', label: 'Bulgarian' },
    { code: 'zh', label: 'Chinese' },
    { code: 'zh-Hant', label: 'Chinese (Traditional)' },
    { code: 'hr', label: 'Croatian' },
    { code: 'cs', label: 'Czech' },
    { code: 'da', label: 'Danish' },
    { code: 'nl', label: 'Dutch' },
    { code: 'en', label: 'English' },
    { code: 'fi', label: 'Finnish' },
    { code: 'fr', label: 'French' },
    { code: 'de', label: 'German' },
    { code: 'el', label: 'Greek' },
    { code: 'he', label: 'Hebrew' },
    { code: 'hi', label: 'Hindi' },
    { code: 'hu', label: 'Hungarian' },
    { code: 'id', label: 'Indonesian' },
    { code: 'it', label: 'Italian' },
    { code: 'kn', label: 'Kannada' },
    { code: 'ko', label: 'Korean' },
    { code: 'lt', label: 'Lithuanian' },
    { code: 'mr', label: 'Marathi' },
    { code: 'no', label: 'Norwegian' },
    { code: 'pl', label: 'Polish' },
    { code: 'pt', label: 'Portuguese' },
    { code: 'ro', label: 'Romanian' },
    { code: 'ru', label: 'Russian' },
    { code: 'sk', label: 'Slovak' },
    { code: 'sl', label: 'Slovenian' },
    { code: 'es', label: 'Spanish' },
    { code: 'sv', label: 'Swedish' },
    { code: 'ta', label: 'Tamil' },
    { code: 'te', label: 'Telugu' },
    { code: 'th', label: 'Thai' },
    { code: 'tr', label: 'Turkish' },
    { code: 'uk', label: 'Ukrainian' },
    { code: 'vi', label: 'Vietnamese' },
];

export function normalizeTranslationTarget(value: unknown): string {
    if (typeof value !== 'string') return 'en';
    return TRANSLATION_LANGUAGES.find(({ code }) => code.toLowerCase() === value.trim().toLowerCase())?.code ?? 'en';
}
