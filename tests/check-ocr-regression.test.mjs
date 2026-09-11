import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { compareSummaries, parseJsonSummary, parseMarkdownBaseline } from '../scripts/check-ocr-regression.mjs';

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
    await fs.writeFile(actualPath, '{broken json');
    assert.equal(run().status, 2);
    assert.equal(run('--actual').status, 2);
    assert.equal(run('--unknown').status, 2);
    const help = run('--help');
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Exit codes:/);
});
