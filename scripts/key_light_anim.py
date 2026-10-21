# -*- coding: utf-8 -*-
r"""把浅色背景的动图（webp/gif）逐帧抠成透明，并重新导出带 alpha 的动图。

用法：
    python tools\key_light_anim.py 输入.webp 输出.webp [帧时长ms]
"""
import sys
from collections import deque
from PIL import Image, ImageFilter

THRESH = 16       # 与背景色的距离阈值
HAZE_LUM = 999    # 白色雾霾：亮度阈值
HAZE_SAT = 0.16   # 白色雾霾：饱和度上限
FEATHER = 2.6


def key_frame(rgb):
    w, h = rgb.size
    px = rgb.load()
    samples = []
    for x in range(0, w, 4):
        samples += [px[x, 0], px[x, h - 1]]
    for y in range(0, h, 4):
        samples += [px[0, y], px[w - 1, y]]
    bg = tuple(sorted(s[i] for s in samples)[len(samples) // 2] for i in range(3))

    def is_bg(p):
        return (p[0]-bg[0])**2 + (p[1]-bg[1])**2 + (p[2]-bg[2])**2 <= THRESH*THRESH

    def is_haze(p):
        mx, mn = max(p), min(p)
        sat = 0 if mx == 0 else (mx - mn) / mx
        lum = 0.2126*p[0] + 0.7152*p[1] + 0.0722*p[2]
        return lum >= HAZE_LUM and sat <= HAZE_SAT

    mask = bytearray(w * h)
    q = deque()

    def seed(x, y):
        i = y * w + x
        if not mask[i] and (is_bg(px[x, y]) or is_haze(px[x, y])):
            mask[i] = 1
            q.append(i)

    for x in range(w):
        seed(x, 0); seed(x, h - 1)
    for y in range(h):
        seed(0, y); seed(w - 1, y)

    while q:
        i = q.popleft()
        x, y = i % w, i // w
        for nx, ny in ((x-1, y), (x+1, y), (x, y-1), (x, y+1)):
            if 0 <= nx < w and 0 <= ny < h:
                j = ny * w + nx
                if not mask[j] and (is_bg(px[nx, ny]) or is_haze(px[nx, ny])):
                    mask[j] = 1
                    q.append(j)

    alpha = Image.new("L", (w, h), 255)
    ap = alpha.load()
    for y in range(h):
        row = y * w
        for x in range(w):
            if mask[row + x]:
                ap[x, y] = 0
                continue
            # 外圈的白雾压掉（晶体内核在中心，不动它）
            r, g, b = px[x, y]
            lum = 0.2126*r + 0.7152*g + 0.0722*b
            mx, mn = max(r, g, b), min(r, g, b)
            sat = 0 if mx == 0 else (mx - mn) / mx
            dx = (x - w / 2) / (w / 2)
            dy = (y - h / 2) / (h / 2)
            rad = (dx * dx + dy * dy) ** 0.5
            if lum > 208 and sat < 0.20 and rad > 0.52:
                ap[x, y] = int(ap[x, y] * 0.18)
                continue

    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(FEATHER))

    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def main():
    src = sys.argv[1]
    dst = sys.argv[2]
    dur = int(sys.argv[3]) if len(sys.argv) > 3 else 110

    im = Image.open(src)
    n = getattr(im, "n_frames", 1)
    frames = []
    for i in range(n):
        im.seek(i)
        frames.append(key_frame(im.convert("RGB")))

    # 统一裁切：取所有帧的并集 bbox，避免每帧位置跳动
    boxes = [f.getbbox() for f in frames if f.getbbox()]
    x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
    pad = 4
    x0 = max(0, x0 - pad); y0 = max(0, y0 - pad)
    x1 = min(im.size[0], x1 + pad); y1 = min(im.size[1], y1 + pad)

    size = max(x1 - x0, y1 - y0)
    cropped = []
    for f in frames:
        c = f.crop((x0, y0, x1, y1))
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.paste(c, ((size - c.width) // 2, (size - c.height) // 2))
        cropped.append(canvas)

    out_size = 256
    cropped = [c.resize((out_size, out_size), Image.LANCZOS) for c in cropped]

    cropped[0].save(
        dst, save_all=True, append_images=cropped[1:],
        duration=dur, loop=0, format="WEBP", quality=92, method=6,
    )
    print("saved", dst, len(cropped), "frames", out_size, "px")


if __name__ == "__main__":
    main()







