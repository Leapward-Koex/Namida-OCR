import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const context = vm.createContext({ exports: {} });
vm.runInContext(ts.transpileModule(readFileSync(new URL('../src/background/ocr/PaddleReadingOrder.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, context);
const { orderTextRegions } = context.exports;
const box = (id, x, y, w, h) => ({ id, points: [{ x, y }, { x: x+w, y }, { x: x+w, y: y+h }, { x, y: y+h }] });
const ids = result => Array.from(result.regions, item => item.id);

test('orders horizontal fragments by row then left to right despite small baseline offsets', () => {
    const result = orderTextRegions([box('bottom', 0, 90, 150, 20), box('right', 150, 13, 120, 20), box('left', 0, 10, 100, 20)]);
    assert.equal(result.direction, 'horizontal');
    assert.deepEqual(ids(result), ['left', 'right', 'bottom']);
});

test('orders Japanese vertical columns right to left and fragments top to bottom using geometry only', () => {
    const result = orderTextRegions([box('left', 0, 0, 20, 250), box('lower', 100, 110, 20, 100), box('upper', 103, 0, 20, 100)]);
    assert.equal(result.direction, 'vertical');
    assert.deepEqual(ids(result), ['upper', 'lower', 'left']);
});

test('explicit direction resolves square glyphs without inspecting recognized text', () => {
    const regions = [box('left', 0, 0, 20, 20), box('right', 50, 0, 20, 20)];
    assert.deepEqual(ids(orderTextRegions(regions, 'vertical')), ['right', 'left']);
    assert.deepEqual(ids(orderTextRegions(regions, 'horizontal')), ['left', 'right']);
});

test('empty results and repeated calls are stable and never mutate detections', () => {
    assert.deepEqual(ids(orderTextRegions([])), []);
    const regions = [box('b', 50, 0, 30, 20), box('a', 0, 0, 30, 20)];
    assert.deepEqual(ids(orderTextRegions(regions)), ['a', 'b']);
    assert.deepEqual(regions.map(item => item.id), ['b', 'a']);
});
