# General OCR synthetic fixtures

These ten samples were created for Namida's PP-OCRv6 integration comparison on
11 September 2026. The Japanese and English strings are original benchmark text;
there is no downloaded document, image-generation model, or OCR-derived label.
The labels in `tests/ocr-cases.ts` are the exact strings given to the renderer.
The existing twenty case names and expected labels are unchanged.

`tests/generate-general-ocr-fixtures.py` draws the text locally with Pillow 12.3.0.
The committed PNGs use the installed Microsoft Meiryo font, except sample 010,
which uses Yu Mincho. No font files are redistributed. Font filenames and SHA-256
hashes, text, settings, image dimensions, and PNG hashes are preserved in
`general-ocr-metadata.json`. The contact sheet provides a visual review of every
sample. Generated assets are source fixtures, not recognition/debug outputs.

| Sample | Coverage | Native pixels |
| --- | --- | --- |
| 001 | Clean horizontal Japanese with full stop | 320 × 114 |
| 002 | Japanese, Latin upper/lower case, spaces, digits | 409 × 114 |
| 003 | Literal ASCII apostrophe, English, Japanese date, digits | 362 × 114 |
| 004 | Long unwrapped line, Japanese punctuation, ten digits, Latin | 1038 × 99 |
| 005 | Blue Japanese and red digits on a pale yellow background | 429 × 114 |
| 006 | White Japanese and digits on a dark blue background | 491 × 111 |
| 007 | Horizontal Japanese rotated counterclockwise by 8 degrees | 476 × 175 |
| 008 | Three vertical columns, top to bottom, columns right to left | 238 × 325 |
| 009 | Three horizontal lines, top to bottom, including digits | 438 × 228 |
| 010 | Serif Japanese, contrasting with the sans-serif samples | 558 × 100 |

All new cases use native display size and `upscalingMode: 'none'`. This tests
ordinary clear text without forcing 4× upscaling and avoids adding browser/model
work just to preserve an old manga-specific test setting. The existing cases
retain their previous upscaling settings. Use `NAMIDA_TEST_OCR_INPUT_MODE=fixture`
for comparisons of identical input PNGs and retain the per-case input hashes.
The normal snip mode remains an integration test of screen capture.

No per-case accuracy threshold is assigned before measuring either backend. Report
the original twenty and these ten as separate cohorts as well as reporting the
combined score; adding easy cases must not hide regressions in old cases. Current
scoring removes whitespace, so these samples include spaces but do not test exact
word-spacing preservation. The apostrophe remains significant in scoring.

These are controlled synthetic probes, not a representative natural-image test
set. They do not establish performance for handwriting, severe perspective,
motion blur, all fonts, or all page layouts. Vertical sample 008 uses upright
Japanese glyphs without punctuation that would require vertical glyph variants.

Regenerate on a machine with Pillow and the original installed fonts:

```powershell
python tests/generate-general-ocr-fixtures.py
```

The script accepts `--sans-font` and `--serif-font` paths. Different font files or
Pillow versions may change pixels: review and preserve the new metadata and PNGs,
then collect a new baseline before comparing implementations.
