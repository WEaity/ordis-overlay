# -*- coding: utf-8 -*-
"""浅色背景 -> 透明 PNG：先用背景色 flood fill，再把连通的白色雾霾也吃掉。"""
import sys
from collections import deque
from PIL import Image, ImageFilter

SRC = sys.argv[1] if len(sys.argv) > 1 else r"O:\Users\ZYJ\.dsh\attachments\v1\objects\dc\dc1a3a10a4704a8c8385aaf7cc9ef0ef32d9cd27ab1fa6c5ad64da0d9f070e8e"
OUT = sys.argv[2] if len(sys.argv) > 2 else r"E:\warframe_localhost\overlay-demo\ordis-icon.png"

im = Image.open(SRC).convert("RGB")
w, h = im.size
px = im.load()

samples = []
for x in range(0, w, 8):
    samples += [px[x, 0], px[x, h - 1]]
for y in range(0, h, 8):
    samples += [px[0, y], px[w - 1, y]]
bg = tuple(sorted(s[i] for s in samples)[len(samples) // 2] for i in range(3))
print("bg", bg)

THRESH = 34

def is_bg(p):
    return (p[0]-bg[0])**2 + (p[1]-bg[1])**2 + (p[2]-bg[2])**2 <= THRESH*THRESH

def is_haze(p):
    mx, mn = max(p), min(p)
    sat = 0 if mx == 0 else (mx - mn) / mx
    lum = 0.2126*p[0] + 0.7152*p[1] + 0.0722*p[2]
    return lum >= 196 and sat <= 0.16

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

alpha = alpha.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(2.6))

out = Image.new("RGBA", (w, h))
out.paste(im, (0, 0))
out.putalpha(alpha)

bbox = out.getbbox()
pad = 6
out = out.crop((max(0, bbox[0]-pad), max(0, bbox[1]-pad), min(w, bbox[2]+pad), min(h, bbox[3]+pad)))
side = max(out.size)
canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
canvas.paste(out, ((side - out.width)//2, (side - out.height)//2))
canvas = canvas.resize((512, 512), Image.LANCZOS)
canvas.save(OUT)
print("saved", OUT, canvas.size)
