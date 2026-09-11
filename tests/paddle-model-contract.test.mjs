import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/background/ocr/PaddleOnnxModelContract.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const context = vm.createContext({
    exports: {},
    Float32Array,
    require(name) { throw new Error(`Model contracts must not import a runtime dependency: ${name}`); },
});
vm.runInContext(compiled, context);
const { assertDetectionTensor, assertRecognitionTensor } = context.exports;

function tensor(dims, data = new Float32Array(dims.reduce((count, dimension) => count * dimension, 1)), type = 'float32') {
    return { dims, data, type };
}

test('accepts dynamic detector maps and recognition sequences without changing their data', () => {
    const detector = tensor(Object.freeze([1, 1, 8, 16]));
    const recognition = tensor(Object.freeze([1, 13, 4]));
    detector.data[0] = 0.75;
    recognition.data[0] = 0.9;
    const detectorData = detector.data;
    const recognitionData = recognition.data;
    assertDetectionTensor(detector);
    assertRecognitionTensor(recognition, Object.freeze(['日', '本', ' ']));
    assert.equal(detector.data, detectorData);
    assert.equal(recognition.data, recognitionData);
    assert.equal(detector.data[0], 0.75);
    assert.equal(recognition.data[0], Math.fround(0.9));
});

test('missing outputs and non-float32 output types raise explanatory integration errors', () => {
    for (const validate of [assertDetectionTensor, (output) => assertRecognitionTensor(output, ['日'])]) {
        assert.throws(() => validate(undefined), /PaddleOCR .* model contract mismatch: the model did not return/);
        assert.throws(() => validate(tensor([1, 1, 1, 1], new Uint16Array(1), 'float16')), /expected float32 output, received float16/);
    }
});

test('rejects incorrect rank, batch size, and detector channel count', () => {
    assert.throws(() => assertDetectionTensor(tensor([1, 8, 8])), /expected 4 positive safe-integer dimensions/);
    assert.throws(() => assertDetectionTensor(tensor([2, 1, 8, 8])), /expected shape \[1, 1, H, W\]/);
    assert.throws(() => assertDetectionTensor(tensor([1, 2, 8, 8])), /expected shape \[1, 1, H, W\]/);
    assert.throws(() => assertRecognitionTensor(tensor([1, 2, 2, 1]), ['日']), /expected 3 positive safe-integer dimensions/);
    assert.throws(() => assertRecognitionTensor(tensor([2, 3, 2]), ['日']), /expected shape \[1, T, 2\]/);
});

test('catches the original missing-space dictionary mismatch instead of dropping its class', () => {
    const recognition = tensor([1, 1, 18710]);
    const dictionaryWithoutSpace = Array(18708).fill('字');
    assert.throws(
        () => assertRecognitionTensor(recognition, dictionaryWithoutSpace),
        /18708 dictionary entries plus CTC blank.*received \[1, 1, 18710\]/,
    );
    assertRecognitionTensor(recognition, [...dictionaryWithoutSpace, ' ']);
});

test('rejects invalid dimensions and an unsafe element-count product before reading data', () => {
    for (const dimension of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(
            () => assertDetectionTensor(tensor([1, 1, dimension, 1], new Float32Array(0))),
            /positive safe-integer dimensions/,
        );
        assert.throws(
            () => assertRecognitionTensor(tensor([1, dimension, 2], new Float32Array(0)), ['日']),
            /positive safe-integer dimensions/,
        );
    }
    assert.throws(
        () => assertDetectionTensor(tensor([1, 1, Number.MAX_SAFE_INTEGER, 2], new Float32Array(0))),
        /safe element-count range/,
    );
});

test('rejects truncated, oversized, incorrectly backed, and inaccessible tensor data', () => {
    for (const data of [new Float32Array(3), new Float32Array(5)]) {
        assert.throws(() => assertDetectionTensor(tensor([1, 1, 2, 2], data)), /shape requires 4 values/);
        assert.throws(() => assertRecognitionTensor(tensor([1, 2, 2], data), ['日']), /shape requires 4 values/);
    }
    assert.throws(() => assertDetectionTensor(tensor([1, 1, 1, 1], [1])), /backed by Float32Array/);
    assert.throws(() => assertRecognitionTensor(tensor([1, 1, 2], new Float64Array(2)), ['日']), /backed by Float32Array/);
    const inaccessible = { type: 'float32', dims: [1, 1, 1, 1], get data() { throw new Error('GPU buffer'); } };
    assert.throws(() => assertDetectionTensor(inaccessible), /output data is not accessible on the CPU/);
});
