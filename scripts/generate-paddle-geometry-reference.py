"""Generate development-only OpenCV/Pyclipper parity data. No model or network needed.

Use Python 3 with numpy, opencv-python-headless==4.13.0.92, pyclipper==1.4.0.
The reference algorithms follow PaddleX DBPostProcess quad/fast and
CropByPolys.get_rotate_crop_image (Apache-2.0). Fixtures are reproducible arrays,
not the implementation's own output. See third-party/PaddleGeometry-NOTICE.txt.
"""
import json
import math
from pathlib import Path

import cv2
import numpy as np
import pyclipper


def mini_box(points):
    rectangle = cv2.minAreaRect(np.asarray(points, dtype=np.float32))
    vertices = sorted(cv2.boxPoints(rectangle).tolist(), key=lambda point: point[0])
    left = sorted(vertices[:2], key=lambda point: point[1])
    right = sorted(vertices[2:], key=lambda point: point[1])
    return np.asarray([left[0], right[0], right[1], left[1]], dtype=np.float32), min(rectangle[1])


def score(pred, points):
    h, w = pred.shape
    xmin = max(0, min(math.floor(points[:, 0].min()), w - 1))
    xmax = max(0, min(math.ceil(points[:, 0].max()), w - 1))
    ymin = max(0, min(math.floor(points[:, 1].min()), h - 1))
    ymax = max(0, min(math.ceil(points[:, 1].max()), h - 1))
    mask = np.zeros((ymax - ymin + 1, xmax - xmin + 1), dtype=np.uint8)
    relative = points.copy()
    relative[:, 0] -= xmin
    relative[:, 1] -= ymin
    cv2.fillPoly(mask, relative.reshape(1, -1, 2).astype(np.int32), 1)
    return cv2.mean(pred[ymin:ymax + 1, xmin:xmax + 1], mask)[0]


def unclip(points, ratio):
    distance = cv2.contourArea(points) * ratio / cv2.arcLength(points, True)
    offset = pyclipper.PyclipperOffset()
    offset.AddPath(points, pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
    return np.asarray(offset.Execute(distance), dtype=np.int32).reshape(-1, 2)


def postprocess(pred, dest_width, dest_height, threshold=.3, box_threshold=.6, ratio=1.4, max_candidates=1000):
    contours, _ = cv2.findContours((pred > threshold).astype(np.uint8) * 255, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours[:max_candidates]:
        points, short_side = mini_box(contour)
        if short_side < 3:
            continue
        confidence = score(pred, points)
        if confidence < box_threshold:
            continue
        expanded, short_side = mini_box(unclip(points, ratio))
        if short_side < 5:
            continue
        scaled = [[max(0, min(round(float(x) * dest_width / pred.shape[1]), dest_width)),
                   max(0, min(round(float(y) * dest_height / pred.shape[0]), dest_height))] for x, y in expanded]
        boxes.append(dict(points=scaled, score=confidence))
    return boxes


def crop(image, quad, refit=False):
    points = np.asarray(quad, dtype=np.float32)
    if refit:
        points, _ = mini_box(points.astype(np.int32))
    width = int(max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3])))
    height = int(max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2])))
    target = np.float32([[0, 0], [width, 0], [width, height], [0, height]])
    matrix = cv2.getPerspectiveTransform(points, target)
    output = cv2.warpPerspective(image, matrix, (width, height), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    rotated = height / width >= 1.5
    if rotated:
        output = np.rot90(output)
    return dict(width=output.shape[1], height=output.shape[0], data=output.ravel().tolist(), rotated=rotated)


def main():
    rng = np.random.default_rng(641031)
    contour_cases = []
    for index in range(50):
        bitmap = (rng.random((9, 11)) > (0.3 if index < 25 else 0.75)).astype(np.uint8)
        contours, _ = cv2.findContours(bitmap, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        contour_cases.append(dict(name=f"random-{index:02}", width=11, height=9, bitmap=bitmap.ravel().tolist(),
                                  contours=[c.reshape(-1, 2).tolist() for c in contours]))
    maps = []
    axis = np.zeros((32, 48), dtype=np.float32)
    axis[7:18, 4:29] = .9
    maps.append(("axis-aligned", axis))
    ring = axis.copy()
    ring[10:15, 10:23] = .01
    maps.append(("hole-contour", ring))
    diagonal = np.zeros((36, 48), dtype=np.float32)
    cv2.fillPoly(diagonal, [np.int32([[5, 15], [34, 4], [39, 16], [10, 27]])], .92)
    maps.append(("rotated-line", diagonal))
    concave = np.zeros((28, 40), dtype=np.float32)
    concave[4:22, 4:12] = .9
    concave[16:22, 4:32] = .9
    maps.append(("concave-score-rejection", concave))
    touching = np.zeros((28, 40), dtype=np.float32)
    touching[0:12, 0:17] = .85
    touching[18:28, 29:40] = .75
    maps.append(("edge-clipping-order", touching))
    thin = np.zeros((28, 40), dtype=np.float32)
    thin[4:7, 3:20] = .95
    thin[15:19, 9:28] = .95
    maps.append(("short-side-threshold", thin))
    candidates = np.zeros((50, 60), dtype=np.float32)
    for y in range(3, 50, 12):
        for x in range(3, 60, 14):
            candidates[y:y + 7, x:x + 9] = .8
    maps.append(("candidate-limit", candidates))
    for index, angle in enumerate(range(-81, 82, 9)):
        pred = np.zeros((48, 64), dtype=np.float32)
        quad = cv2.boxPoints(((32., 24.), (30., 9.), float(angle)))
        cv2.fillPoly(pred, [np.rint(quad).astype(np.int32)], .92)
        maps.append((f"rotation-{index:02}-{angle:+d}", pred))
    db_cases = []
    for name, pred in maps:
        options = dict(threshold=.3, boxThreshold=.6, unclipRatio=1.4, maxCandidates=3 if name == "candidate-limit" else 1000)
        dw, dh = pred.shape[1] * 2, pred.shape[0] * 2
        db_cases.append(dict(name=name, width=pred.shape[1], height=pred.shape[0], probabilities=pred.ravel().tolist(),
                             imageWidth=dw, imageHeight=dh, options=options,
                             detections=postprocess(pred, dw, dh, max_candidates=options["maxCandidates"])))
    polygon_cases = []
    for index in range(25):
        quad = cv2.boxPoints(((12., 11.), (float(rng.integers(5, 18)), float(rng.integers(4, 13))), float(rng.integers(-70, 70))))
        points = quad.astype(np.int32)
        mask = np.zeros((24, 26), dtype=np.uint8)
        cv2.fillPoly(mask, [points], 1)
        polygon_cases.append(dict(points=points.tolist(), width=26, height=24, mask=mask.ravel().tolist()))
    for quad in [[[-5, 3], [18, -4], [29, 17], [4, 29]], [[-4, 8], [8, -3], [12, 6], [2, 17]],
                 [[18, 14], [24, 8], [30, 23], [24, 29]]]:
        mask = np.zeros((24, 26), dtype=np.uint8)
        cv2.fillPoly(mask, [np.int32(quad)], 1)
        polygon_cases.append(dict(points=quad, width=26, height=24, mask=mask.ravel().tolist()))
    offset_cases = []
    for quad in [[[3., 4.], [24., 4.], [24., 12.], [3., 12.]],
                 [[4.25, 14.3], [25.7, 4.8], [30.75, 16.45], [9.3, 25.95]]]:
        points = np.float32(quad)
        offset_cases.append(dict(points=points.tolist(), ratio=1.4, expanded=unclip(points, 1.4).tolist()))
    yy, xx = np.indices((20, 24))
    image = np.stack(((xx * 23 + yy * 11) % 256, (xx * 7 + yy * 17) % 256, (xx * 3 + yy * 31) % 256, np.full_like(xx, 255)), axis=2).astype(np.uint8)
    crop_cases = []
    for name, quad in [
        ("axis", [[2, 3], [18, 3], [18, 14], [2, 14]]),
        ("tall-ccw", [[4, 2], [10, 2], [10, 17], [4, 17]]),
        ("perspective", [[4, 2], [19, 4], [18, 17], [2, 13]]),
        ("border-replicate", [[-2, -1], [20, 2], [23, 17], [-1, 19]]),
        ("fractional", [[1.35, 4.125], [19.75, 1.25], [21.125, 11.675], [3.5, 16.]]),
    ]:
        crop_cases.append(dict(name=name, quad=quad, direct=crop(image, quad), refitted=crop(image, quad, True)))
    fixture = dict(reference=dict(opencv=cv2.__version__, pyclipper=pyclipper.__version__, numpy=np.__version__),
                   contours=contour_cases, db=db_cases, polygons=polygon_cases, offsets=offset_cases,
                   cropImage=dict(width=24, height=20, data=image.ravel().tolist()), crops=crop_cases)
    path = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "paddle-geometry-reference.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(fixture, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {path} ({path.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
