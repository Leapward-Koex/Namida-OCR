import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/background/ocr/PaddleModelPipeline.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = vm.createContext({ exports: {}, Float32Array, Uint8ClampedArray, Uint8Array });
vm.runInContext(compiled, context);
const { prepareDetectorInput, prepareRecognizerInput, decodeCtcProbabilities, resizeBilinearRgba } = context.exports;

function image(width, height, rgb = [255, 255, 255]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < data.length; offset += 4) data.set([...rgb, 255], offset);
    return { width, height, data };
}

function close(actual, expected, tolerance = 1e-6) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

const detectorOptions = { limit_side_len: 960, limit_type: 'max', max_side_len: 1536,
    mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] };

test('colored pixels become BGR NCHW with each plane normalized in configured order', () => {
    const rec = prepareRecognizerInput(image(48, 48, [255, 0, 64]));
    assert.equal(rec.width, 320);
    assert.equal(rec.contentWidth, 48);
    const plane = 320 * 48;
    close(rec.data[0], 64 / 127.5 - 1);
    assert.equal(rec.data[plane], -1);
    assert.equal(rec.data[plane * 2], 1);
    const det = prepareDetectorInput(image(32, 32, [255, 0, 64]), detectorOptions);
    close(det.data[0], (64 / 255 - 0.485) / 0.229);
    close(det.data[1024], (0 - 0.456) / 0.224);
    close(det.data[2048], (1 - 0.406) / 0.225);
});

test('recognition right padding is normalized zero, distinct from white content', () => {
    const input = prepareRecognizerInput(image(17, 48));
    for (let channel = 0; channel < 3; channel += 1) {
        for (let y = 0; y < 48; y += 1) {
            const offset = channel * 48 * 320 + y * 320;
            assert.equal(input.data[offset + 16], 1);
            assert.equal(input.data[offset + 17], 0);
            assert.equal(input.data[offset + 319], 0);
        }
    }
});

test('recognition uses dynamic floor width above 320 and preserves complete long lines', () => {
    const normal = prepareRecognizerInput(image(499, 47));
    assert.equal(normal.width, 509); // int(48 * 499 / 47), not a stride-rounded hard cap.
    assert.equal(normal.contentWidth, 509);
    assert.equal(normal.widthClamped, false);
    const long = image(4000, 48, [0, 0, 0]);
    for (let y = 0; y < 48; y += 1) long.data.set([255, 255, 255, 255], (y * 4000 + 3999) * 4);
    const capped = prepareRecognizerInput(long);
    assert.equal(capped.width, 3200);
    assert.equal(capped.widthClamped, true);
    assert.ok(capped.data[3199] > 0.5, 'the end of the source line is compressed into the tensor, not truncated');
});

test('detector resize follows min/max policies and Python ties-to-even stride rounding', () => {
    const lowTie = prepareDetectorInput(image(80, 64), detectorOptions);
    assert.equal(lowTie.width, 64);
    assert.equal(lowTie.height, 64);
    const highTie = prepareDetectorInput(image(112, 64), detectorOptions);
    assert.equal(highTie.width, 128);
    const capped = prepareDetectorInput(image(1000, 100), {
        ...detectorOptions, limit_side_len: 736, limit_type: 'min',
    });
    assert.equal(capped.width, 1536);
    assert.equal(capped.height, 160);
    assert.equal(capped.sourceWidth, 1000);
    close(capped.scaleX, 1.536);
    close(capped.scaleY, 1.6);
    const defaults = prepareDetectorInput(image(1000, 100));
    assert.equal(defaults.width, 960);
    assert.equal(defaults.height, 96);
    const small = prepareDetectorInput(image(64, 32));
    assert.equal(small.width, 64, 'standalone max policy does not upscale small images');
});

test('tiny detector images get reference black bottom/right padding', () => {
    const tiny = prepareDetectorInput(image(10, 10), detectorOptions);
    assert.equal(tiny.width, 32);
    assert.equal(tiny.height, 32);
    assert.equal(tiny.sourceWidth, 10);
    close(tiny.data[0], (1 - 0.485) / 0.229);
    close(tiny.data[31], -0.485 / 0.229);
});

test('linear resizing agrees with independent OpenCV reference pixels within uint8 rounding', () => {
    const reference = JSON.parse(readFileSync(new URL('./fixtures/paddle-linear-reference.json', import.meta.url)));
    for (const sample of reference.cases) {
        const resized = resizeBilinearRgba({ width: sample.width, height: sample.height, data: Uint8ClampedArray.from(sample.rgba) }, sample.targetWidth, sample.targetHeight);
        assert.equal(resized.data.length, sample.expectedRgba.length);
        let differenceCount = 0;
        for (let index = 0; index < resized.data.length; index += 1) {
            assert.ok(Math.abs(resized.data[index] - sample.expectedRgba[index]) <= 1, `OpenCV mismatch at ${sample.name}:${index}`);
            if (resized.data[index] !== sample.expectedRgba[index]) differenceCount += 1;
        }
        assert.ok(differenceCount / resized.data.length < 0.2, 'most pixel channels should agree exactly');
    }
});

test('transparent pixels composite onto white before interpolation', () => {
    const result = resizeBilinearRgba({ width: 1, height: 1, data: Uint8ClampedArray.from([0, 0, 0, 0]) }, 1, 1);
    assert.deepEqual(Array.from(result.data), [255, 255, 255, 255]);
});

test('CTC collapses adjacent repeats, resets at blank, and averages only emitted probabilities including space', () => {
    const dictionary = ['A', "'", ' '];
    const indices = [1, 1, 0, 1, 3, 3, 2];
    const confidences = [0.8, 0.99, 0.95, 0.9, 0.7, 0.99, 0.6];
    const probabilities = new Float32Array(indices.length * 4);
    indices.forEach((selected, timestep) => {
        for (let column = 0; column < 4; column += 1) probabilities[timestep * 4 + column] = column === selected ? confidences[timestep] : (1 - confidences[timestep]) / 3;
    });
    const decoded = decodeCtcProbabilities(probabilities, indices.length, dictionary);
    assert.equal(decoded.text, "AA '");
    close(decoded.confidence, (0.8 + 0.9 + 0.7 + 0.6) / 4);
    assert.deepEqual(Array.from(decoded.tokens, token => token.timestep), [0, 3, 4, 6]);
    assert.equal(decoded.tokens[2].text, ' ');
});

test('CTC preserves multilingual content and whitespace without Unicode or script rewrites', () => {
    const dictionary = ['臺', 'é', 'A', ' ', '１'];
    const probabilities = new Float32Array(5 * 6);
    for (let step = 0; step < 5; step += 1) probabilities[step * 6 + step + 1] = 1;
    const decoded = decodeCtcProbabilities(probabilities, 5, dictionary);
    assert.equal(decoded.text, '臺éA １');
    assert.equal(decoded.confidence, 1);
});

test('blank-only output is empty with zero confidence and ties choose first class like argmax', () => {
    const blank = decodeCtcProbabilities(Float32Array.from([0.9, 0.1, 0.8, 0.2]), 2, ['a']);
    assert.equal(blank.text, '');
    assert.equal(blank.confidence, 0);
    assert.equal(decodeCtcProbabilities(Float32Array.from([0.5, 0.5]), 1, ['a']).text, '');
});

test('invalid image dimensions, model geometry and non-probability output fail explicitly', () => {
    assert.throws(() => prepareRecognizerInput(image(0, 48)), /positive safe integer/);
    assert.throws(() => prepareRecognizerInput(image(10, 10), { image_height: 48, base_image_width: 320, max_image_width: 100 }), /base width/);
    assert.throws(() => decodeCtcProbabilities(Float32Array.from([1, 2]), 1, ['a']), /probabilities/);
    assert.throws(() => decodeCtcProbabilities(Float32Array.from([0.3, NaN]), 1, ['a']), /probabilities/);
    assert.throws(() => decodeCtcProbabilities(Float32Array.from([0.3]), 1, ['a']), /dimensions/);
});
