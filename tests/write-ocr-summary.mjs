import fs from 'node:fs/promises';
import path from 'node:path';
import { summarizeOcrCases, summarizeOcrCohorts } from '../scripts/ocr-scoring.mjs';
import { parseJsonSummary } from '../scripts/check-ocr-regression.mjs';

const caseResultsDir = path.resolve(process.cwd(), 'test-results', 'ocr-case-results');
const summaryPath = path.resolve(process.cwd(), 'test-results', 'ocr-accuracy-summary.json');
const resultsPath = path.resolve(process.cwd(), 'test-results', 'ocr-case-results.json');

let cases = await loadCaseResults(caseResultsDir);

if (cases.length === 0) {
    console.log('OCR accuracy summary');
    console.log('No OCR case results were found.');
    process.exit(0);
}

// Legacy case JSON can still be summarized, but its raw text must substantiate
// every recorded score. The parser derives the additional metric when needed.
cases = parseJsonSummary({ ...summarizeOcrCases(cases), cases }).cases;
const summary = {
    schemaVersion: 2,
    ...summarizeOcrCases(cases),
    cohorts: summarizeOcrCohorts(cases),
    cases,
};
parseJsonSummary(summary);

await fs.mkdir(path.dirname(summaryPath), { recursive: true });
await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
await fs.writeFile(resultsPath, JSON.stringify(cases, null, 2));

console.log('OCR accuracy summary');
console.table(cases.map((result) => ({
    case: result.name,
    image: result.image,
    exactMatch: result.exactMatch ? 'yes' : 'no',
    characterAccuracy: formatPercent(result.characterAccuracy),
    spacingSensitiveAccuracy: formatPercent(result.spacingSensitiveCharacterAccuracy),
    expected: result.normalizedExpectedText,
    actual: result.normalizedActualText,
})));
console.log(`Exact matches: ${summary.exactMatches}/${summary.totalCases} (${formatPercent(summary.exactMatchRate)})`);
console.log(`Average character accuracy: ${formatPercent(summary.averageCharacterAccuracy)}`);
console.log(`Spacing-sensitive exact matches: ${summary.spacingSensitiveExactMatches}/${summary.totalCases} (${formatPercent(summary.spacingSensitiveExactMatchRate)})`);
console.log(`Spacing-sensitive average character accuracy: ${formatPercent(summary.averageSpacingSensitiveCharacterAccuracy)}`);
for (const [name, cohort] of Object.entries(summary.cohorts)) {
    console.log(`${name} cohort (${cohort.totalCases} cases): ${formatPercent(cohort.averageCharacterAccuracy)} character accuracy; ${formatPercent(cohort.averageSpacingSensitiveCharacterAccuracy)} spacing-sensitive`);
}
console.log(`Saved summary: ${summaryPath}`);
console.log(`Saved results: ${resultsPath}`);

async function loadCaseResults(resultsDir) {
    let entries = [];

    try {
        entries = await fs.readdir(resultsDir, { withFileTypes: true });
    } catch {
        return [];
    }

    const cases = await Promise.all(entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => {
            const resultPath = path.join(resultsDir, entry.name);
            const body = await fs.readFile(resultPath, 'utf8');
            return JSON.parse(body);
        }));

    return cases.sort((left, right) => {
        const leftIndex = Number.isInteger(left.caseIndex) ? left.caseIndex : Number.MAX_SAFE_INTEGER;
        const rightIndex = Number.isInteger(right.caseIndex) ? right.caseIndex : Number.MAX_SAFE_INTEGER;

        if (leftIndex !== rightIndex) {
            return leftIndex - rightIndex;
        }

        return left.name.localeCompare(right.name);
    });
}

function formatPercent(value) {
    return `${(value * 100).toFixed(1)}%`;
}
