import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compareSummaries, parseJsonSummary, parseMarkdownBaseline } from '../scripts/check-ocr-regression.mjs';
import { scoreOcrText, summarizeOcrCases, summarizeOcrCohorts } from '../scripts/ocr-scoring.mjs';

function summary(cases) {
    const exactMatches = cases.filter((entry) => entry.exactMatch).length;
    return {
        cases,
        totalCases: cases.length,
        exactMatches,
        exactMatchRate: exactMatches / cases.length,
        averageCharacterAccuracy: cases.reduce((sum, entry) => sum + entry.characterAccuracy, 0) / cases.length,
    };
}

const result = (name, characterAccuracy, exactMatch = false) => ({ name, characterAccuracy, exactMatch });
const scoredResult = (name, expectedText, actualText = expectedText) => ({ name, expectedText, actualText, ...scoreOcrText(expectedText, actualText) });
const strictSummary = (cases) => ({ schemaVersion: 2, ...summarizeOcrCases(cases), cohorts: summarizeOcrCohorts(cases), cases });
const markdown = `## Summary

| Backend | Exact Matches | Exact Match Rate | Avg Character Accuracy |
| --- | --- | --- | --- |
| Tesseract | 0/2 | 0.0% | 0.0% |
| PaddleOCR ONNX | 1/2 | 50.0% | 83.3% |

## Case Accuracy

| Case | Tesseract | PaddleOCR ONNX | Delta |
| --- | --- | --- | --- |
| exact | 0.0% | 100.0% | +100.0 pp |
| partial | 0.0% | 66.7% | +66.7 pp |
`;

test('reads the committed report Paddle column and its complete case cohort', async () => {
    const body = await fs.readFile(new URL('../reports/ocr-performance.md', import.meta.url), 'utf8');
    const baseline = parseMarkdownBaseline(body);
    assert.equal(baseline.cases.length, baseline.totalCases);
    assert.ok(baseline.totalCases > 0);
    assert.equal(baseline.precision, 'markdown');
});

test('Markdown rounding permits identical underlying fractions but rejects a lower displayed score', () => {
    const baseline = parseMarkdownBaseline(markdown);
    const unchanged = parseJsonSummary(summary([result('exact', 1, true), result('partial', 2 / 3)]));
    assert.deepEqual(compareSummaries(baseline, unchanged).regressions, []);
    const regressed = parseJsonSummary(summary([result('exact', 1, true), result('partial', 0.666)]));
    assert.ok(compareSummaries(baseline, regressed).regressions.some((entry) => entry.startsWith('partial:')));
});

test('JSON precision catches changes below Markdown rounding and tolerates numerical noise', () => {
    const baseline = parseJsonSummary(summary([result('tiny-change', 0.8)]));
    const noise = parseJsonSummary(summary([result('tiny-change', 0.8 - 5e-10)]));
    assert.deepEqual(compareSummaries(baseline, noise).regressions, []);
    const changed = parseJsonSummary(summary([result('tiny-change', 0.8 - 1e-7)]));
    assert.ok(compareSummaries(baseline, changed).regressions.some((entry) => entry.startsWith('tiny-change:')));
});

test('one case improvement cannot hide another case regression', () => {
    const baseline = parseJsonSummary(summary([result('down', 0.8), result('up', 0.4)]));
    const actual = parseJsonSummary(summary([result('up', 0.9), result('down', 0.7)]));
    const comparison = compareSummaries(baseline, actual);
    assert.equal(comparison.regressions.length, 1);
    assert.match(comparison.regressions[0], /^down:/);
    assert.equal(comparison.changes.length, 1);
});

test('Markdown aggregate regression is caught even when individual rounded scores are unchanged', () => {
    const baseline = parseMarkdownBaseline(markdown
        .replace('1/2', '0/2').replace('50.0%', '0.0%').replace('83.3%', '58.4%')
        .replace('| exact | 0.0% | 100.0%', '| exact | 0.0% | 66.7%')
        .replace('| partial | 0.0% | 66.7%', '| partial | 0.0% | 50.0%'));
    const actual = parseJsonSummary(summary([result('exact', 0.6666), result('partial', 0.4996)]));
    const comparison = compareSummaries(baseline, actual);
    assert.equal(comparison.regressions.length, 1);
    assert.match(comparison.regressions[0], /^Average character accuracy:/);
});

test('added easy cases cannot offset the original cohort aggregate or exact-match regressions', () => {
    const baseline = parseJsonSummary(summary([result('old', 1, true)]));
    const actual = parseJsonSummary(summary([result('old', 0.9), result('new', 1, true)]));
    const comparison = compareSummaries(baseline, actual);
    assert.equal(comparison.addedCases.length, 1);
    assert.equal(comparison.cohort.totalCases, 1);
    assert.equal(comparison.cohort.averageCharacterAccuracy, 0.9);
    assert.ok(comparison.regressions.some((entry) => entry.startsWith('Average character accuracy:')));
    assert.ok(comparison.regressions.some((entry) => entry.startsWith('Exact matches:')));
    assert.ok(comparison.regressions.some((entry) => entry.startsWith('Exact match rate:')));
});

test('adding harder new cases preserves a passing unchanged baseline cohort', () => {
    const before = [result('old', 1, true)];
    const comparison = compareSummaries(
        parseJsonSummary(summary(before)),
        parseJsonSummary(summary([...before, result('new', 0)])),
    );
    assert.deepEqual(comparison.regressions, []);
    assert.equal(comparison.addedCases.length, 1);
});

test('JSON exact-match preservation is checked even when total exact matches are unchanged', () => {
    const baseline = parseJsonSummary(summary([result('old-exact', 1, true), result('new-exact', 0.9)]));
    const actual = parseJsonSummary(summary([result('old-exact', 1, false), result('new-exact', 1, true)]));
    assert.deepEqual(compareSummaries(baseline, actual).regressions, ['old-exact: 100% -> 100% (lost exact match)']);
});

test('missing baseline cases fail without comparing incomplete cohort averages', () => {
    const baseline = parseJsonSummary(summary([result('keep', 1, true), result('missing', 0.8)]));
    const actual = parseJsonSummary(summary([result('keep', 1, true)]));
    const comparison = compareSummaries(baseline, actual);
    assert.deepEqual(comparison.regressions, ['Missing baseline case: missing']);
    assert.equal(comparison.cohort, null);
});

test('changed images or expected text cannot masquerade as accuracy improvements', () => {
    const before = { ...result('same-name', 0.8), image: 'original.png', normalizedExpectedText: '日本' };
    const baseline = parseJsonSummary(summary([before]));
    for (const replacement of [{ image: 'easier.png' }, { normalizedExpectedText: '日' }]) {
        const actual = parseJsonSummary(summary([{ ...before, characterAccuracy: 1, ...replacement }]));
        assert.throws(() => compareSummaries(baseline, actual), /not comparable benchmark cases/);
    }
});

test('different captured pixels or input modes cannot be compared as model changes', () => {
    const before = { ...result('same-name', 0.8), input: { mode: 'fixture', sha256: 'same-image' } };
    const baseline = parseJsonSummary(summary([before]));
    for (const input of [{ mode: 'snip', sha256: 'same-image' }, { mode: 'fixture', sha256: 'different-image' }]) {
        const actual = parseJsonSummary(summary([{ ...before, input }]));
        assert.throws(() => compareSummaries(baseline, actual), /input mode changed|input image data changed/);
    }
});

test('JSON rejects invalid scores, names, booleans, duplicate cases, and dishonest aggregates', () => {
    for (const score of [NaN, Infinity, -0.1, 1.1, null, undefined, '0.5']) {
        assert.throws(() => parseJsonSummary(summary([result('invalid', score)])), /finite number/);
    }
    assert.throws(() => parseJsonSummary(summary([result('same', 0.5), result('same', 0.6)])), /duplicate case same/);
    assert.throws(() => parseJsonSummary(summary([result('', 0.5)])), /nonempty name/);
    assert.throws(() => parseJsonSummary(summary([{ name: 'missing-exact', characterAccuracy: 0.5 }])), /exactMatch must be a boolean/);
    assert.throws(() => parseJsonSummary({ cases: [] }), /nonempty array/);
    for (const field of ['totalCases', 'exactMatches', 'exactMatchRate', 'averageCharacterAccuracy']) {
        const invalid = summary([result('good', 1, true)]);
        invalid[field] = 0;
        assert.throws(() => parseJsonSummary(invalid), new RegExp(field));
    }
});

test('spacing loss fails even when every historical metric remains perfect', () => {
    const baseline = parseJsonSummary(strictSummary([scoredResult('general-005-colored-text', '青い数字 123')]));
    const actual = parseJsonSummary(strictSummary([scoredResult('general-005-colored-text', '青い数字 123', '青い数字123')]));
    assert.equal(actual.averageCharacterAccuracy, baseline.averageCharacterAccuracy);
    assert.equal(actual.exactMatches, baseline.exactMatches);
    const comparison = compareSummaries(baseline, actual);
    assert.ok(comparison.regressions.some((entry) => entry.startsWith('general-005-colored-text spacing-sensitive:')));
    assert.ok(comparison.regressions.some((entry) => entry.startsWith('Spacing-sensitive average character accuracy:')));
    assert.ok(comparison.regressions.some((entry) => entry.startsWith('general cohort: Spacing-sensitive exact matches:')));
});

test('legacy raw JSON gains verified spacing metrics without rewriting recorded results', () => {
    const legacy = scoredResult('old', '日本語 OCR');
    for (const field of Object.keys(legacy).filter((key) => key.startsWith('spacingSensitive') || key === 'rawExactMatch')) delete legacy[field];
    const baseline = parseJsonSummary(summary([legacy]));
    assert.equal(baseline.cases[0].spacingSensitiveExactMatch, true);
    const actual = parseJsonSummary(strictSummary([scoredResult('old', '日本語 OCR', '日本語OCR')]));
    assert.ok(compareSummaries(baseline, actual).regressions.some((entry) => entry.startsWith('old spacing-sensitive:')));
    assert.equal(legacy.spacingSensitiveExactMatch, undefined);
});

test('raw labels cannot change their whitespace while normalized expected text stays equal', () => {
    const baseline = parseJsonSummary(strictSummary([scoredResult('same', 'Hello world')]));
    const actual = parseJsonSummary(strictSummary([scoredResult('same', 'Helloworld')]));
    assert.throws(() => compareSummaries(baseline, actual), /expectedText changed/);
});

test('raw text validates stored per-case historical and spacing scores', () => {
    for (const [field, replacement] of [
        ['characterAccuracy', 0.5], ['exactMatch', false], ['editDistance', 1], ['editDistance', 1e-10],
        ['normalizedActualText', 'wrong'], ['spacingSensitiveCharacterAccuracy', 0.5],
        ['spacingSensitiveExactMatch', false], ['spacingSensitiveEditDistance', 1],
        ['spacingSensitiveExpectedText', 'wrong'], ['rawExactMatch', false],
    ]) {
        const entry = { ...scoredResult('honest', 'text'), [field]: replacement };
        assert.throws(() => parseJsonSummary(strictSummary([entry])), new RegExp(`${field} disagrees with raw text`));
    }
    const invalidScore = { ...scoredResult('empty', 'text', ''), spacingSensitiveCharacterAccuracy: -1e-10 };
    assert.throws(() => parseJsonSummary(strictSummary([invalidScore])), /finite number between 0 and 1/);
});

test('versioned summaries require all metrics and independently validate cohort totals', () => {
    for (const field of ['normalizedActualText', 'editDistance', 'spacingSensitiveActualText', 'spacingSensitiveExactMatch', 'rawExactMatch']) {
        const entry = scoredResult('general-001-horizontal-japanese', '日本');
        delete entry[field];
        assert.throws(() => parseJsonSummary(strictSummary([entry])), new RegExp(field));
    }
    for (const field of ['spacingSensitiveExactMatches', 'spacingSensitiveExactMatchRate', 'averageSpacingSensitiveCharacterAccuracy', 'cohorts']) {
        const value = strictSummary([scoredResult('general-001-horizontal-japanese', '日本')]);
        delete value[field];
        assert.throws(() => parseJsonSummary(value), new RegExp(field));
    }
    const value = strictSummary([scoredResult('general-001-horizontal-japanese', '日本')]);
    value.cohorts.general.averageSpacingSensitiveCharacterAccuracy = 0;
    assert.throws(() => parseJsonSummary(value), /general cohort.*disagrees/);
    assert.throws(() => parseJsonSummary({ ...value, schemaVersion: 3 }), /unsupported schemaVersion/);
});

test('missing raw data or partially dropped spacing metrics cannot silently weaken the gate', () => {
    const entry = scoredResult('old', 'some words');
    delete entry.actualText;
    assert.throws(() => parseJsonSummary(summary([entry])), /requires raw expectedText and actualText/);
    assert.throws(() => parseJsonSummary(summary([scoredResult('has-raw', '日本'), result('no-raw', 1, true)])), /partial metrics cannot be dropped/);
    const baseline = parseJsonSummary(strictSummary([scoredResult('old', 'some words')]));
    const actual = parseJsonSummary(summary([result('old', 1, true)]));
    assert.throws(() => compareSummaries(baseline, actual), /not comparable benchmark cases|missing from the actual run/);
    const noRaw = summary([result('no-raw', 1, true)]);
    noRaw.averageSpacingSensitiveCharacterAccuracy = 1;
    assert.throws(() => parseJsonSummary(noRaw), /cannot be validated without raw case text/);
});

test('original and general cohort gates expose losses hidden by a stable combined average', () => {
    const baseline = parseJsonSummary(strictSummary([
        scoredResult('case-001-inuda-san', '犬田さん'),
        scoredResult('general-001-horizontal-japanese', '日本語', '日本'),
    ]));
    const actual = parseJsonSummary(strictSummary([
        scoredResult('case-001-inuda-san', '犬田さん', '犬田さ'),
        scoredResult('general-001-horizontal-japanese', '日本語'),
        scoredResult('general-011-new-case', 'easy'),
    ]));
    const comparison = compareSummaries(baseline, actual);
    assert.ok(actual.averageCharacterAccuracy > baseline.averageCharacterAccuracy);
    assert.ok(comparison.regressions.some((entry) => entry.startsWith('original cohort: Average character accuracy:')));
    assert.ok(comparison.regressions.some((entry) => entry.startsWith('original cohort: Exact matches:')));
    assert.equal(comparison.cohorts.general.totalCases, 1);
    assert.equal(comparison.addedCases.length, 1);
});

test('backend, model bundle, input mode and provider identities must survive a paired run', () => {
    const data = strictSummary([scoredResult('same', 'text')]);
    const baseline = parseJsonSummary({ ...data, backend: 'paddleonnx', model: 'jpn_vert', paddleOnnxModelVariant: 'server', run: { inputMode: 'fixture', provider: 'wasm' } });
    assert.deepEqual(compareSummaries(baseline, baseline).regressions, []);
    for (const field of ['backend', 'model', 'paddleOnnxModelVariant']) {
        for (const replacement of [undefined, 'changed']) {
            assert.throws(() => compareSummaries(baseline, { ...baseline, [field]: replacement }), new RegExp(`${field} changed or is missing`));
        }
    }
    for (const field of ['inputMode', 'provider']) {
        for (const replacement of [undefined, 'changed']) {
            assert.throws(() => compareSummaries(baseline, { ...baseline, run: { ...baseline.run, [field]: replacement } }), new RegExp(`run.${field} changed or is missing`));
        }
    }
});

test('complete case data cannot disguise a failed or incomplete browser run', () => {
    const data = strictSummary([scoredResult('same', 'text')]);
    const goodRun = { status: 'passed', exitCode: 0, buildExitCode: 0, testExitCode: 0, summaryExitCode: 0 };
    assert.equal(parseJsonSummary({ ...data, run: goodRun }).exactMatches, 1);
    assert.equal(parseJsonSummary(data).exactMatches, 1); // Legacy summaries have no run metadata.
    for (const status of ['failed', 'build_failed', 'running', '', null, true]) {
        assert.throws(() => parseJsonSummary({ ...data, run: { ...goodRun, status } }), /run.status must be passed/);
    }
    for (const field of ['exitCode', 'buildExitCode', 'testExitCode', 'summaryExitCode']) {
        for (const code of [1, -1, null, '0']) {
            assert.throws(() => parseJsonSummary({ ...data, run: { ...goodRun, [field]: code } }), new RegExp(`run.${field} must be 0`));
        }
    }
    for (const run of [null, [], 'passed']) {
        assert.throws(() => parseJsonSummary({ ...data, run }), /run metadata must be an object/);
    }
});

test('Markdown rejects missing columns, duplicate cases, and inconsistent totals', () => {
    assert.throws(() => parseMarkdownBaseline(markdown.replace('| partial |', '| exact |')), /duplicate case exact/);
    assert.throws(() => parseMarkdownBaseline(markdown.replace('66.7%', 'n/a')), /must be a percentage/);
    assert.throws(() => parseMarkdownBaseline(markdown.replace('1/2', '1/3')), /counts disagree/);
    assert.throws(() => parseMarkdownBaseline(markdown.replace('50.0%', '40.0%')), /Exact Match Rate disagrees/);
    assert.throws(() => parseMarkdownBaseline(markdown.replace('83.3%', '20.0%')), /average accuracy disagrees/);
    assert.throws(() => parseMarkdownBaseline(markdown.replaceAll('PaddleOCR ONNX', 'Other')), /exactly one PaddleOCR ONNX/);
});

test('CLI defaults to the Markdown report and returns distinct pass, regression, and input-error exits', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'namida-ocr-regression-'));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.mkdir(path.join(directory, 'reports'));
    await fs.mkdir(path.join(directory, 'test-results'));
    const actualPath = path.join(directory, 'test-results', 'ocr-accuracy-summary.json');
    const baselinePath = path.join(directory, 'before.json');
    const before = summary([result('exact', 1, true), result('partial', 2 / 3)]);
    await fs.writeFile(path.join(directory, 'reports', 'ocr-performance.md'), markdown);
    await fs.writeFile(actualPath, JSON.stringify(before));
    await fs.writeFile(baselinePath, JSON.stringify(before));
    const script = fileURLToPath(new URL('../scripts/check-ocr-regression.mjs', import.meta.url));
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8' });
    const passed = run();
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /PASS: no OCR accuracy regressions/);
    assert.equal(run('--baseline', baselinePath, '--actual', actualPath).status, 0);
    await fs.writeFile(actualPath, JSON.stringify(summary([result('exact', 1, true), result('partial', 0.5)])));
    const failed = run();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /REGRESSION: partial:/);
    await fs.writeFile(actualPath, JSON.stringify({ ...before, run: { status: 'passed', testExitCode: 1 } }));
    const failedRun = run();
    assert.equal(failedRun.status, 2);
    assert.match(failedRun.stderr, /run.testExitCode must be 0/);
    assert.doesNotMatch(failedRun.stdout, /PASS:/);
    await fs.writeFile(actualPath, '{broken json');
    assert.equal(run().status, 2);
    assert.equal(run('--actual').status, 2);
    assert.equal(run('--unknown').status, 2);
    const help = run('--help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Exit codes:/);
});

test('summary writer upgrades raw legacy cases and refuses falsified scores before writing', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'namida-ocr-summary-'));
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const caseDirectory = path.join(directory, 'test-results', 'ocr-case-results');
    await fs.mkdir(caseDirectory, { recursive: true });
    const entry = scoredResult('general-005-colored-text', '数字 123', '数字123');
    for (const field of Object.keys(entry).filter((key) => key.startsWith('spacingSensitive') || key === 'rawExactMatch')) delete entry[field];
    const casePath = path.join(caseDirectory, 'case.json');
    const summaryPath = path.join(directory, 'test-results', 'ocr-accuracy-summary.json');
    await fs.writeFile(casePath, JSON.stringify(entry));
    const script = fileURLToPath(new URL('./write-ocr-summary.mjs', import.meta.url));
    const run = () => spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8' });
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    const generated = parseJsonSummary(JSON.parse(await fs.readFile(summaryPath, 'utf8')));
    assert.equal(generated.schemaVersion, 2);
    assert.equal(generated.exactMatches, 1);
    assert.equal(generated.spacingSensitiveExactMatches, 0);
    assert.equal(generated.cohorts.general.totalCases, 1);
    await fs.rm(summaryPath);
    await fs.writeFile(casePath, JSON.stringify({ ...entry, characterAccuracy: 0.5 }));
    const invalid = run();
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /characterAccuracy disagrees with raw text/);
    await assert.rejects(fs.access(summaryPath));
});
