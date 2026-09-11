type TensorData = { type: string; dims: readonly number[]; readonly data: unknown };
type Float32TensorData = TensorData & { type: 'float32'; readonly data: Float32Array };

/** The bundled DB detector emits one float32 probability map per image. */
export function assertDetectionTensor(tensor: TensorData | undefined): asserts tensor is Float32TensorData {
    assertFloat32Tensor(tensor, 'detector', 4);
    if (tensor.dims[0] !== 1 || tensor.dims[1] !== 1) {
        throw contractError('detector', `expected shape [1, 1, H, W], received [${tensor.dims.join(', ')}]`);
    }
}

/** CTC class zero is blank; every other output class must have a dictionary entry. */
export function assertRecognitionTensor(
    tensor: TensorData | undefined,
    dictionary: readonly string[],
): asserts tensor is Float32TensorData {
    assertFloat32Tensor(tensor, 'recognizer', 3);
    const expectedClasses = dictionary.length + 1;
    if (tensor.dims[0] !== 1 || tensor.dims[2] !== expectedClasses) {
        throw contractError(
            'recognizer',
            `expected shape [1, T, ${expectedClasses}] (${dictionary.length} dictionary entries plus CTC blank), `
                + `received [${tensor.dims.join(', ')}]`,
        );
    }
}

function assertFloat32Tensor(
    tensor: TensorData | undefined,
    model: string,
    rank: number,
): asserts tensor is Float32TensorData {
    if (!tensor) {
        throw contractError(model, 'the model did not return its output tensor');
    }
    if (tensor.type !== 'float32') {
        throw contractError(model, `expected float32 output, received ${tensor.type}`);
    }
    if (tensor.dims.length !== rank || !tensor.dims.every((dimension) => Number.isSafeInteger(dimension) && dimension > 0)) {
        throw contractError(model, `expected ${rank} positive safe-integer dimensions, received [${tensor.dims.join(', ')}]`);
    }
    const expectedLength = tensor.dims.reduce((length, dimension) => length * dimension, 1);
    if (!Number.isSafeInteger(expectedLength)) {
        throw contractError(model, `output dimensions exceed the safe element-count range: [${tensor.dims.join(', ')}]`);
    }
    let data: unknown;
    try {
        data = tensor.data;
    } catch {
        throw contractError(model, 'output data is not accessible on the CPU');
    }
    if (!(data instanceof Float32Array)) {
        throw contractError(model, 'expected output data backed by Float32Array');
    }
    if (data.length !== expectedLength) {
        throw contractError(model, `shape requires ${expectedLength} values, received ${data.length}`);
    }
}

function contractError(model: string, detail: string): Error {
    return new Error(`PaddleOCR ${model} model contract mismatch: ${detail}. Check the bundled model and dictionary integration.`);
}
