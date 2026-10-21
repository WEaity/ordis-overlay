# -*- coding: utf-8 -*-
"""把带纯黑背景的 Ordis 图转成透明 PNG（亮度 -> alpha）。

用法：
    python tools\make_ordis_icon.py 源图.jpg 输出.png

原理：透明窗口里 mix-blend-mode: screen 是拿不到"桌面"当背景的，
纯黑像素不会被减掉，会露出一个黑方块。所以先把黑色变成真透明。
"""
import sys
from PIL import Image

FLOOR = 20      # 亮度低于这个值直接视为全透明
GAMMA = 1.30    # 越大，暗部越透明
SIZE = 512      # 输出边长


def process(src, dst, size=SIZE, floor=FLOOR, gamma=GAMMA):
    im = Image.open(src).convert("RGB")
    px = im.load()
    w, h = im.size
    out = Image.new("RGBA", (w, h))
    op = out.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
            v = (lum - floor) / (255 - floor)
            if v <= 0:
                op[x, y] = (0, 0, 0, 0)
                continue
            a = min(1.0, v ** gamma)
            k = 1.0 + 0.3 * (1 - a)          # 半透明处补一点亮度
            op[x, y] = (
                min(255, int(r * k)),
                min(255, int(g * k)),
                min(255, int(b * k)),
                int(a * 255),
            )
    bbox = out.getbbox()
    if bbox:
        pad = 2
        out = out.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                        min(w, bbox[2] + pad), min(h, bbox[3] + pad)))
    out = out.resize((size, size), Image.LANCZOS)
    out.save(dst)
    print("saved", dst, out.size)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    process(sys.argv[1], sys.argv[2])
