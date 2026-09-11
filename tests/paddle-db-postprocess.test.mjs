import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const nodeRequire = createRequire(import.meta.url);
function loadModule(name) {
    const source = readFileSync(new URL(`../src/background/ocr/${name}.ts`, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const context = vm.createContext({ exports: {}, Uint8Array, Uint8ClampedArray, Float32Array, Int8Array, console,
        require(name) { return name.startsWith('./') ? loadModule(name.slice(2)) : nodeRequire(name); } });
    vm.runInContext(compiled, context);
    return context.exports;
}
const geometry = loadModule('PaddleDbPostProcess');
const reference = JSON.parse(readFileSync(new URL('./fixtures/paddle-geometry-reference.json', import.meta.url), 'utf8'));
const pointObjects = (points) => points.map(([x, y]) => ({ x, y }));
const pointPairs = (points) => JSON.parse(JSON.stringify(points.map(({ x, y }) => [x, y])));

test('retrieves all external and hole contours in OpenCV RETR_LIST order on 50 seeded maps', () => {
    for (const fixture of reference.contours) {
        const actual = geometry.findDbContours(fixture.bitmap, fixture.width, fixture.height).map(pointPairs);
        assert.deepEqual(JSON.parse(JSON.stringify(actual)), fixture.contours, fixture.name);
    }
});

test('polygon scores use OpenCV LINE_8 edge filling including half-slope pixels', () => {
    for (const [index, fixture] of reference.polygons.entries()) {
        const actual = geometry.fillIntegerPolygon(pointObjects(fixture.points), fixture.width, fixture.height);
        assert.deepEqual([...actual], fixture.mask, `polygon ${index}`);
    }
});

test('round expansion uses the same quantized offset polygons as Pyclipper', () => {
    for (const fixture of reference.offsets) {
        const actual = geometry.unclipDbQuad(pointObjects(fixture.points), fixture.ratio);
        assert.deepEqual(pointPairs(actual), fixture.expanded);
    }
});

test('DB detections match OpenCV/Pyclipper geometry and polygon scores', () => {
    for (const fixture of reference.db) {
        const actual = geometry.postProcessDb(fixture.probabilities, fixture.width, fixture.height, fixture.imageWidth, fixture.imageHeight, fixture.options);
        assert.equal(actual.length, fixture.detections.length, `${fixture.name}: count`);
        for (const [index, detection] of actual.entries()) {
            const expected = fixture.detections[index];
            assert.deepEqual(pointPairs(detection.points), expected.points, `${fixture.name} box ${index}`);
            assert.ok(Math.abs(detection.score - expected.score) < 1e-7, `${fixture.name} score ${detection.score} vs ${expected.score}`);
        }
    }
});

test('source-coordinate rounding drops collapsed crops without filtering usable small text', () => {
    const width = 32, height = 64;
    const probabilities = new Float32Array(width * height);
    for (let y = 8; y <= 20; y += 1) {
        for (let x = 2; x <= 8; x += 1) probabilities[y * width + x] = .99;
    }
    // The region easily passes DB's minimum-size checks in the probability map.
    assert.equal(geometry.postProcessDb(probabilities, width, height, width, height).length, 1);
    // Both x coordinates round to zero on this source, so no line can be warped.
    assert.equal(geometry.postProcessDb(probabilities, width, height, 1, 50).length, 0);
    // A genuine one-pixel-wide source crop remains usable. This is deliberately
    // not the classic PaddleOCR wrapper's additional <=3-pixel filtering rule.
    const narrow = geometry.postProcessDb(probabilities, width, height, 2, 50);
    assert.equal(narrow.length, 1);
    const image = { width: 2, height: 50, data: new Uint8ClampedArray(2 * 50 * 4) };
    const crop = crops.rectifyTextLine(image, narrow[0].points);
    assert.ok(crop.width >= 1 && crop.height >= 1);
});

test('invalid maps/configuration fail before contour processing', () => {
    const run = (data, width = 2, height = 2, options = {}) => geometry.postProcessDb(data, width, height, width, height, options);
    assert.throws(() => run([.5]), /size does not match/);
    assert.throws(() => run([], 0), /positive integer/);
    assert.throws(() => run([0, NaN, 0, 0]), /Invalid probability/);
    assert.throws(() => run([0, 0, 0, 0], 2, 2, { threshold: -1 }), /between 0 and 1/);
    assert.throws(() => run([0, 0, 0, 0], 2, 2, { maxCandidates: 1.5 }), /nonnegative integer/);
    assert.throws(() => run([0, 0, 0, 0], 2, 2, { unclipRatio: Infinity }), /finite and nonnegative/);
    assert.equal(run([0, 0, 0, 0]).length, 0);
});

const crops = loadModule('PaddleCropGeometry');
const sourceImage = { ...reference.cropImage, data: new Uint8ClampedArray(reference.cropImage.data) };
test('cubic perspective crops match OpenCV BORDER_REPLICATE and CCW rotation', () => {
    for (const fixture of reference.crops) {
        const actual = crops.warpTextQuad(sourceImage, pointObjects(fixture.quad));
        const expected = fixture.direct;
        assert.equal(actual.width, expected.width, `${fixture.name}: width`);
        assert.equal(actual.height, expected.height, `${fixture.name}: height`);
        assert.equal(actual.rotated, expected.rotated, `${fixture.name}: rotation`);
        const errors = [...actual.data].map((value, i) => Math.abs(value - expected.data[i]));
        assert.ok(Math.max(...errors) <= 1, `${fixture.name}: max error ${Math.max(...errors)}`);
        assert.ok(errors.reduce((sum, value) => sum + value, 0) / errors.length < .02, `${fixture.name}: mean error`);
    }
});

test('rounded detector quadrilaterals are refitted before line rectification', () => {
    for (const fixture of reference.crops) {
        const actual = crops.rectifyTextLine(sourceImage, pointObjects(fixture.quad));
        const expected = fixture.refitted;
        assert.equal(actual.width, expected.width, `${fixture.name}: width`);
        assert.equal(actual.height, expected.height, `${fixture.name}: height`);
        assert.equal(actual.rotated, expected.rotated, `${fixture.name}: rotation`);
        const errors = [...actual.data].map((value, i) => Math.abs(value - expected.data[i]));
        assert.ok(Math.max(...errors) <= 1, `${fixture.name}: max error ${Math.max(...errors)}`);
        assert.ok(errors.reduce((sum, value) => sum + value, 0) / errors.length < .02, `${fixture.name}: mean error`);
    }
});

test('invalid and degenerate crops fail with a geometry error', () => {
    assert.throws(() => crops.rectifyTextLine(sourceImage, pointObjects([[1, 1], [2, 2], [3, 3], [4, 4]])), /degenerate/);
    assert.throws(() => crops.warpTextQuad(sourceImage, pointObjects([[NaN, 1], [2, 2], [3, 3], [4, 4]])), /four finite points/);
    assert.throws(() => crops.warpTextQuad({ ...sourceImage, data: [] }, pointObjects([[1, 1], [8, 1], [8, 8], [1, 8]])), /Invalid RGBA/);
});
