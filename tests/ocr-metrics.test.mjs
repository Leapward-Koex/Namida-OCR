import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSpacingSensitiveOcrText, scoreOcrText } from '../scripts/ocr-scoring.mjs';

test('historical scores remain whitespace-insensitive while inline spaces have separate scores', () => {
    const score = scoreOcrText('青い文字と赤い数字 123', '青い文字と赤い数字123');
    assert.equal(score.exactMatch, true);
    assert.equal(score.characterAccuracy, 1);
    assert.equal(score.editDistance, 0);
    assert.equal(score.spacingSensitiveExactMatch, false);
    assert.equal(score.spacingSensitiveEditDistance, 1);
    assert.equal(score.spacingSensitiveCharacterAccuracy, 1 - 1 / '青い文字と赤い数字 123'.length);
    assert.equal(score.rawExactMatch, false);
});

test('every inline space, tab and full-width space remains significant without trimming', () => {
    for (const actual of ['HelloWorld', 'Hello  World', ' Hello World', 'Hello World ', 'Hello\tWorld', 'Hello　World']) {
        const score = scoreOcrText('Hello World', actual);
        assert.equal(score.exactMatch, true, actual);
        assert.equal(score.spacingSensitiveExactMatch, false, actual);
        assert.ok(score.spacingSensitiveCharacterAccuracy < 1, actual);
    }
});

test('Japanese layout lines tolerate LF, CRLF, CR and Unicode line separators', () => {
    for (const separator of ['\n', '\r\n', '\r', '\u2028', '\u2029', '\n\n']) {
        const score = scoreOcrText('明日の予定\n図書館へ行く', `明日の${separator}予定図書館へ行く${separator}`);
        assert.equal(score.spacingSensitiveExactMatch, true, JSON.stringify(separator));
        assert.equal(score.rawExactMatch, false);
    }
});

test('line breaks between Unicode Latin words or numbers preserve their separator', () => {
    for (const text of ['Hello\nworld', 'Hello\r\nworld', 'café\nété', 'Test\n2026', '2026\nTest']) {
        assert.equal(normalizeSpacingSensitiveOcrText(text), text.replace(/\r?\n/g, ' '));
    }
    assert.equal(normalizeSpacingSensitiveOcrText('Hello \nworld'), 'Hello world');
    assert.equal(normalizeSpacingSensitiveOcrText('Hello\n world'), 'Hello world');
    assert.equal(normalizeSpacingSensitiveOcrText('Hello \n world'), 'Hello  world');
    assert.equal(normalizeSpacingSensitiveOcrText(' \n日本語\n '), ' 日本語 ');
});

test('punctuation, character substitutions and empty OCR remain measurable', () => {
    assert.equal(scoreOcrText("It's 2026", 'Its 2026').spacingSensitiveEditDistance, 1);
    assert.equal(scoreOcrText('日本語', '').spacingSensitiveCharacterAccuracy, 0);
    assert.equal(scoreOcrText('', '').spacingSensitiveCharacterAccuracy, 1);
    assert.equal(scoreOcrText('日本語', '日本語').rawExactMatch, true);
});
