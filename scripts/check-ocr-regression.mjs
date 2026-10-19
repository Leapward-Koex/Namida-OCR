import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { scoreOcrText, summarizeOcrCases as summarize, summarizeOcrCohorts } from './ocr-scoring.mjs';

const JSON_TOLERANCE = 1e-9;
const HELP = `Usage: node scripts/check-ocr-regression.mjs [--baseline FILE] [--actual FILE]

Compare OCR accuracy against the original baseline cases. Every baseline case
must occur exactly once in the actual summary. New cases are reported separately
and cannot offset regressions. Checks include each case's character accuracy,
average character accuracy, and exact matches/rate for the baseline case cohort.
JSON baselines also preserve each case's exact-match status and separately check
spacing-sensitive accuracy. Inline whitespace is retained; Japanese layout line
breaks are removed, and breaks between Latin letters/numbers become one space.
The original-20 and general-10 fixture cohorts are checked independently.

  --baseline FILE  Default: reports/ocr-performance.md (PaddleOCR ONNX column)
                   Or supply a before-run ocr-accuracy-summary.json.
  --actual FILE    Default: test-results/ocr-accuracy-summary.json
  --help          Show this help.

Markdown scores are compared at the report's one-decimal percentage precision.
JSON scores use a 1e-9 tolerance. Scores with raw text are recomputed and checked;
legacy raw JSON also gains spacing-sensitive checks. Summary totals must agree
with case data. Markdown baselines retain their historical whitespace-free metric.
Exit codes: 0 = no regression, 1 = regression/missing case, 2 = invalid input.
`;

function requireScore(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`${label} must be a finite number between 0 and 1.`);
    }
    return value;
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
    if (value?.schemaVersion !== undefined && value.schemaVersion !== 2) {
        throw new Error(`${label}: unsupported schemaVersion ${value.schemaVersion}.`);
    }
    const strict = value?.schemaVersion === 2;
    if (Object.hasOwn(value ?? {}, 'run')) {
        if (!value.run || typeof value.run !== 'object' || Array.isArray(value.run)) {
            throw new Error(`${label}: run metadata must be an object.`);
        }
        if (Object.hasOwn(value.run, 'status') && value.run.status !== 'passed') {
            throw new Error(`${label}: run.status must be passed; failed or incomplete browser runs are not accuracy evidence.`);
        }
        for (const field of ['exitCode', 'buildExitCode', 'testExitCode', 'summaryExitCode']) {
            if (Object.hasOwn(value.run, field) && value.run[field] !== 0) {
                throw new Error(`${label}: run.${field} must be 0; failed or incomplete runs cannot pass the accuracy gate.`);
            }
        }
    }
    validateCases(value?.cases, label, true);
    const cases = value.cases.map((entry) => {
        const hasRawText = Object.hasOwn(entry, 'expectedText') || Object.hasOwn(entry, 'actualText');
        const hasSpacingMetric = Object.keys(entry).some((key) => key.startsWith('spacingSensitive') || key === 'rawExactMatch');
        if (!hasRawText && !hasSpacingMetric && !strict) return entry;
        if (typeof entry.expectedText !== 'string' || typeof entry.actualText !== 'string') {
            throw new Error(`${label}: ${entry.name} requires raw expectedText and actualText strings to verify its scores.`);
        }
        const scores = scoreOcrText(entry.expectedText, entry.actualText);
        for (const [key, calculated] of Object.entries(scores)) {
            if (!Object.hasOwn(entry, key) && !strict) continue;
            if (key.toLowerCase().endsWith('characteraccuracy')) requireScore(entry[key], `${label}: ${entry.name}.${key}`);
            const agrees = typeof calculated === 'number'
                ? key.toLowerCase().endsWith('editdistance')
                    ? Number.isInteger(entry[key]) && entry[key] === calculated
                    : typeof entry[key] === 'number' && Number.isFinite(entry[key]) && Math.abs(entry[key] - calculated) <= JSON_TOLERANCE
                : entry[key] === calculated;
            if (!agrees) throw new Error(`${label}: ${entry.name}.${key} disagrees with raw text (expected ${JSON.stringify(calculated)}).`);
        }
        return { ...entry, ...scores };
    });
    if (cases.some((entry) => entry.spacingSensitiveCharacterAccuracy !== undefined)
        && !cases.every((entry) => entry.spacingSensitiveCharacterAccuracy !== undefined)) {
        throw new Error(`${label}: all cases need raw text for spacing-sensitive scoring; partial metrics cannot be dropped.`);
    }
    const calculated = summarize(cases);
    validateAggregate(value, calculated, label, strict);
    const cohorts = summarizeOcrCohorts(cases);
    if (strict || Object.hasOwn(value, 'cohorts')) {
        if (!value.cohorts || typeof value.cohorts !== 'object' || Array.isArray(value.cohorts)
            || Object.keys(value.cohorts).sort().join(',') !== Object.keys(cohorts).sort().join(',')) {
            throw new Error(`${label}: cohorts must contain exactly the groups present in the case data.`);
        }
        for (const name of Object.keys(cohorts)) validateAggregate(value.cohorts[name], cohorts[name], `${label}: ${name} cohort`, strict);
    }
    return { ...value, ...calculated, cases, cohorts, precision: 'json' };
}

function validateAggregate(value, calculated, label, strict) {
    const countFields = ['totalCases', 'exactMatches', 'spacingSensitiveExactMatches'];
    const scoreFields = ['exactMatchRate', 'averageCharacterAccuracy', 'spacingSensitiveExactMatchRate', 'averageSpacingSensitiveCharacterAccuracy'];
    for (const key of [...countFields, ...scoreFields]) {
        const isSpacing = key.toLowerCase().includes('spacingsensitive');
        if (isSpacing && !strict && !Object.hasOwn(value, key)) continue;
        if (calculated[key] === undefined) throw new Error(`${label}: ${key} cannot be validated without raw case text.`);
        if (countFields.includes(key)) {
            if (!Number.isInteger(value[key]) || value[key] !== calculated[key]) {
                throw new Error(`${label}: ${key} must equal the case data (${calculated[key]}).`);
            }
        } else {
            requireScore(value[key], `${label}: ${key}`);
            if (Math.abs(value[key] - calculated[key]) > JSON_TOLERANCE) {
                throw new Error(`${label}: ${key} disagrees with the case data (${calculated[key]}).`);
            }
        }
    }
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
    return { cases, totalCases, exactMatches, exactMatchRate, averageCharacterAccuracy, cohorts: summarizeOcrCohorts(cases), precision: 'markdown' };
}

export function compareSummaries(baseline, actual) {
    for (const field of ['backend', 'model', 'paddleOnnxModelVariant']) {
        if (baseline[field] !== undefined && baseline[field] !== actual[field]) {
            throw new Error(`${field} changed or is missing; these are not comparable benchmark runs.`);
        }
    }
    for (const field of ['inputMode', 'provider']) {
        if (baseline.run?.[field] !== undefined && baseline.run[field] !== actual.run?.[field]) {
            throw new Error(`run.${field} changed or is missing; these are not comparable benchmark runs.`);
        }
    }
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
        for (const field of ['image', 'expectedText', 'normalizedExpectedText', 'spacingSensitiveExpectedText']) {
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
        if (before.spacingSensitiveCharacterAccuracy !== undefined) {
            if (after.spacingSensitiveCharacterAccuracy === undefined) {
                throw new Error(`${before.name}: spacing-sensitive baseline metrics are missing from the actual run.`);
            }
            const lostExact = before.spacingSensitiveExactMatch && !after.spacingSensitiveExactMatch;
            const gainedExact = !before.spacingSensitiveExactMatch && after.spacingSensitiveExactMatch;
            const spacingDetail = `${before.name} spacing-sensitive: ${percent(before.spacingSensitiveCharacterAccuracy)} -> ${percent(after.spacingSensitiveCharacterAccuracy)}`;
            if (isLower(before.spacingSensitiveCharacterAccuracy, after.spacingSensitiveCharacterAccuracy) || lostExact) {
                regressions.push(`${spacingDetail}${lostExact ? ' (lost exact match)' : ''}`);
            } else if (isLower(after.spacingSensitiveCharacterAccuracy, before.spacingSensitiveCharacterAccuracy) || gainedExact) {
                changes.push(`${spacingDetail}${gainedExact ? ' (gained exact match)' : ''}`);
            }
        }
    }
    const cohort = matched.length === baseline.totalCases ? summarize(matched) : null;
    if (cohort) {
        compareAggregate(baseline, cohort, '', true);
    }
    const cohorts = cohort ? summarizeOcrCohorts(matched) : {};
    for (const [name, before] of Object.entries(baseline.cohorts ?? {})) {
        if (cohorts[name]) compareAggregate(before, cohorts[name], `${name} cohort: `, baseline.precision === 'json');
    }
    return { regressions, changes, cohort, cohorts, addedCases: actual.cases.filter((entry) => !baselineNames.has(entry.name)) };

    function compareAggregate(before, after, prefix, compareExact) {
        for (const [average, count, rate, labels] of [
            ['averageCharacterAccuracy', 'exactMatches', 'exactMatchRate', ['Average character accuracy', 'Exact matches', 'Exact match rate']],
            ['averageSpacingSensitiveCharacterAccuracy', 'spacingSensitiveExactMatches', 'spacingSensitiveExactMatchRate', ['Spacing-sensitive average character accuracy', 'Spacing-sensitive exact matches', 'Spacing-sensitive exact match rate']],
        ]) {
            if (before[average] === undefined) continue;
            if (after[average] === undefined) throw new Error(`${prefix}${average} baseline metric is missing from the actual run.`);
            if (isLower(before[average], after[average])) {
                regressions.push(`${prefix}${labels[0]}: ${percent(before[average])} -> ${percent(after[average])}`);
            }
            if (compareExact && after[count] < before[count]) {
                regressions.push(`${prefix}${labels[1]}: ${before[count]}/${before.totalCases} -> ${after[count]}/${after.totalCases}`);
            }
            if (compareExact && isLower(before[rate], after[rate])) {
                regressions.push(`${prefix}${labels[2]}: ${percent(before[rate])} -> ${percent(after[rate])}`);
            }
        }
    }
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
        if (result.cohort.averageSpacingSensitiveCharacterAccuracy !== undefined) {
            console.log(`Spacing-sensitive average character accuracy: ${baseline.averageSpacingSensitiveCharacterAccuracy === undefined ? 'unavailable in historical report' : percent(baseline.averageSpacingSensitiveCharacterAccuracy)} -> ${percent(result.cohort.averageSpacingSensitiveCharacterAccuracy)}`);
            console.log(`Spacing-sensitive exact matches: ${baseline.spacingSensitiveExactMatches ?? 'unavailable'}/${baseline.totalCases} -> ${result.cohort.spacingSensitiveExactMatches}/${result.cohort.totalCases}`);
        }
        for (const [name, after] of Object.entries(result.cohorts)) {
            console.log(`${name} cohort (${after.totalCases} cases): ${percent(after.averageCharacterAccuracy)} character accuracy${after.averageSpacingSensitiveCharacterAccuracy === undefined ? '' : `, ${percent(after.averageSpacingSensitiveCharacterAccuracy)} spacing-sensitive`}`);
        }
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
