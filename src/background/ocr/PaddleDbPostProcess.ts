// SPDX-License-Identifier: Apache-2.0 AND BSD-3-Clause
// Contour tracing and integer polygon rasterization follow OpenCV's algorithms.
// Copyright (C) 2000 Intel Corporation; Copyright (C) 2009 Willow Garage Inc.;
// Copyright (C) 2013 OpenCV Foundation; Copyright (C) 2015 Itseez Inc.
// See third-party/PaddleGeometry-NOTICE.txt for sources and license information.
import ClipperLib from 'clipper-lib';

export type DbPoint = { x: number; y: number };
/** Clockwise image-coordinate order: top left, top right, bottom right, bottom left. */
export type DbQuad = [DbPoint, DbPoint, DbPoint, DbPoint];
export type DbDetection = { points: DbQuad; score: number };
export type DbBox = DbDetection;
export type DbPostProcessOptions = {
    threshold?: number;
    boxThreshold?: number;
    unclipRatio?: number;
    maxCandidates?: number;
};
export type DbOptions = DbPostProcessOptions;
export type DbRectangle = { points: DbQuad; shortSide: number };

/**
 * PaddleX DBPostProcess's quad/fast path. There is no dilation or language/layout
 * heuristic here: RETR_LIST contours -> minimum rectangle -> polygon mean ->
 * Clipper round offset -> minimum rectangle -> source coordinates.
 *
 * Clipper uses the same integer coordinate convention as Pyclipper. Rectangle
 * calculations follow float32 rotating calipers. Platform floating-point and
 * equal-area hull ties can still change a boundary pixel; reference fixtures
 * measure that limitation rather than treating an axis-aligned box as parity.
 */
export function postProcessDb(
    probabilities: ArrayLike<number>, mapWidth: number, mapHeight: number,
    imageWidth: number, imageHeight: number, options: DbPostProcessOptions = {},
): DbDetection[] {
    for (const [name, value] of Object.entries({ mapWidth, mapHeight, imageWidth, imageHeight })) {
        if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
    }
    if (probabilities.length !== mapWidth * mapHeight) throw new Error('Probability map size does not match its dimensions.');
    const { threshold = 0.3, boxThreshold = 0.6, unclipRatio = 1.4, maxCandidates = 1000 } = options;
    for (const [name, value] of Object.entries({ threshold, boxThreshold })) {
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be between 0 and 1.`);
    }
    if (!Number.isFinite(unclipRatio) || unclipRatio < 0) throw new Error('unclipRatio must be finite and nonnegative.');
    if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 0) throw new Error('maxCandidates must be a nonnegative integer.');
    const bitmap = new Uint8Array(probabilities.length);
    for (let index = 0; index < probabilities.length; index += 1) {
        const value = probabilities[index];
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid probability at index ${index}.`);
        bitmap[index] = value > threshold ? 1 : 0;
    }
    if (!maxCandidates) return [];
    const contours = findDbContours(bitmap, mapWidth, mapHeight);
    const detections: DbDetection[] = [];
    for (const contour of contours.slice(0, maxCandidates)) {
        const rectangle = minimumAreaRectangle(contour);
        if (!rectangle || rectangle.shortSide < 3) continue;
        const score = scoreDbQuad(probabilities, mapWidth, mapHeight, rectangle.points);
        if (score < boxThreshold) continue;
        const expanded = unclipDbQuad(rectangle.points, unclipRatio);
        const box = minimumAreaRectangle(expanded);
        if (!box || box.shortSide < 5) continue;
        const points = box.points.map(({ x, y }) => ({
            x: Math.max(0, Math.min(imageWidth, roundToEven(x * imageWidth / mapWidth))),
            y: Math.max(0, Math.min(imageHeight, roundToEven(y * imageHeight / mapHeight))),
        })) as DbQuad;
        // DB's size checks are in probability-map pixels. Scaling/rounding to
        // a tiny source can still collapse a valid box to a point or line.
        // Reject only an unusable source crop; do not add the classic PaddleOCR
        // wrapper's separate three-source-pixel threshold to this PaddleX path.
        if (!hasUsableSourceCrop(points)) continue;
        detections.push({ points, score });
    }
    return detections;
}

function hasUsableSourceCrop(points: DbQuad): boolean {
    const rectangle = minimumAreaRectangle(points);
    if (!rectangle) return false;
    const edgeLength = (a: DbPoint, b: DbPoint): number => {
        // Same float32 edge norm and integer crop dimensions as CropByPolys.
        const f = Math.fround, dx = f(a.x - b.x), dy = f(a.y - b.y);
        return f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
    };
    const [a, b, c, d] = rectangle.points;
    return Math.trunc(Math.max(edgeLength(a, b), edgeLength(c, d))) > 0
        && Math.trunc(Math.max(edgeLength(a, d), edgeLength(b, c))) > 0;
}

/** RETR_LIST / CHAIN_APPROX_SIMPLE border following, including hole contours. */
export function findDbContours(bitmap: ArrayLike<number>, width: number, height: number): DbPoint[][] {
    const stride = width + 2;
    const image = new Int8Array(stride * (height + 2));
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) image[(y + 1) * stride + x + 1] = bitmap[y * width + x] ? 1 : 0;
    }
    const directions = [1, 1 - stride, -stride, -1 - stride, -1, stride - 1, stride, stride + 1];
    const dx = [1, 1, 0, -1, -1, -1, 0, 1];
    const dy = [0, -1, -1, -1, 0, 1, 1, 1];
    const contours: DbPoint[][] = [];
    for (let y = 1; y <= height; y += 1) {
        let previous = 0;
        for (let x = 1; x <= width + 1; x += 1) {
            const index = y * stride + x;
            let pixel = image[index];
            if (pixel === previous) continue;
            const outer = previous === 0 && pixel === 1;
            const hole = pixel === 0 && previous >= 1;
            if (outer || hole) {
                const start = index - (hole ? 1 : 0);
                const endDirection = hole ? 0 : 4;
                let direction = endDirection;
                let first: number;
                do {
                    direction = (direction - 1) & 7;
                    first = start + directions[direction];
                } while (!image[first] && direction !== endDirection);
                const points: DbPoint[] = [];
                let px = x - (hole ? 1 : 0) - 1;
                let py = y - 1;
                if (direction === endDirection) {
                    image[start] = -126;
                    points.push({ x: px, y: py });
                } else {
                    let current = start;
                    let previousDirection = direction ^ 4;
                    do {
                        const searchStart = direction;
                        let next: number;
                        do {
                            direction = (direction + 1) & 7;
                            next = current + directions[direction];
                        } while (!image[next]);
                        // OpenCV marks pixels on the right boundary to avoid
                        // discovering the same border again during the row scan.
                        if (direction > 0 && direction - 1 < searchStart) image[current] = -126;
                        else if (image[current] === 1) image[current] = 2;
                        if (direction !== previousDirection) points.push({ x: px, y: py });
                        previousDirection = direction;
                        px += dx[direction];
                        py += dy[direction];
                        if (next === start && current === first) break;
                        current = next;
                        direction = (direction + 4) & 7;
                    } while (true);
                }
                contours.push(points);
                pixel = image[index];
            }
            previous = pixel;
        }
    }
    // RETR_LIST returns later-discovered contours first; the candidate cap must
    // be applied to this order rather than to raster-order connected components.
    return contours.reverse();
}

function cross(origin: DbPoint, a: DbPoint, b: DbPoint): number {
    return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

function convexHull(points: readonly DbPoint[]): DbPoint[] {
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
        .filter((point, index, entries) => !index || point.x !== entries[index - 1].x || point.y !== entries[index - 1].y);
    if (sorted.length < 3) return sorted;
    const lower: DbPoint[] = [], upper: DbPoint[] = [];
    for (const point of sorted) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
        lower.push(point);
    }
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
        const point = sorted[index];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
        upper.push(point);
    }
    return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Float32 rotating calipers, following OpenCV minAreaRect/boxPoints. */
export function minimumAreaRectangle(points: readonly DbPoint[]): DbRectangle | null {
    const hull = convexHull(points);
    if (hull.length < 3) return null;
    const f = Math.fround;
    const vectors: DbPoint[] = [];
    const inverseLengths: number[] = [];
    let left = 0, right = 0, top = 0, bottom = 0;
    for (let index = 0; index < hull.length; index += 1) {
        const a = hull[index], b = hull[(index + 1) % hull.length];
        if (a.x < hull[left].x) left = index;
        if (a.x > hull[right].x) right = index;
        if (a.y > hull[top].y) top = index;
        if (a.y < hull[bottom].y) bottom = index;
        const dx = f(b.x - a.x), dy = f(b.y - a.y);
        vectors.push({ x: dx, y: dy });
        inverseLengths.push(f(1 / Math.hypot(dx, dy)));
    }
    const sequence = [bottom, right, top, left];
    let bestArea = Infinity;
    let best = { a: 1, b: 0, width: 0, height: 0, left, bottom };
    for (let index = 0; index < hull.length; index += 1) {
        const v0 = vectors[sequence[0]], v1 = vectors[sequence[1]];
        const v2 = vectors[sequence[2]], v3 = vectors[sequence[3]];
        const rotated = [v0, { x: v1.y, y: -v1.x }, { x: -v2.x, y: -v2.y }, { x: -v3.y, y: v3.x }];
        let main = 0;
        for (let side = 1; side < 4; side += 1) {
            if (f(f(rotated[side].y * rotated[main].x) - f(rotated[side].x * rotated[main].y)) < 0) main = side;
        }
        const lead = vectors[sequence[main]], length = inverseLengths[sequence[main]];
        const leadX = f(lead.x * length), leadY = f(lead.y * length);
        const a = [leadX, leadY, -leadX, -leadY][main];
        const b = [leadY, -leadX, -leadY, leadX][main];
        sequence[main] = (sequence[main] + 1) % hull.length;
        const width = f(f(f(hull[sequence[1]].x - hull[sequence[3]].x) * a) + f(f(hull[sequence[1]].y - hull[sequence[3]].y) * b));
        const height = f(f(-f(hull[sequence[2]].x - hull[sequence[0]].x) * b) + f(f(hull[sequence[2]].y - hull[sequence[0]].y) * a));
        const area = f(width * height);
        if (area <= bestArea) { bestArea = area; best = { a, b, width, height, left: sequence[3], bottom: sequence[0] }; }
    }
    const { a, b } = best;
    const c1 = f(f(a * hull[best.left].x) + f(b * hull[best.left].y));
    const c2 = f(f(-b * hull[best.bottom].x) + f(a * hull[best.bottom].y));
    const inverse = f(1 / f(f(a * a) + f(b * b)));
    const originX = f(f(f(c1 * a) - f(c2 * b)) * inverse);
    const originY = f(f(f(a * c2) - f(-b * c1)) * inverse);
    const v1x = f(a * best.width), v1y = f(b * best.width);
    const v2x = f(-b * best.height), v2y = f(a * best.height);
    const centerX = f(originX + f(f(v1x + v2x) * 0.5));
    const centerY = f(originY + f(f(v1y + v2y) * 0.5));
    let width = f(Math.hypot(v2x, v2y)), height = f(Math.hypot(v1x, v1y));
    let angle = -90;
    if (v1x === 0 && v1y > 0) [width, height] = [height, width];
    else angle = f(-Math.atan2(v1x, v1y) * 180 / Math.PI);
    const sine = f(f(Math.sin(angle * Math.PI / 180)) * 0.5);
    const cosine = f(f(Math.cos(angle * Math.PI / 180)) * 0.5);
    const p0 = { x: f(f(centerX - f(sine * height)) - f(cosine * width)), y: f(f(centerY + f(cosine * height)) - f(sine * width)) };
    const p1 = { x: f(f(centerX + f(sine * height)) - f(cosine * width)), y: f(f(centerY - f(cosine * height)) - f(sine * width)) };
    return {
        points: orderDbQuad([p0, p1, { x: f(2 * centerX - p0.x), y: f(2 * centerY - p0.y) }, { x: f(2 * centerX - p1.x), y: f(2 * centerY - p1.y) }]),
        shortSide: Math.min(width, height),
    };
}

export function orderDbQuad(points: DbQuad): DbQuad {
    const sorted = [...points].sort((a, b) => a.x - b.x);
    const left = sorted.slice(0, 2).sort((a, b) => a.y - b.y);
    const right = sorted.slice(2).sort((a, b) => a.y - b.y);
    return [left[0], right[0], right[1], left[1]];
}

export function unclipDbQuad(quad: DbQuad, ratio: number): DbPoint[] {
    let twiceArea = 0, perimeter = 0;
    for (let i = 0; i < quad.length; i += 1) {
        const a = quad[i], b = quad[(i + 1) % quad.length];
        twiceArea += a.x * b.y - b.x * a.y;
        perimeter += Math.hypot(a.x - b.x, a.y - b.y);
    }
    if (!perimeter) return [];
    // Pyclipper truncates float coordinates when converting the path to IntPoint.
    const path = quad.map(({ x, y }) => ({ X: Math.trunc(x), Y: Math.trunc(y) }));
    const offset = new ClipperLib.ClipperOffset();
    offset.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const paths: ClipperLib.Paths = [];
    offset.Execute(paths, Math.abs(twiceArea) * 0.5 * ratio / perimeter);
    return paths.flat().map(({ X, Y }) => ({ x: X, y: Y }));
}

/** Mean over the integer-filled quadrilateral, including its background pixels. */
export function scoreDbQuad(probabilities: ArrayLike<number>, width: number, height: number, quad: DbQuad): number {
    const minX = Math.max(0, Math.min(width - 1, Math.floor(Math.min(...quad.map(({ x }) => x)))));
    const maxX = Math.max(0, Math.min(width - 1, Math.ceil(Math.max(...quad.map(({ x }) => x)))));
    const minY = Math.max(0, Math.min(height - 1, Math.floor(Math.min(...quad.map(({ y }) => y)))));
    const maxY = Math.max(0, Math.min(height - 1, Math.ceil(Math.max(...quad.map(({ y }) => y)))));
    const maskWidth = maxX - minX + 1, maskHeight = maxY - minY + 1;
    const polygon = quad.map(({ x, y }) => ({ x: Math.trunc(x - minX), y: Math.trunc(y - minY) }));
    const mask = fillIntegerPolygon(polygon, maskWidth, maskHeight);
    let total = 0, count = 0;
    for (let y = 0; y < maskHeight; y += 1) {
        for (let x = 0; x < maskWidth; x += 1) {
            if (!mask[y * maskWidth + x]) continue;
            total += probabilities[(y + minY) * width + x + minX];
            count += 1;
        }
    }
    return count ? total / count : 0;
}

/** OpenCV LINE_8 polygon filling: rasterized edges plus fixed-point scanlines. */
export function fillIntegerPolygon(points: readonly DbPoint[], width: number, height: number): Uint8Array {
    const mask = new Uint8Array(width * height);
    const fixedOne = 65536;
    const edges: { y0: number; y1: number; x: number; dx: number }[] = [];
    const put = (x: number, y: number) => { if (x >= 0 && x < width && y >= 0 && y < height) mask[y * width + x] = 1; };
    for (let i = 0; i < points.length; i += 1) {
        const originalA = points[i], originalB = points[(i + 1) % points.length];
        const clipped = clipIntegerLine(originalA, originalB, width, height);
        let a = clipped.a, b = clipped.b;
        // OpenCV LineIterator walks left-to-right, including half-slope ties.
        if (a.x > b.x) [a, b] = [b, a];
        const dx = b.x - a.x, dy = Math.abs(b.y - a.y), sy = b.y >= a.y ? 1 : -1;
        let x = a.x, y = a.y;
        if (clipped.visible && dx >= dy) {
            let error = dx - 2 * dy;
            for (let step = 0; step <= dx; step += 1) {
                put(x, y);
                if (error < 0) { y += sy; error += 2 * dx; }
                x += 1; error -= 2 * dy;
            }
        } else if (clipped.visible) {
            let error = dy - 2 * dx;
            for (let step = 0; step <= dy; step += 1) {
                put(x, y);
                if (error < 0) { x += 1; error += 2 * dy; }
                y += sy; error -= 2 * dx;
            }
        }
        if (originalA.y === originalB.y) continue;
        const clippedAy = clipped.a.y !== clipped.b.y ? clipped.a.y : originalA.y;
        const clippedBy = clipped.a.y !== clipped.b.y ? clipped.b.y : originalB.y;
        const edgeDelta = Math.trunc((clipped.b.x - clipped.a.x) * fixedOne / (clippedBy - clippedAy));
        edges.push(originalA.y < originalB.y
            ? { y0: originalA.y, y1: originalB.y, x: clipped.a.x * fixedOne + (originalA.y - clippedAy) * edgeDelta, dx: edgeDelta }
            : { y0: originalB.y, y1: originalA.y, x: clipped.b.x * fixedOne + (originalB.y - clippedBy) * edgeDelta, dx: edgeDelta });
    }
    for (let y = 0; y < height; y += 1) {
        const intersections = edges.filter((edge) => y >= edge.y0 && y < edge.y1)
            .map((edge) => edge.x + (y - edge.y0) * edge.dx).sort((a, b) => a - b);
        for (let i = 0; i + 1 < intersections.length; i += 2) {
            const x0 = Math.max(0, Math.ceil(intersections[i] / fixedOne));
            const x1 = Math.min(width - 1, Math.floor(intersections[i + 1] / fixedOne));
            if (x1 >= x0) mask.fill(1, y * width + x0, y * width + x1 + 1);
        }
    }
    return mask;
}

function clipIntegerLine(start: DbPoint, end: DbPoint, width: number, height: number): { a: DbPoint; b: DbPoint; visible: boolean } {
    const a = { ...start }, b = { ...end }, right = width - 1, bottom = height - 1;
    const flags = ({ x, y }: DbPoint) => Number(x < 0) + Number(x > right) * 2 + Number(y < 0) * 4 + Number(y > bottom) * 8;
    let first = flags(a), second = flags(b);
    if (!(first & second) && (first | second)) {
        if (first & 12) {
            const y = first < 8 ? 0 : bottom;
            a.x += Math.trunc((y - a.y) * (b.x - a.x) / (b.y - a.y));
            a.y = y; first = Number(a.x < 0) + Number(a.x > right) * 2;
        }
        if (second & 12) {
            const y = second < 8 ? 0 : bottom;
            b.x += Math.trunc((y - b.y) * (b.x - a.x) / (b.y - a.y));
            b.y = y; second = Number(b.x < 0) + Number(b.x > right) * 2;
        }
        if (!(first & second) && (first | second)) {
            if (first) {
                const x = first === 1 ? 0 : right;
                a.y += Math.trunc((x - a.x) * (b.y - a.y) / (b.x - a.x));
                a.x = x; first = 0;
            }
            if (second) {
                const x = second === 1 ? 0 : right;
                b.y += Math.trunc((x - b.x) * (b.y - a.y) / (b.x - a.x));
                b.x = x; second = 0;
            }
        }
    }
    return { a, b, visible: !(first | second) };
}

function roundToEven(value: number): number {
    const floor = Math.floor(value);
    return value - floor === 0.5 ? floor + (Math.abs(floor) % 2) : Math.round(value);
}
