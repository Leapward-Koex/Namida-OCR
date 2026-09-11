import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const JSON_TOLERANCE = 1e-9;
const HELP = `Usage: node scripts/check-ocr-regression.mjs [--baseline FILE] [--actual FILE]

Compare OCR accuracy against the original baseline cases. Every baseline case
must occur exactly once in the actual summary. New cases are reported separately
and cannot offset regressions. Checks include each case's character accuracy,
average character accuracy, and exact matches/rate for the baseline case cohort.
JSON baselines also preserve each case's exact-match status.

  --baseline FILE  Default: reports/ocr-performance.md (PaddleOCR ONNX column)
                   Or supply a before-run ocr-accuracy-summary.json.
  --actual FILE    Default: test-results/ocr-accuracy-summary.json
  --help          Show this help.

Markdown scores are compared at the report's one-decimal percentage precision.
JSON scores use a 1e-9 tolerance. Summary totals must agree with case data.
Exit codes: 0 = no regression, 1 = regression/missing case, 2 = invalid input.
`;

function requireScore(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${label} must be a finite number between 0 and 1.`);
    }
    return value;
}

function summarize(cases) {
    const exactMatches = cases.filter((entry) => entry.exactMatch).length;
    return {
        totalCases: cases.length,
        exactMatches,
        exactMatchRate: exactMatches / cases.length,
        averageCharacterAccuracy: cases.reduce((sum, entry) => sum + entry.characterAccuracy, 0) / cases.length,
    };
}

function validateCases(cases, label, requireExactMatch) {
    if (!Array.isArray(cases) || cases.length === 0) {
        throw new Error(`${label}: cases must be a nonempty array.`);
    }
    const names = new Set();
    for (const entry of cases) {
        if (typeof entry?.name !== 'string' || !entry.name.trim()) {
            throw new Error(`${label}: every case must have a nonempty name.`);
        }
        if (names.has(entry.name)) {
            throw new Error(`${label}: duplicate case ${entry.name}.`);
        }
        names.add(entry.name);
        requireScore(entry.characterAccuracy, `${label}: ${entry.name}.characterAccuracy`);
        if (requireExactMatch && typeof entry.exactMatch !== 'boolean') {
            throw new Error(`${label}: ${entry.name}.exactMatch must be a boolean.`);
        }
    }
}

export function parseJsonSummary(value, label = 'JSON summary') {
    validateCases(value?.cases, label, true);
    const calculated = summarize(value.cases);
    for (const key of ['totalCases', 'exactMatches']) {
        if (!Number.isInteger(value[key]) || value[key] !== calculated[key]) {
            throw new Error(`${label}: ${key} must equal the case data (${calculated[key]}).`);
        }
    }
    for (const key of ['exactMatchRate', 'averageCharacterAccuracy']) {
        requireScore(value[key], `${label}: ${key}`);
        if (Math.abs(value[key] - calculated[key]) > JSON_TOLERANCE) {
            throw new Error(`${label}: ${key} disagrees with the case data (${calculated[key]}).`);
        }
    }
    return { ...calculated, cases: value.cases, precision: 'json' };
}

function readMarkdownTable(markdown, section) {
    const body = markdown.split(new RegExp(`^## ${section}\\s*$`, 'm'))[1]?.split(/^## /m)[0];
    const rows = body?.split(/\r?\n/).filter((line) => line.trim().startsWith('|'))
        .map((line) => line.trim().slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|')));
    if (!rows || rows.length < 3) {
        throw new Error(`Markdown baseline: missing ${section} table.`);
    }
    const [headers, , ...data] = rows;
    return data.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
}

function parsePercent(value, label) {
    if (typeof value !== 'string' || !/^\d+(?:\.\d)?%$/.test(value)) {
        throw new Error(`Markdown baseline: ${label} must be a percentage with at most one decimal place.`);
    }
    return requireScore(Number(value.slice(0, -1)) / 100, `Markdown baseline: ${label}`);
}

function roundedPercent(value) {
    return Number((value * 100).toFixed(1));
}

export function parseMarkdownBaseline(markdown) {
    const summaries = readMarkdownTable(markdown, 'Summary').filter((row) => row.Backend === 'PaddleOCR ONNX');
    if (summaries.length !== 1) {
        throw new Error('Markdown baseline: expected exactly one PaddleOCR ONNX summary row.');
    }
    const row = summaries[0];
    const counts = /^(\d+)\/(\d+)$/.exec(row['Exact Matches']);
    if (!counts) {
        throw new Error('Markdown baseline: missing or invalid Exact Matches count.');
    }
    const exactMatches = Number(counts[1]);
    const totalCases = Number(counts[2]);
    const cases = readMarkdownTable(markdown, 'Case Accuracy').map((entry) => ({
        name: entry.Case,
        characterAccuracy: parsePercent(entry['PaddleOCR ONNX'], `${entry.Case}.characterAccuracy`),
    }));
    validateCases(cases, 'Markdown baseline', false);
    if (totalCases !== cases.length || exactMatches > totalCases) {
        throw new Error('Markdown baseline: Exact Matches counts disagree with the case table.');
    }
    const exactMatchRate = parsePercent(row['Exact Match Rate'], 'Exact Match Rate');
    const averageCharacterAccuracy = parsePercent(row['Avg Character Accuracy'], 'Avg Character Accuracy');
    if (roundedPercent(exactMatches / totalCases) !== roundedPercent(exactMatchRate)) {
        throw new Error('Markdown baseline: Exact Match Rate disagrees with Exact Matches.');
    }
    // The aggregate is rounded independently of the case percentages.
    if (Math.abs(summarize(cases).averageCharacterAccuracy - averageCharacterAccuracy) > 0.001 + JSON_TOLERANCE) {
        throw new Error('Markdown baseline: average accuracy disagrees with the case table beyond rounding.');
    }
    return { cases, totalCases, exactMatches, exactMatchRate, averageCharacterAccuracy, precision: 'markdown' };
}

export function compareSummaries(baseline, actual) {
    const isLower = baseline.precision === 'markdown'
        ? (before, after) => roundedPercent(after) < roundedPercent(before)
        : (before, after) => after < before - JSON_TOLERANCE;
    const actualByName = new Map(actual.cases.map((entry) => [entry.name, entry]));
    const baselineNames = new Set(baseline.cases.map((entry) => entry.name));
    const regressions = [];
    const changes = [];
    const matched = [];
    for (const before of baseline.cases) {
        const after = actualByName.get(before.name);
        if (!after) {
            regressions.push(`Missing baseline case: ${before.name}`);
            continue;
        }
        for (const field of ['image', 'normalizedExpectedText']) {
            if (before[field] !== undefined && after[field] !== before[field]) {
                throw new Error(`${before.name}: ${field} changed; these are not comparable benchmark cases.`);
            }
        }
        if (before.input?.mode && before.input.mode !== after.input?.mode) {
            throw new Error(`${before.name}: input mode changed; these are not comparable benchmark runs.`);
        }
        if (before.input?.sha256 && before.input.sha256 !== after.input?.sha256) {
            throw new Error(`${before.name}: input image data changed (PNG SHA256 mismatch); rerun with fixed fixture inputs.`);
        }
        matched.push(after);
        const accuracyRegression = isLower(before.characterAccuracy, after.characterAccuracy);
        const exactRegression = before.exactMatch === true && !after.exactMatch;
        const detail = `${before.name}: ${percent(before.characterAccuracy)} -> ${percent(after.characterAccuracy)}`;
        if (accuracyRegression || exactRegression) {
            regressions.push(`${detail}${exactRegression ? ' (lost exact match)' : ''}`);
        } else if (isLower(after.characterAccuracy, before.characterAccuracy) || (before.exactMatch === false && after.exactMatch)) {
            changes.push(`${detail}${before.exactMatch === false && after.exactMatch ? ' (gained exact match)' : ''}`);
        }
    }
    const cohort = matched.length === baseline.totalCases ? summarize(matched) : null;
    if (cohort) {
        if (isLower(baseline.averageCharacterAccuracy, cohort.averageCharacterAccuracy)) {
            regressions.push(`Average character accuracy: ${percent(baseline.averageCharacterAccuracy)} -> ${percent(cohort.averageCharacterAccuracy)}`);
        }
        if (cohort.exactMatches < baseline.exactMatches) {
            regressions.push(`Exact matches: ${baseline.exactMatches}/${baseline.totalCases} -> ${cohort.exactMatches}/${cohort.totalCases}`);
        }
        if (isLower(baseline.exactMatchRate, cohort.exactMatchRate)) {
            regressions.push(`Exact match rate: ${percent(baseline.exactMatchRate)} -> ${percent(cohort.exactMatchRate)}`);
        }
    }
    return { regressions, changes, cohort, addedCases: actual.cases.filter((entry) => !baselineNames.has(entry.name)) };
}

function percent(value) {
    // Extra digits make small JSON regressions actionable, even below report precision.
    return `${Number((value * 100).toFixed(8))}%`;
}

async function main(args) {
    if (args.includes('--help')) {
        console.log(HELP);
        return;
    }
    const options = { '--baseline': 'reports/ocr-performance.md', '--actual': 'test-results/ocr-accuracy-summary.json' };
    for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        if (!Object.hasOwn(options, flag)) throw new Error(`Unknown argument: ${flag}. Use --help.`);
        const value = args[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
        options[flag] = value;
    }
    const baselinePath = path.resolve(options['--baseline']);
    const actualPath = path.resolve(options['--actual']);
    const [baselineBody, actualBody] = await Promise.all([fs.readFile(baselinePath, 'utf8'), fs.readFile(actualPath, 'utf8')]);
    const baseline = path.extname(baselinePath).toLowerCase() === '.md'
        ? parseMarkdownBaseline(baselineBody)
        : parseJsonSummary(JSON.parse(baselineBody), 'Baseline');
    const actual = parseJsonSummary(JSON.parse(actualBody), 'Actual');
    const result = compareSummaries(baseline, actual);
    console.log(`Baseline: ${baselinePath}\nActual: ${actualPath}`);
    console.log(`Compared ${baseline.totalCases} baseline cases (${baseline.precision === 'markdown' ? 'one-decimal percentage precision' : '1e-9 tolerance'}).`);
    for (const detail of result.changes) console.log(`IMPROVED: ${detail}`);
    for (const entry of result.addedCases) console.log(`ADDED: ${entry.name}: ${percent(entry.characterAccuracy)} (excluded from baseline comparison)`);
    if (result.cohort) {
        console.log(`Average character accuracy: ${percent(baseline.averageCharacterAccuracy)} -> ${percent(result.cohort.averageCharacterAccuracy)}`);
        console.log(`Exact matches: ${baseline.exactMatches}/${baseline.totalCases} -> ${result.cohort.exactMatches}/${result.cohort.totalCases}`);
    }
    for (const detail of result.regressions) console.error(`REGRESSION: ${detail}`);
    console.log(result.regressions.length ? `FAIL: ${result.regressions.length} regression checks failed.` : 'PASS: no OCR accuracy regressions.');
    process.exitCode = result.regressions.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    try {
        await main(process.argv.slice(2));
    } catch (error) {
        console.error(`Invalid OCR comparison: ${error.message}`);
        process.exitCode = 2;
    }
}
