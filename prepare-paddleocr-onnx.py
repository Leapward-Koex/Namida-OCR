#!/usr/bin/env python3
"""Download official PP-OCRv6 ONNX repos and emit bundle metadata.

This is a developer-only regeneration tool. Production runtime must use the committed
assets under models/paddleocr and never download models at runtime.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path


MODEL_VERSION = "PP-OCRv6"
DETECTOR_OUTPUT_VERSION = "v6"
HF_RESOLVE_BASE_URL = "https://huggingface.co"

MODEL_VARIANTS = {
    "server": {
        "description": "Chromium default: strongest PP-OCRv6 bundle that fits below the previous server bundle size.",
        "det_repo": "PaddlePaddle/PP-OCRv6_medium_det_onnx",
        "rec_repo": "PaddlePaddle/PP-OCRv6_medium_rec_onnx",
        "det_model_name": "PP-OCRv6_medium_det",
        "rec_model_name": "PP-OCRv6_medium_rec",
    },
    "mobile_det_server_rec": {
        "description": "Firefox default: smaller detector with the strongest recognizer under the current add-on size budget.",
        "det_repo": "PaddlePaddle/PP-OCRv6_small_det_onnx",
        "rec_repo": "PaddlePaddle/PP-OCRv6_medium_rec_onnx",
        "det_model_name": "PP-OCRv6_small_det",
        "rec_model_name": "PP-OCRv6_medium_rec",
    },
    "mobile": {
        "description": "Compact override bundle for constrained packaging and manual testing.",
        "det_repo": "PaddlePaddle/PP-OCRv6_tiny_det_onnx",
        "rec_repo": "PaddlePaddle/PP-OCRv6_small_rec_onnx",
        "det_model_name": "PP-OCRv6_tiny_det",
        "rec_model_name": "PP-OCRv6_small_rec",
    },
    "server_det_mobile_rec": {
        "description": "Mixed override bundle with the strongest detector and a smaller recognizer.",
        "det_repo": "PaddlePaddle/PP-OCRv6_medium_det_onnx",
        "rec_repo": "PaddlePaddle/PP-OCRv6_small_rec_onnx",
        "det_model_name": "PP-OCRv6_medium_det",
        "rec_model_name": "PP-OCRv6_small_rec",
    },
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--variant", choices=sorted(MODEL_VARIANTS), default="server")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--work-dir", type=Path, default=Path(".cache/paddleocr-onnx"))
    parser.add_argument("--det-repo")
    parser.add_argument("--rec-repo")
    parser.add_argument("--det-model-name")
    parser.add_argument("--rec-model-name")
    parser.add_argument("--skip-download", action="store_true")
    args = parser.parse_args()

    variant = MODEL_VARIANTS[args.variant]
    det_repo = args.det_repo or variant["det_repo"]
    rec_repo = args.rec_repo or variant["rec_repo"]
    det_model_name = args.det_model_name or variant["det_model_name"]
    rec_model_name = args.rec_model_name or variant["rec_model_name"]

    output_dir = (args.output_dir or (Path("models/paddleocr") / args.variant)).resolve()
    work_dir = args.work_dir.resolve()
    det_source_dir = work_dir / repo_cache_key(det_repo)
    rec_source_dir = work_dir / repo_cache_key(rec_repo)
    det_output_dir = output_dir / "detection" / DETECTOR_OUTPUT_VERSION
    rec_output_dir = output_dir / "languages" / "chinese"

    if not args.skip_download:
        download_onnx_repo(det_repo, det_source_dir)
        download_onnx_repo(rec_repo, rec_source_dir)

    det_model_path = require_file(det_source_dir / "inference.onnx")
    det_yaml_path = require_file(det_source_dir / "inference.yml")
    rec_model_path = require_file(rec_source_dir / "inference.onnx")
    rec_yaml_path = require_file(rec_source_dir / "inference.yml")

    reset_directory(det_output_dir)
    reset_directory(rec_output_dir)
    remove_stale_detector_versions(output_dir / "detection", det_output_dir)

    shutil.copy2(det_model_path, det_output_dir / "det.onnx")
    shutil.copy2(rec_model_path, rec_output_dir / "rec.onnx")
    write_dictionary_file(rec_yaml_path, rec_output_dir / "dict.txt")

    det_threshold = extract_yaml_number(det_yaml_path, "thresh", 0.3)
    det_box_threshold = extract_yaml_number(det_yaml_path, "box_thresh", 0.6)

    write_json(
        det_output_dir / "config.json",
        {
            "model_name": det_model_name,
            "model_type": "detection",
            "framework": "PaddleOCR",
            "version": MODEL_VERSION,
            "source_repo": det_repo,
            "original_format": "ONNX",
            "converted_format": "ONNX",
            "input_shape": "dynamic (batch_size, 3, height, width)",
            "output_shape": "dynamic",
        },
    )
    write_json(
        rec_output_dir / "config.json",
        {
            "model_name": rec_model_name,
            "model_type": "recognition",
            "framework": "PaddleOCR",
            "version": MODEL_VERSION,
            "language_group": "chinese",
            "supported_languages": [
                "Chinese (Simplified)",
                "Pinyin",
                "Traditional Chinese",
                "English",
                "Japanese",
            ],
            "source_repo": rec_repo,
            "original_format": "ONNX",
            "converted_format": "ONNX",
            "dictionary_file": "dict.txt",
            "input_shape": "dynamic (batch_size, 3, 48, dynamic_width)",
            "output_shape": "dynamic (batch_size, sequence_length, num_classes)",
        },
    )
    write_json(
        output_dir / "manifest.json",
        {
            "version": "2026-06-12",
            "model_version": MODEL_VERSION,
            "variant": args.variant,
            "description": variant["description"],
            "source_repo": f"{det_repo} + {rec_repo}",
            "detector": {
                "model_path": f"detection/{DETECTOR_OUTPUT_VERSION}/det.onnx",
                "config_path": f"detection/{DETECTOR_OUTPUT_VERSION}/config.json",
                "limit_side_len": 736,
                "limit_type": "min",
                "max_side_len": 1536,
                "mean": [0.485, 0.456, 0.406],
                "std": [0.229, 0.224, 0.225],
                "threshold": det_threshold,
                "box_score_threshold": det_box_threshold,
                "dilation_radius": 1,
                "min_box_size": 6,
                "box_padding": 4,
            },
            "recognizer": {
                "model_path": "languages/chinese/rec.onnx",
                "config_path": "languages/chinese/config.json",
                "dict_path": "languages/chinese/dict.txt",
                "image_height": 48,
                "min_image_width": 48,
                "max_image_width": 320,
                "mean": [0.5, 0.5, 0.5],
                "std": [0.5, 0.5, 0.5],
                "rotation_aspect_threshold": 1.5,
            },
        },
    )

    print(f"Prepared {MODEL_VERSION} ONNX {args.variant} bundle at {output_dir}")
    return 0


def download_onnx_repo(repo_id: str, target_dir: Path) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    for file_name in ["inference.onnx", "inference.yml", "README.md"]:
        required = file_name != "README.md"
        download_file(repo_id, file_name, target_dir / file_name, required=required)


def download_file(repo_id: str, file_name: str, target_path: Path, *, required: bool) -> None:
    url = f"{HF_RESOLVE_BASE_URL}/{repo_id}/resolve/main/{file_name}"
    print(f"+ download {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "namida-ocr-model-prep"})

    try:
        with urllib.request.urlopen(request) as response, target_path.open("wb") as file:
            shutil.copyfileobj(response, file)
    except urllib.error.HTTPError as exc:
        if not required and exc.code == 404:
            return
        raise


def write_dictionary_file(yaml_path: Path, target_path: Path) -> None:
    characters = extract_character_dictionary(yaml_path)
    if not characters:
        raise SystemExit(f"Could not find PostProcess.character_dict in {yaml_path}")

    if extract_yaml_boolean(yaml_path, "use_space_char", False) and " " not in characters:
        characters.append(" ")

    target_path.write_text("\n".join(characters) + "\n", encoding="utf-8")


def extract_character_dictionary(yaml_path: Path) -> list[str]:
    characters: list[str] = []
    in_dictionary = False

    for line in yaml_path.read_text(encoding="utf-8").splitlines():
        if not in_dictionary:
            if line.strip() == "character_dict:":
                in_dictionary = True
            continue

        item_match = re.match(r"^\s*-\x20?(.*)$", line)
        if item_match:
            value = item_match.group(1)
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                value = value[1:-1]
            characters.append(value)
            continue

        if line.strip():
            break

    return characters


def extract_yaml_number(yaml_path: Path, key: str, fallback: float) -> float:
    key_pattern = re.compile(rf"^\s*{re.escape(key)}:\s*([-+]?\d+(?:\.\d+)?)\s*$")
    for line in yaml_path.read_text(encoding="utf-8").splitlines():
        match = key_pattern.match(line)
        if match:
            return float(match.group(1))
    return fallback


def extract_yaml_boolean(yaml_path: Path, key: str, fallback: bool) -> bool:
    key_pattern = re.compile(rf"^\s*{re.escape(key)}:\s*(true|false)\s*$", re.IGNORECASE)
    for line in yaml_path.read_text(encoding="utf-8").splitlines():
        match = key_pattern.match(line)
        if match:
            return match.group(1).lower() == "true"
    return fallback


def require_file(path: Path) -> Path:
    if path.exists():
        return path
    raise SystemExit(f"Required model file was not found: {path}")


def reset_directory(path: Path) -> None:
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def remove_stale_detector_versions(detection_root: Path, active_output_dir: Path) -> None:
    if not detection_root.exists():
        return

    active_output_dir = active_output_dir.resolve()
    for entry in detection_root.iterdir():
        if entry.is_dir() and entry.resolve() != active_output_dir:
            shutil.rmtree(entry)


def repo_cache_key(repo_id: str) -> str:
    return repo_id.replace("/", "__")


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
