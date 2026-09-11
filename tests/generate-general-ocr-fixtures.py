"""Generate deterministic, known-label OCR samples without a model or network access.

Requires Pillow and locally installed Meiryo / Yu Mincho fonts. The generated PNGs,
not the font files, are committed. See fixtures/GENERAL-OCR-PROVENANCE.md.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, __version__ as pillow_version


ROOT = Path(__file__).resolve().parent
CASES = [
    dict(name="general-001-horizontal-japanese", text="本日は晴天です。", size=34),
    dict(name="general-002-mixed-japanese-latin-digits", text="日本語 OCR Test 2026", size=34),
    dict(name="general-003-apostrophe-date", text="It's 2026年9月11日", size=34),
    dict(name="general-004-long-horizontal", text="日本語の長い文章を省略せず読み取り、数字1234567890と英語ABCも正確に表示します。", size=24),
    dict(name="general-005-colored-text", text="青い文字と赤い数字 123", size=34, background="#fff2cc", foreground="#124bcc", accent="123"),
    dict(name="general-006-white-on-dark", text="夜間モードでも読めます 2026", size=32, background="#172033", foreground="#ffffff"),
    dict(name="general-007-rotated-horizontal", text="少し傾いた日本語の文章です", size=32, angle=8),
    dict(name="general-008-vertical-three-columns", text="明日の予定\n図書館へ行く\n本を三冊借りる", size=34, vertical=True),
    dict(name="general-009-horizontal-three-lines", text="受付時間は午前九時です\n予約番号は12345です\n入口で名前を伝えてください", size=30),
    dict(name="general-010-serif-japanese", text="図書館で新しい本を読みました。", size=34, serif=True),
]


def draw_horizontal(spec: dict, font_path: Path) -> Image.Image:
    font = ImageFont.truetype(str(font_path), spec["size"])
    lines = spec["text"].split("\n")
    scratch = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    line_width = max(scratch.textlength(line, font=font) for line in lines)
    padding = 24
    ascent, descent = font.getmetrics()
    line_step = ascent + descent + 14
    image = Image.new("RGB", (int(line_width + 0.999) + padding * 2,
                             line_step * len(lines) + padding * 2), spec.get("background", "#ffffff"))
    draw = ImageDraw.Draw(image)
    for index, line in enumerate(lines):
        y = padding + index * line_step
        if "accent" in spec:
            start = line.index(spec["accent"])
            x = padding + draw.textlength(line[:start], font=font)
            # Shared ascent anchor preserves the baseline without drawing glyphs twice.
            draw.text((padding, y), line[:start], font=font, fill=spec["foreground"], anchor="la")
            draw.text((x, y), spec["accent"], font=font, fill="#b21818", anchor="la")
        else:
            draw.text((padding, y), line, font=font, fill=spec.get("foreground", "#111111"), anchor="lt")
    if "angle" in spec:
        image = image.rotate(spec["angle"], resample=Image.Resampling.BICUBIC,
                             expand=True, fillcolor=spec.get("background", "#ffffff"))
    return image


def draw_vertical(spec: dict, font_path: Path) -> Image.Image:
    font = ImageFont.truetype(str(font_path), spec["size"])
    columns = spec["text"].split("\n")
    padding = 26
    column_step = spec["size"] + 28
    character_step = spec["size"] + 5
    image = Image.new("RGB", (padding * 2 + column_step * len(columns),
                             padding * 2 + character_step * max(map(len, columns))), "white")
    draw = ImageDraw.Draw(image)
    for index, column in enumerate(columns):
        x = padding + column_step * (len(columns) - index - 1) + spec["size"] / 2
        for row, character in enumerate(column):
            draw.text((x, padding + character_step * row), character, font=font, fill="#111111", anchor="mt")
    return image


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sans-font", type=Path, default=Path("C:/Windows/Fonts/meiryo.ttc"))
    parser.add_argument("--serif-font", type=Path, default=Path("C:/Windows/Fonts/yumin.ttf"))
    args = parser.parse_args()
    for font_path in (args.sans_font, args.serif_font):
        if not font_path.is_file():
            parser.error(f"Font missing: {font_path}. Pass the path to a locally installed equivalent font.")

    output = ROOT / "fixtures" / "images"
    output.mkdir(parents=True, exist_ok=True)
    metadata = {"generator": Path(__file__).name, "pillow_version": pillow_version, "cases": []}
    thumbnails = []
    for index, spec in enumerate(CASES, 1):
        font_path = args.serif_font if spec.get("serif") else args.sans_font
        image = draw_vertical(spec, font_path) if spec.get("vertical") else draw_horizontal(spec, font_path)
        filename = f"ocr-general-{index:03}.png"
        image.save(output / filename, format="PNG", optimize=False)
        metadata["cases"].append({
            **spec,
            "image": f"images/{filename}",
            "width": image.width,
            "height": image.height,
            "sha256": hashlib.sha256((output / filename).read_bytes()).hexdigest(),
            "font": font_path.name,
            "font_sha256": hashlib.sha256(font_path.read_bytes()).hexdigest(),
        })
        print(f"{spec['name']}: {image.width} x {image.height}")
        preview = image.copy()
        preview.thumbnail((1050, 330))
        thumbnails.append((spec["name"], preview))

    (ROOT / "fixtures" / "general-ocr-metadata.json").write_text(
        json.dumps(metadata, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    # A contact sheet makes clipping, missing glyphs, and reading order reviewable.
    sheet = Image.new("RGB", (1120, sum(image.height + 48 for _, image in thumbnails) + 24), "#e8e8e8")
    draw = ImageDraw.Draw(sheet)
    label_font = ImageFont.truetype(str(args.sans_font), 16)
    top = 12
    for name, image in thumbnails:
        draw.text((16, top), name, font=label_font, fill="#111111")
        sheet.paste(image, (16, top + 28))
        top += image.height + 48
    sheet.save(ROOT / "fixtures" / "general-ocr-contact-sheet.png")


if __name__ == "__main__":
    main()
