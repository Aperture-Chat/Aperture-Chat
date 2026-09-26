#!/usr/bin/env python3
"""Generate the synthetic slide background the deck training capture uploads
through "Upload background…" (capture-deck-frames.cjs).

The image is drawn here from simple shapes, so it is neither a photo nor AI
output: the scene it appears in teaches uploading your own background. Rebuild
with:

    services/api/.venv/bin/python apps/web/scripts/fixtures/generate-deck-background.py

Produces deck-background.jpg beside this script at the 16:9 slide ratio.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

OUT = Path(__file__).parent / "deck-background.jpg"
WIDTH, HEIGHT = 1600, 900
TOP = (232, 243, 244)
BOTTOM = (196, 222, 226)
BANDS = [
    ((8, 125, 139), 0.20, 540),
    ((31, 42, 86), 0.12, 640),
    ((232, 163, 61), 0.10, 720),
]


def gradient() -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(image)
    for y in range(HEIGHT):
        t = y / (HEIGHT - 1)
        draw.line([(0, y), (WIDTH, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)))
    return image


def main() -> None:
    image = gradient().convert("RGBA")
    for color, alpha, baseline in BANDS:
        layer = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
        draw = ImageDraw.Draw(layer)
        # A gentle wave: a polygon under a sine-like curve built from arcs.
        points = [(0, HEIGHT)]
        for x in range(0, WIDTH + 1, 20):
            wave = ((x / WIDTH) * 2 - 1) ** 2
            points.append((x, baseline - 90 * (1 - wave) + 40 * (x / WIDTH)))
        points.append((WIDTH, HEIGHT))
        draw.polygon(points, fill=(*color, round(255 * alpha)))
        image = Image.alpha_composite(image, layer.filter(ImageFilter.GaussianBlur(6)))
    image.convert("RGB").save(OUT, "JPEG", quality=86, optimize=True)
    print(f"Wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
