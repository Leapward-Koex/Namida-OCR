// SPDX-License-Identifier: BSD-3-Clause
// Cubic interpolation follows OpenCV (Copyright Intel Corporation, Willow Garage,
// OpenCV Foundation and contributors). See third-party/PaddleGeometry-NOTICE.txt.
import type { DbQuad } from './PaddleDbPostProcess';
import { minimumAreaRectangle } from './PaddleDbPostProcess';

export type RgbaImage = { data: Uint8Array | Uint8ClampedArray; width: number; height: number };
export type RectifiedTextLine = { data: Uint8ClampedArray; width: number; height: number; rotated: boolean };

/**
 * PaddleX CropByPolys quad path: refit the rounded detection to its minimum-area
 * rectangle, perspective warp with INTER_CUBIC/BORDER_REPLICATE, and rotate tall
 * crops 90 degrees counterclockwise. No axis-aligned padding or text heuristics.
 */
export function rectifyTextLine(image: RgbaImage, quad: DbQuad): RectifiedTextLine {
    validateQuad(quad);
    const rectangle = minimumAreaRectangle(quad.map(({ x, y }) => ({ x: Math.trunc(x), y: Math.trunc(y) })));
    if (!rectangle) throw new Error('Cannot rectify a degenerate PaddleOCR text region.');
    return warpTextQuad(image, rectangle.points);
}

/** Direct quadrilateral warp, also exported for reference tests and geometry use. */
export function warpTextQuad(image: RgbaImage, quad: DbQuad): RectifiedTextLine {
    validateQuad(quad);
    if (!Number.isSafeInteger(image.width) || image.width <= 0 || !Number.isSafeInteger(image.height) || image.height <= 0
        || image.data.length !== image.width * image.height * 4) throw new Error('Invalid RGBA source image for PaddleOCR crop.');
    const points = quad.map(({ x, y }) => ({ x: Math.fround(x), y: Math.fround(y) })) as DbQuad;
    const width = Math.trunc(Math.max(edgeLength(points[0], points[1]), edgeLength(points[2], points[3])));
    const height = Math.trunc(Math.max(edgeLength(points[0], points[3]), edgeLength(points[1], points[2])));
    if (!width || !height || !Number.isSafeInteger(width * height * 4)) throw new Error('Cannot rectify a degenerate PaddleOCR text region.');
    const transform = inversePerspective(points, width, height);
    const rotated = height / width >= 1.5;
    const outputWidth = rotated ? height : width, outputHeight = rotated ? width : height;
    const data = new Uint8ClampedArray(width * height * 4);
    const weights = cubicTable();
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const denominator = transform[6] * x + transform[7] * y + transform[8];
            const inverse = denominator ? 32 / denominator : 0;
            const sx32 = roundToEven((transform[0] * x + transform[1] * y + transform[2]) * inverse);
            const sy32 = roundToEven((transform[3] * x + transform[4] * y + transform[5]) * inverse);
            const sx = Math.floor(sx32 / 32), sy = Math.floor(sy32 / 32);
            const tableStart = ((sy32 & 31) * 32 + (sx32 & 31)) * 16;
            const destination = rotated ? ((width - 1 - x) * height + y) * 4 : (y * width + x) * 4;
            let red = 0, green = 0, blue = 0, alpha = 0;
            for (let ky = 0; ky < 4; ky += 1) {
                const sourceY = Math.max(0, Math.min(image.height - 1, sy + ky - 1));
                for (let kx = 0; kx < 4; kx += 1) {
                    const sourceX = Math.max(0, Math.min(image.width - 1, sx + kx - 1));
                    const source = (sourceY * image.width + sourceX) * 4;
                    const weight = weights[tableStart + ky * 4 + kx];
                    red += image.data[source] * weight;
                    green += image.data[source + 1] * weight;
                    blue += image.data[source + 2] * weight;
                    alpha += image.data[source + 3] * weight;
                }
            }
            data[destination] = Math.floor((red + 16384) / 32768);
            data[destination + 1] = Math.floor((green + 16384) / 32768);
            data[destination + 2] = Math.floor((blue + 16384) / 32768);
            data[destination + 3] = Math.floor((alpha + 16384) / 32768);
        }
    }
    return { data, width: outputWidth, height: outputHeight, rotated };
}

function validateQuad(quad: DbQuad): void {
    if (quad.length !== 4 || quad.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) {
        throw new Error('PaddleOCR crop requires four finite points.');
    }
}

function edgeLength(a: { x: number; y: number }, b: { x: number; y: number }): number {
    // numpy.linalg.norm on float32 point differences, used by PaddleX.
    const f = Math.fround, dx = f(a.x - b.x), dy = f(a.y - b.y);
    return f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
}

function inversePerspective(quad: DbQuad, width: number, height: number): number[] {
    const destination = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }];
    const matrix: number[][] = Array.from({ length: 8 }, () => []);
    for (let i = 0; i < 4; i += 1) {
        const { x, y } = quad[i], { x: u, y: v } = destination[i];
        matrix[i] = [x, y, 1, 0, 0, 0, -Math.fround(x * u), -Math.fround(y * u), u];
        matrix[i + 4] = [0, 0, 0, x, y, 1, -Math.fround(x * v), -Math.fround(y * v), v];
    }
    // Pivoted elimination computes the source-to-destination homography. Invert
    // afterwards, matching cv2.getPerspectiveTransform -> warpPerspective.
    for (let column = 0; column < 8; column += 1) {
        let pivot = column;
        for (let row = column + 1; row < 8; row += 1) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
        if (Math.abs(matrix[pivot][column]) < 1e-12) throw new Error('Cannot rectify a degenerate PaddleOCR text region.');
        [matrix[pivot], matrix[column]] = [matrix[column], matrix[pivot]];
        const divisor = matrix[column][column];
        for (let i = column; i <= 8; i += 1) matrix[column][i] /= divisor;
        for (let row = 0; row < 8; row += 1) {
            if (row === column) continue;
            const factor = matrix[row][column];
            for (let i = column; i <= 8; i += 1) matrix[row][i] -= factor * matrix[column][i];
        }
    }
    const [a, b, c, d, e, f, g, h] = matrix.map((row) => row[8]);
    const determinant = a * (e - f * h) - b * (d - f * g) + c * (d * h - e * g);
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-15) throw new Error('Cannot rectify a degenerate PaddleOCR text region.');
    return [e - f * h, c * h - b, b * f - c * e, f * g - d, a - c * g, c * d - a * f,
        d * h - e * g, b * g - a * h, a * e - b * d].map((cofactor) => cofactor / determinant);
}

let cachedCubicTable: Int16Array | undefined;
function cubicTable(): Int16Array {
    if (cachedCubicTable) return cachedCubicTable;
    const f = Math.fround;
    const oneDimensional = Array.from({ length: 32 }, (_, index) => {
        const x = index / 32, z = 1 - x, a = -0.75;
        const c0 = f(f(f(f(f(a * (x + 1)) - 5 * a) * (x + 1)) + 8 * a) * (x + 1) - 4 * a);
        const c1 = f(f(f(f((a + 2) * x - (a + 3)) * x) * x) + 1);
        const c2 = f(f(f(f((a + 2) * z - (a + 3)) * z) * z) + 1);
        return [c0, c1, c2, f(f(f(1 - c0) - c1) - c2)];
    });
    const table = new Int16Array(32 * 32 * 16);
    for (let y = 0; y < 32; y += 1) {
        for (let x = 0; x < 32; x += 1) {
            const base = (y * 32 + x) * 16;
            let sum = 0;
            for (let ky = 0; ky < 4; ky += 1) {
                for (let kx = 0; kx < 4; kx += 1) {
                    const value = Math.max(-32768, Math.min(32767, roundToEven(f(oneDimensional[y][ky] * oneDimensional[x][kx]) * 32768)));
                    table[base + ky * 4 + kx] = value;
                    sum += value;
                }
            }
            if (sum !== 32768) {
                let minimum = 10, maximum = 10;
                for (const index of [10, 11, 14, 15]) {
                    if (table[base + index] < table[base + minimum]) minimum = index;
                    else if (table[base + index] > table[base + maximum]) maximum = index;
                }
                table[base + (sum < 32768 ? maximum : minimum)] -= sum - 32768;
            }
        }
    }
    cachedCubicTable = table;
    return table;
}

function roundToEven(value: number): number {
    const floor = Math.floor(value);
    return value - floor === 0.5 ? floor + (Math.abs(floor) % 2) : Math.round(value);
}
