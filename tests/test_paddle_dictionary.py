"""Offline regression checks for PP-OCRv6's exported CTC dictionary contract."""

import runpy
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


if __name__ == "__main__":
    unittest.main()
