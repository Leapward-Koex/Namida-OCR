// OCR line breaks describe image layout, and can split a Japanese phrase or
// word. Chrome's translation model can omit the rest of a passage when those
// breaks (or replacement spaces) are passed through. Unwrap them for the model
// while retaining the complete passage as context; the source is unchanged.
const japaneseEnd = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\u3000-\u303f]$/u;
const japaneseStart = /^[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\u3000-\u303f]/u;

export function prepareTranslationInput(text: string): string {
    if (!/[\r\n\u2028\u2029]/u.test(text)) return text;
    return text.split(/[\r\n\u2028\u2029]+/u)
        .map(line => line.trim())
        .filter(Boolean)
        .reduce((joined, line) => {
            if (!joined) return line;
            // Keep a word separator for non-Japanese boundaries (e.g. Latin
            // words or numbers), and preserve spaces within every OCR line.
            const separator = japaneseEnd.test(joined) || japaneseStart.test(line) ? '' : ' ';
            return joined + separator + line;
        }, '');
}
