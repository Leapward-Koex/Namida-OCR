#!/usr/bin/env python3
"""Download official PP-OCRv6 ONNX repos and emit bundle metadata.

This is a developer-only regeneration tool. Production runtime must use the committed
assets under models/paddleocr and never download models at runtime.
"""

from __future__ import annotations

import argparse
import hashlib
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
SOURCE_LOCK_PATH = Path(__file__).resolve().parent / "models/paddleocr/sources.json"

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
    parser.add_argument("--source-lock", type=Path, default=SOURCE_LOCK_PATH,
                        help="Model repository revisions and SHA-256 hashes to verify before preparing assets.")
    parser.add_argument("--metadata-only", action="store_true",
                        help="Verify existing bundled weights and refresh metadata/configuration without copying weights.")
    args = parser.parse_args()

    variant = MODEL_VARIANTS[args.variant]
    det_repo = args.det_repo or variant["det_repo"]
    rec_repo = args.rec_repo or variant["rec_repo"]
    det_model_name = args.det_model_name or variant["det_model_name"]
    rec_model_name = args.rec_model_name or variant["rec_model_name"]
    sources = json.loads(args.source_lock.read_text(encoding="utf-8"))["sources"]
    det_source = require_model_source(sources, det_repo)
    rec_source = require_model_source(sources, rec_repo)

    output_dir = (args.output_dir or (Path("models/paddleocr") / args.variant)).resolve()
    work_dir = args.work_dir.resolve()
    det_source_dir = work_dir / repo_cache_key(det_repo)
    rec_source_dir = work_dir / repo_cache_key(rec_repo)
    det_output_dir = output_dir / "detection" / DETECTOR_OUTPUT_VERSION
    rec_output_dir = output_dir / "languages" / "chinese"

    if not args.skip_download:
        download_onnx_repo(det_repo, det_source_dir, det_source)
        download_onnx_repo(rec_repo, rec_source_dir, rec_source)

    det_model_path = require_file(det_source_dir / "inference.onnx")
    det_yaml_path = require_file(det_source_dir / "inference.yml")
    rec_model_path = require_file(rec_source_dir / "inference.onnx")
    rec_yaml_path = require_file(rec_source_dir / "inference.yml")
    verify_file(det_model_path, det_source["files"]["inference.onnx"])
    verify_file(det_yaml_path, det_source["files"]["inference.yml"])
    verify_file(rec_model_path, rec_source["files"]["inference.onnx"])
    verify_file(rec_yaml_path, rec_source["files"]["inference.yml"])

    det_output_dir.mkdir(parents=True, exist_ok=True)
    rec_output_dir.mkdir(parents=True, exist_ok=True)

    if args.metadata_only:
        verify_file(require_file(det_output_dir / "det.onnx"), det_source["files"]["inference.onnx"])
        verify_file(require_file(rec_output_dir / "rec.onnx"), rec_source["files"]["inference.onnx"])
    else:
        shutil.copy2(det_model_path, det_output_dir / "det.onnx")
        shutil.copy2(rec_model_path, rec_output_dir / "rec.onnx")
    # Keep the exact exported preprocessing/dictionary contract beside its graph.
    shutil.copy2(det_yaml_path, det_output_dir / "inference.yml")
    shutil.copy2(rec_yaml_path, rec_output_dir / "inference.yml")
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
            "source_revision": det_source["revision"],
            "model_sha256": det_source["files"]["inference.onnx"]["sha256"],
            "inference_config_path": "inference.yml",
            "inference_config_sha256": det_source["files"]["inference.yml"]["sha256"],
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
            "source_revision": rec_source["revision"],
            "model_sha256": rec_source["files"]["inference.onnx"]["sha256"],
            "inference_config_path": "inference.yml",
            "inference_config_sha256": rec_source["files"]["inference.yml"]["sha256"],
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
            "version": "2026-09-11",
            "model_version": MODEL_VERSION,
            "variant": args.variant,
            "description": variant["description"],
            "source_repo": f"{det_repo} + {rec_repo}",
            "detector": {
                "model_path": f"detection/{DETECTOR_OUTPUT_VERSION}/det.onnx",
                "config_path": f"detection/{DETECTOR_OUTPUT_VERSION}/config.json",
                "channel_order": "BGR",
                "resize_policy": "PaddleX c50f5da858020db473a2285f089bb8c7bbd6afdc standalone PP-OCRv6 predictor: max960, stride32; additional browser ceiling1536",
                "limit_side_len": 960,
                "limit_type": "max",
                "max_side_len": 1536,
                "mean": [0.485, 0.456, 0.406],
                "std": [0.229, 0.224, 0.225],
                "threshold": det_threshold,
                "box_score_threshold": det_box_threshold,
                "unclip_ratio": extract_yaml_number(det_yaml_path, "unclip_ratio", 1.4),
                "max_candidates": int(extract_yaml_number(det_yaml_path, "max_candidates", 1000)),
                "use_dilation": False,
                "score_mode": "fast",
                "min_box_size": 3,
            },
            "recognizer": {
                "model_path": "languages/chinese/rec.onnx",
                "config_path": "languages/chinese/config.json",
                "dict_path": "languages/chinese/dict.txt",
                "channel_order": "BGR",
                "image_height": 48,
                "base_image_width": 320,
                "max_image_width": 3200,
                "normalized_padding": 0,
                "width_overflow_policy": "resize-complete-line-to-3200",
                "output_activation": "softmax",
                "blank_index": 0,
                "output_classes": 18710,
                "score_threshold": 0.0,
                "rotation_aspect_threshold": 1.5,
            },
        },
    )

    print(f"Prepared {MODEL_VERSION} ONNX {args.variant} bundle at {output_dir}")
    return 0


def download_onnx_repo(repo_id: str, target_dir: Path, source: dict) -> None:
    target_dir.mkdir(parents=True, exist_ok=True)
    for file_name in ["inference.onnx", "inference.yml", "README.md"]:
        required = file_name != "README.md"
        download_file(repo_id, source["revision"], file_name, target_dir / file_name, required=required)
        if required:
            verify_file(target_dir / file_name, source["files"][file_name])


def download_file(repo_id: str, revision: str, file_name: str, target_path: Path, *, required: bool) -> None:
    url = f"{HF_RESOLVE_BASE_URL}/{repo_id}/resolve/{revision}/{file_name}"
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

    # PaddleX's CTCLabelDecode defaults use_space_char to True, including when
    # the exported inference.yml omits it. Blank is class 0 in the runtime;
    # the final space is an additional class after the exported dictionary.
    if extract_yaml_boolean(yaml_path, "use_space_char", True):
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
            characters.append(decode_dictionary_scalar(item_match.group(1)))
            continue

        if line.strip():
            break

    return characters


def decode_dictionary_scalar(value: str) -> str:
    """Decode the one-line YAML scalars used by exported character_dict lists.

    In YAML, a literal apostrophe is written as four single quotes. Removing
    just the outer quotes silently turns that one model class into two chars.
    Reject unsupported scalar forms rather than silently corrupting indices.
    """
    if value.startswith("'"):
        if re.fullmatch(r"'(?:[^']|'')*'", value) is None:
            raise ValueError(f"Invalid single-quoted dictionary scalar: {value!r}")
        value = value[1:-1].replace("''", "'")
    elif value.startswith('"'):
        # The model exports use JSON-compatible double-quoted escapes.
        # json.loads correctly decodes escaped quotes, slashes and Unicode.
        value = json.loads(value)
    elif value in ("|", ">") or value.startswith(("&", "*", "!")):
        raise ValueError(f"Unsupported dictionary scalar: {value!r}")

    if not value or "\n" in value or "\r" in value:
        raise ValueError(f"Dictionary entries must fit on one nonempty line: {value!r}")
    return value


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


def require_model_source(sources: dict, repo_id: str) -> dict:
    source = sources.get(repo_id)
    if not source or not re.fullmatch(r"[0-9a-f]{40}", source.get("revision", "")):
        raise ValueError(f"Provide an immutable repository revision in --source-lock for {repo_id}")
    for filename in ("inference.onnx", "inference.yml"):
        file = source.get("files", {}).get(filename, {})
        if not re.fullmatch(r"[0-9a-f]{64}", file.get("sha256", "")) or not isinstance(file.get("size"), int) or file["size"] <= 0:
            raise ValueError(f"Provide SHA-256 and positive byte size for {repo_id}/{filename} in --source-lock")
    return source


def verify_file(path: Path, expected: dict) -> None:
    with path.open("rb") as stream:
        actual_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    if path.stat().st_size != expected["size"] or actual_hash != expected["sha256"]:
        raise ValueError(f"PaddleOCR asset hash/size mismatch for {path}; expected {expected['sha256']}, received {actual_hash}")


def repo_cache_key(repo_id: str) -> str:
    return repo_id.replace("/", "__")


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
