#!/usr/bin/env python3
"""Download official PaddleOCR repos, export them to ONNX, and emit bundle metadata.

This is a developer-only regeneration tool. Production runtime must use the committed
assets under models/paddleocr and never download models at runtime.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

try:
    import onnx
except ModuleNotFoundError as exc:  # pragma: no cover - developer environment guard
    raise SystemExit(
        "The 'onnx' Python package is required to normalize exported PaddleOCR models for ONNX Runtime Web. "
        "Install it in your active Python environment before running this script."
    ) from exc


DEFAULT_DET_REPO = "PaddlePaddle/PP-OCRv5_server_det"
DEFAULT_REC_REPO = "PaddlePaddle/PP-OCRv5_server_rec"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path("models/paddleocr"))
    parser.add_argument("--work-dir", type=Path, default=Path(".cache/paddleocr-onnx"))
    parser.add_argument("--det-repo", default=DEFAULT_DET_REPO)
    parser.add_argument("--rec-repo", default=DEFAULT_REC_REPO)
    parser.add_argument("--skip-download", action="store_true")
    parser.add_argument("--skip-convert", action="store_true")
    args = parser.parse_args()

    output_dir = args.output_dir.resolve()
    work_dir = args.work_dir.resolve()
    det_source_dir = work_dir / "det-source"
    rec_source_dir = work_dir / "rec-source"
    det_output_dir = output_dir / "detection" / "v5"
    rec_output_dir = output_dir / "languages" / "chinese"

    if not args.skip_download:
        require_command("hf")
        download_repo(args.det_repo, det_source_dir)
        download_repo(args.rec_repo, rec_source_dir)

    det_model_dir = find_model_dir(det_source_dir)
    rec_model_dir = find_model_dir(rec_source_dir)
    dict_path = find_dictionary_file(rec_source_dir)

    output_dir.mkdir(parents=True, exist_ok=True)
    det_output_dir.mkdir(parents=True, exist_ok=True)
    rec_output_dir.mkdir(parents=True, exist_ok=True)

    if args.skip_convert:
        print("Skipping conversion; only refreshing metadata and dictionary.")
    else:
        require_command("paddlex")
        run(["paddlex", "--install", "paddle2onnx"])
        convert_model(det_model_dir, det_output_dir)
        convert_model(rec_model_dir, rec_output_dir)

    shutil.copy2(dict_path, rec_output_dir / "dict.txt")
    write_json(
        det_output_dir / "config.json",
        {
            "model_name": "PP-OCRv5_server_det",
            "model_type": "detection",
            "framework": "PaddleOCR",
            "version": "PP-OCRv5",
            "source_repo": args.det_repo,
            "original_format": "PaddlePaddle",
            "converted_format": "ONNX",
            "input_shape": "dynamic (batch_size, 3, height, width)",
            "output_shape": "dynamic",
        },
    )
    write_json(
        rec_output_dir / "config.json",
        {
            "model_name": "PP-OCRv5_server_rec",
            "model_type": "recognition",
            "framework": "PaddleOCR",
            "version": "PP-OCRv5",
            "language_group": "chinese",
            "supported_languages": [
                "Chinese (Simplified)",
                "Pinyin",
                "Traditional Chinese",
                "English",
                "Japanese",
            ],
            "source_repo": args.rec_repo,
            "original_format": "PaddlePaddle",
            "converted_format": "ONNX",
            "dictionary_file": "dict.txt",
            "input_shape": "dynamic (batch_size, 3, 48, dynamic_width)",
            "output_shape": "dynamic (batch_size, sequence_length, num_classes)",
        },
    )
    write_json(
        output_dir / "manifest.json",
        {
            "version": "generated",
            "source_repo": args.rec_repo,
            "detector": {
                "model_path": "detection/v5/det.onnx",
                "config_path": "detection/v5/config.json",
                "limit_side_len": 736,
                "limit_type": "min",
                "max_side_len": 1536,
                "mean": [0.485, 0.456, 0.406],
                "std": [0.229, 0.224, 0.225],
                "threshold": 0.3,
                "box_score_threshold": 0.55,
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

    print(f"Prepared PaddleOCR ONNX bundle at {output_dir}")
    return 0


def download_repo(repo_id: str, target_dir: Path) -> None:
    target_dir.parent.mkdir(parents=True, exist_ok=True)
    run(["hf", "download", repo_id, "--local-dir", str(target_dir), "--quiet"])


def convert_model(source_dir: Path, target_dir: Path) -> None:
    run(
        [
            "paddlex",
            "--paddle2onnx",
            "--paddle_model_dir",
            str(source_dir),
            "--onnx_model_dir",
            str(target_dir),
            "--opset_version",
            "11",
        ]
    )

    onnx_files = sorted(target_dir.glob("*.onnx"))
    if not onnx_files:
        raise SystemExit(f"No ONNX file was produced in {target_dir}")

    canonical_name = target_dir / ("det.onnx" if "detection" in str(target_dir) else "rec.onnx")
    if onnx_files[0] != canonical_name:
        shutil.move(str(onnx_files[0]), canonical_name)

    normalized_nodes = normalize_maxpool_ceil_mode(canonical_name)
    if normalized_nodes:
        print(
            f"Normalized MaxPool ceil_mode to 0 in {canonical_name}: "
            + ", ".join(normalized_nodes)
        )


def find_model_dir(root: Path) -> Path:
    pdmodel_files = sorted(root.rglob("*.pdmodel"))
    if not pdmodel_files:
        raise SystemExit(
            f"Could not find a Paddle inference model under {root}. "
            "Download the official repo first or pass --skip-download only when the work dir is already populated."
        )

    return pdmodel_files[0].parent


def find_dictionary_file(root: Path) -> Path:
    candidates = sorted(root.rglob("*dict*.txt"))
    if not candidates:
        raise SystemExit(f"Could not find a recognition dictionary file under {root}")

    return candidates[0]


def normalize_maxpool_ceil_mode(model_path: Path) -> list[str]:
    model = onnx.load(model_path)
    normalized_nodes: list[str] = []

    for node in model.graph.node:
        if node.op_type != "MaxPool":
            continue

        for attr in node.attribute:
            if attr.name == "ceil_mode" and attr.i != 0:
                attr.i = 0
                normalized_nodes.append(node.name or "<unnamed MaxPool>")

    if normalized_nodes:
        onnx.save(model, model_path)

    return normalized_nodes


def require_command(command: str) -> None:
    if shutil.which(command):
        return

    raise SystemExit(
        f"Required command '{command}' was not found.\n"
        "Install the Hugging Face CLI for downloads and PaddleX for Paddle -> ONNX conversion before running this script."
    )


def write_json(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def run(command: list[str]) -> None:
    print("+", " ".join(command))
    subprocess.run(command, check=True)


if __name__ == "__main__":
    sys.exit(main())
