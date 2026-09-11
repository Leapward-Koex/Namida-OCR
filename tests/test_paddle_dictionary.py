"""Offline regression checks for PP-OCRv6's exported CTC dictionary contract."""

import runpy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PREPARE = runpy.run_path(str(ROOT / "prepare-paddleocr-onnx.py"))


class PaddleDictionaryTests(unittest.TestCase):
    def write_dictionary(self, source: str) -> list[str]:
        with tempfile.TemporaryDirectory() as directory:
            yaml_path = Path(directory) / "inference.yml"
            dict_path = Path(directory) / "dict.txt"
            yaml_path.write_text(source, encoding="utf-8")
            PREPARE["write_dictionary_file"](yaml_path, dict_path)
            return dict_path.read_text(encoding="utf-8").splitlines()

    def test_yaml_quotes_preserve_one_class_per_character(self):
        characters = self.write_dictionary(
            "PostProcess:\n"
            "  name: CTCLabelDecode\n"
            "  character_dict:\n"
            "  - ''''\n"
            "  - '\"'\n"
            '  - "\\u65e5"\n'
            "  - 本\n"
            "  - 🚀\n"
        )
        self.assertEqual(characters, ["'", '"', "日", "本", "🚀", " "])

    def test_explicit_space_setting_and_dictionary_boundary(self):
        source = (
            "PostProcess:\n"
            "  character_dict:\n"
            "  - 日\n"
            "  use_space_char: false\n"
            "AnotherSection:\n"
            "  - unrelated\n"
        )
        self.assertEqual(self.write_dictionary(source), ["日"])

    def test_literal_space_keeps_its_class_and_appended_space_index(self):
        # Upstream appends the CTC space class without deduplicating entries.
        self.assertEqual(
            self.write_dictionary("PostProcess:\n  character_dict:\n  - ' '\n"),
            [" ", " "],
        )

    def test_invalid_line_dictionary_entries_fail(self):
        for scalar in ("''", '"\\n"', '"\\r"', "'unclosed", "|", "*alias"):
            with self.subTest(scalar=scalar), self.assertRaises(ValueError):
                PREPARE["decode_dictionary_scalar"](scalar)

    def test_committed_bundles_match_exported_output_classes(self):
        # Both bundled recognizer graphs expose 18,710 CTC classes:
        # blank + 18,708 exported characters + appended space.
        for variant in PREPARE["MODEL_VARIANTS"]:
            with self.subTest(variant=variant):
                dictionary = (
                    ROOT / "models" / "paddleocr" / variant
                    / "languages" / "chinese" / "dict.txt"
                ).read_text(encoding="utf-8").splitlines()
                self.assertEqual(len(dictionary) + 1, 18710)
                self.assertEqual(dictionary[6], "'")
                self.assertEqual(dictionary[-1], " ")

    def test_source_lock_rejects_mutable_revisions_and_missing_hashes(self):
        for source in ({"revision": "main"}, {"revision": "a" * 40, "files": {}}):
            with self.subTest(source=source), self.assertRaises(ValueError):
                PREPARE["require_model_source"]({"test/repo": source}, "test/repo")

    def test_asset_verification_rejects_modified_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "inference.yml"
            path.write_bytes(b"verified bytes")
            expected = {"size": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
            PREPARE["verify_file"](path, expected)
            path.write_bytes(b"tampered bytes")
            with self.assertRaisesRegex(ValueError, "asset hash/size mismatch"):
                PREPARE["verify_file"](path, expected)

    def test_bundle_provenance_matches_pinned_sources_and_shipped_assets(self):
        sources = json.loads((ROOT / "models/paddleocr/sources.json").read_text())["sources"]
        for variant, selection in PREPARE["MODEL_VARIANTS"].items():
            directory = ROOT / "models/paddleocr" / variant
            manifest = json.loads((directory / "manifest.json").read_text())
            with self.subTest(variant=variant):
                self.assertEqual(manifest["recognizer"]["base_image_width"], 320)
                self.assertEqual(manifest["recognizer"]["max_image_width"], 3200)
                self.assertEqual(manifest["recognizer"]["normalized_padding"], 0)
                self.assertEqual(manifest["recognizer"]["output_classes"], 18710)
                self.assertFalse(manifest["detector"]["use_dilation"])
                self.assertEqual(manifest["detector"]["max_candidates"], 3000)
                for stage, repo_key in (("detector", "det_repo"), ("recognizer", "rec_repo")):
                    self.assertEqual(manifest[stage]["channel_order"], "BGR")
                    config_path = directory / manifest[stage]["config_path"]
                    config = json.loads(config_path.read_text())
                    source = PREPARE["require_model_source"](sources, selection[repo_key])
                    self.assertEqual(config["source_revision"], source["revision"])
                    PREPARE["verify_file"](directory / manifest[stage]["model_path"], source["files"]["inference.onnx"])
                    PREPARE["verify_file"](config_path.parent / config["inference_config_path"], source["files"]["inference.yml"])


if __name__ == "__main__":
    unittest.main()
