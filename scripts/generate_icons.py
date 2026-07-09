"""Regenerates icons/icon-{16,32,48,128}.png from a single vector drawing.

Run with: uv run --with pillow scripts/generate_icons.py
"""

from pathlib import Path
import math

from PIL import Image, ImageDraw

OUT_DIR = Path(__file__).resolve().parent.parent / "icons"
OUT_DIR.mkdir(exist_ok=True)

SIZE = 512
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Background: rounded square, dark navy
bg_color = (26, 26, 46, 255)  # #1a1a2e
pad = 20
radius = 110
draw.rounded_rectangle([pad, pad, SIZE - pad, SIZE - pad], radius=radius, fill=bg_color)

# Receipt shape (cream/white) centered, slightly left, with a zigzag bottom edge
receipt_color = (250, 248, 242, 255)
rx0, rx1 = 130, 340
ry0 = 90
ry_flat_bottom = 380
zig_amplitude = 16
zig_count = 8

points = [(rx0, ry0), (rx1, ry0)]
# right side straight down to start of zigzag
points.append((rx1, ry_flat_bottom))
# zigzag along the bottom, right to left
zig_width = (rx1 - rx0) / zig_count
for i in range(zig_count):
    x = rx1 - i * zig_width
    y = ry_flat_bottom + (zig_amplitude if i % 2 == 0 else 0)
    points.append((int(x), int(y)))
points.append((rx0, ry_flat_bottom))
points.append((rx0, ry0))

draw.polygon(points, fill=receipt_color)

# Lines of "text" on the receipt
line_color = (170, 170, 185, 255)
line_x0 = rx0 + 26
line_x1 = rx1 - 26
line_ys = [140, 172, 204, 236, 268]
for i, y in enumerate(line_ys):
    x1 = line_x1 if i % 3 != 2 else line_x1 - 40
    draw.line([(line_x0, y), (x1, y)], fill=line_color, width=10)

# Magnifying glass, bottom-right, overlapping the receipt corner
glass_color = (43, 45, 110, 255)  # #2b2d6e
glass_cx, glass_cy, glass_r = 330, 330, 95
draw.ellipse(
    [glass_cx - glass_r, glass_cy - glass_r, glass_cx + glass_r, glass_cy + glass_r],
    outline=glass_color,
    width=34,
)
handle_len = 90
angle = math.radians(45)
hx0 = glass_cx + glass_r * math.cos(angle)
hy0 = glass_cy + glass_r * math.sin(angle)
hx1 = hx0 + handle_len * math.cos(angle)
hy1 = hy0 + handle_len * math.sin(angle)
draw.line([(hx0, hy0), (hx1, hy1)], fill=glass_color, width=38)

# Flag badge, top-right corner: solid orange circle with exclamation.
# Matches the UI's #b8430d accent (darkened from the initial #d9480f to clear
# WCAG AA contrast for white text/icon strokes drawn on top of it).
badge_color = (184, 67, 13, 255)  # #b8430d
bcx, bcy, br = 400, 130, 78
draw.ellipse([bcx - br, bcy - br, bcx + br, bcy + br], fill=badge_color, outline=bg_color, width=14)

# exclamation mark
draw.rounded_rectangle([bcx - 14, bcy - 42, bcx + 14, bcy + 18], radius=12, fill=(255, 255, 255, 255))
draw.ellipse([bcx - 14, bcy + 30, bcx + 14, bcy + 58], fill=(255, 255, 255, 255))

for size in (16, 32, 48, 128):
    resized = img.resize((size, size), Image.Resampling.LANCZOS)
    resized.save(OUT_DIR / f"icon-{size}.png")

print(f"Wrote icon-{{16,32,48,128}}.png to {OUT_DIR}")
