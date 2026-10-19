// The historical metric is intentionally unchanged for report compatibility.
export function normalizeOcrText(text) {
    return (text ?? '').replace(/\s+/g, '');
}

// Ignore layout line breaks while preserving every inline whitespace character,
// including leading/trailing spaces, repeated spaces, tabs and full-width spaces.
// A break between Latin letters or numbers separates words; Japanese layout
// breaks concatenate without inserting a space. No Unicode normalization occurs.
export function normalizeSpacingSensitiveOcrText(text) {
    const normalizedBreaks = (text ?? '').replace(/\r\n?|\u2028|\u2029/g, '\n');
    const wordCharacter = /[\p{Script=Latin}\p{Number}]/u;
    return normalizedBreaks.replace(/\n+/g, (breaks, offset, source) => {
        const before = Array.from(source.slice(0, offset)).at(-1) ?? '';
        const after = Array.from(source.slice(offset + breaks.length))[0] ?? '';
        return wordCharacter.test(before) && wordCharacter.test(after) ? ' ' : '';
    });
}

export function scoreOcrText(expectedText, actualText) {
    const normalizedExpectedText = normalizeOcrText(expectedText);
    const normalizedActualText = normalizeOcrText(actualText);
    const spacingSensitiveExpectedText = normalizeSpacingSensitiveOcrText(expectedText);
    const spacingSensitiveActualText = normalizeSpacingSensitiveOcrText(actualText);
    const historical = scoreStrings(normalizedExpectedText, normalizedActualText);
    const spacingSensitive = scoreStrings(spacingSensitiveExpectedText, spacingSensitiveActualText);
    return {
        normalizedExpectedText,
        normalizedActualText,
        exactMatch: historical.exactMatch,
        editDistance: historical.editDistance,
        characterAccuracy: historical.characterAccuracy,
        spacingSensitiveExpectedText,
        spacingSensitiveActualText,
        spacingSensitiveExactMatch: spacingSensitive.exactMatch,
        spacingSensitiveEditDistance: spacingSensitive.editDistance,
        spacingSensitiveCharacterAccuracy: spacingSensitive.characterAccuracy,
        rawExactMatch: expectedText === actualText,
    };
}

function scoreStrings(expected, actual) {
    const editDistance = levenshteinDistance(expected, actual);
    return {
        exactMatch: expected === actual,
        editDistance,
        characterAccuracy: 1 - editDistance / Math.max(expected.length, actual.length, 1),
    };
}

function levenshteinDistance(left, right) {
    // Preserve the historical UTF-16 distance semantics for existing reports.
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let row = 1; row <= left.length; row += 1) {
        const current = [row];
        for (let col = 1; col <= right.length; col += 1) {
            current[col] = Math.min(
                previous[col] + 1,
                current[col - 1] + 1,
                previous[col - 1] + (left[row - 1] === right[col - 1] ? 0 : 1),
            );
        }
        previous = current;
    }
    return previous[right.length];
}

export function summarizeOcrCases(cases) {
    const exactMatches = cases.filter((entry) => entry.exactMatch).length;
    const summary = {
        totalCases: cases.length,
        exactMatches,
        exactMatchRate: exactMatches / cases.length,
        averageCharacterAccuracy: cases.reduce((sum, entry) => sum + entry.characterAccuracy, 0) / cases.length,
    };
    if (cases.every((entry) => typeof entry.spacingSensitiveExactMatch === 'boolean')) {
        const spacingSensitiveExactMatches = cases.filter((entry) => entry.spacingSensitiveExactMatch).length;
        Object.assign(summary, {
            spacingSensitiveExactMatches,
            spacingSensitiveExactMatchRate: spacingSensitiveExactMatches / cases.length,
            averageSpacingSensitiveCharacterAccuracy: cases.reduce((sum, entry) => sum + entry.spacingSensitiveCharacterAccuracy, 0) / cases.length,
        });
    }
    return summary;
}

export function summarizeOcrCohorts(cases) {
    const cohorts = {};
    // Classify only the frozen original-20/general-10 fixture identities. Future
    // additions remain in the overall summary and cannot inflate these cohorts.
    const original = cases.filter(({ name }) => /^manga-ocr-case-00[1-7]-/.test(name)
        || /^case-(?:00[1-9]|01[0-3])(?:-|$)/.test(name));
    const general = cases.filter(({ name }) => /^general-(?:00[1-9]|010)-/.test(name));
    if (original.length) cohorts.original = summarizeOcrCases(original);
    if (general.length) cohorts.general = summarizeOcrCases(general);
    return cohorts;
}
