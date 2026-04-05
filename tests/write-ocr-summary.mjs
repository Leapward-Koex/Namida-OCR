import fs from 'node:fs/promises';
import path from 'node:path';

const caseResultsDir = path.resolve(process.cwd(), 'test-results', 'ocr-case-results');
const summaryPath = path.resolve(process.cwd(), 'test-results', 'ocr-accuracy-summary.json');

const cases = await loadCaseResults(caseResultsDir);

if (cases.length === 0) {
    console.log('OCR accuracy summary');
    console.log('No OCR case results were found.');
    process.exit(0);
}

const totalCases = cases.length;
const exactMatches = cases.filter((result) => result.exactMatch).length;
const exactMatchRate = exactMatches / totalCases;
const averageCharacterAccuracy = cases.reduce((sum, result) => sum + result.characterAccuracy, 0) / totalCases;
const summary = {
    totalCases,
    exactMatches,
    exactMatchRate,
    averageCharacterAccuracy,
    cases,
};

await fs.mkdir(path.dirname(summaryPath), { recursive: true });
await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));

console.log('OCR accuracy summary');
console.table(cases.map((result) => ({
    case: result.name,
    image: result.image,
    exactMatch: result.exactMatch ? 'yes' : 'no',
    characterAccuracy: formatPercent(result.characterAccuracy),
    expected: result.normalizedExpectedText,
    actual: result.normalizedActualText,
})));
console.log(`Exact matches: ${exactMatches}/${totalCases} (${formatPercent(exactMatchRate)})`);
console.log(`Average character accuracy: ${formatPercent(averageCharacterAccuracy)}`);
console.log(`Saved summary: ${summaryPath}`);

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

    return cases.sort((left, right) => left.name.localeCompare(right.name));
}

function formatPercent(value) {
    return `${(value * 100).toFixed(1)}%`;
}
