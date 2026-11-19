"""纯探针：行内样式分段的几何信号强度评估。

候选信号（全部逐列，分辨率高于字框）：
  上缘包络  滑动最小 ink_top      → 字号变大 / 上移
  下缘包络  滑动最大 ink_bottom   → 基线变化 / 字号变大
  填充率    逐列 墨迹像素/竖直跨度 → 字重变化
判据：把包络按 0.5 行高取样，看相邻取样中位数的最大差（以行高归一）。

单一样式稿必须 < 0.15；人为混合稿应明显更大，否则这个信号不可用。
"""
import glob
import json
import os

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def profiles(gray, win):
    ink = gray < 128
    H, W = ink.shape
    win = max(9, int(win))
    tops = np.full(W, np.nan)
    bots = np.full(W, np.nan)
    fill = np.full(W, np.nan)
    for x in range(W):
        ys = np.nonzero(ink[:, x])[0]
        if len(ys):
            tops[x] = ys[0]
            bots[x] = ys[-1]
            fill[x] = len(ys) / float(max(1, ys[-1] - ys[0] + 1))
    half = win // 2
    out = []
    for arr, agg in ((tops, np.min), (bots, np.max), (fill, np.mean)):
        s = np.full(W, np.nan)
        for i in range(W):
            a = max(0, i - half)
            b = min(W, i + half + 1)
            v = arr[a:b]
            v = v[np.isfinite(v)]
            if len(v):
                s[i] = agg(v)
        out.append(s)
    return out, H


def max_jump(s, H):
    v = s[np.isfinite(s)]
    if len(v) < 6:
        return 0.0
    step = max(2, int(H * 0.5))
    pts = [float(np.median(v[i: i + step])) for i in range(0, len(v) - step, step)]
    if len(pts) < 2:
        return 0.0
    return max(abs(pts[i] - pts[i - 1]) for i in range(1, len(pts))) / float(H)


def report(gray, tag):
    (t, b, f), H = profiles(gray, gray.shape[0] * 1.5)
    print("  %-30s 上缘 %.2f  下缘 %.2f  填充率 %.2f"
          % (tag, max_jump(t, H), max_jump(b, H), max_jump(f, H)))


def face(kw):
    faces = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))["faces"]
    for f in faces:
        nm = ((f.get("familyZh") or f.get("family")) + " " + (f.get("subfamily") or ""))
        if kw.lower() in nm.lower():
            return f
    return None


def sample_image(parts, w, h):
    im = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(im)
    for x, y, text, f, px in parts:
        d.text((x, y), text,
               font=ImageFont.truetype(f["filePath"], px, index=int(f.get("collectionIndex") or 0)),
               fill=0)
    return np.array(im)


def main():
    print("=== 真实单一样式稿（应 < 0.15）===")
    for p in sorted(glob.glob(os.path.join(ROOT, "data", "feedback", "FD-2026*.json")))[-6:]:
        d = json.load(open(p, encoding="utf-8"))
        r = d["context"].get("recognize", {})
        png = r.get("png") or ""
        if not os.path.exists(png):
            continue
        g = cv2.imread(png, cv2.IMREAD_GRAYSCALE)
        for i, l in enumerate((r.get("lines") or [])[:2]):
            bx = l["box"]
            crop = g[bx["t"]: bx["b"], bx["l"]: bx["r"]]
            report(crop, "%s 行%d" % (os.path.basename(p)[-11:-5], i + 1))

    print("=== 人为混合稿（应 > 0.30）===")
    a = face("Arial Regular")
    bb = face("Arial Bold")
    c = face("Times New Roman Bold")
    if not (a and bb and c):
        print("  缺字体，跳过"); return
    report(sample_image([(20, 50, "Weight:", a, 64), (300, 50, "BOLD", bb, 64)], 1200, 180),
           "Regular→Bold 同字号")
    report(sample_image([(20, 80, "Small", a, 44), (240, 20, "BIG", a, 110)], 1200, 180),
           "44px→110px 同字体")
    report(sample_image([(20, 50, "Sans:", a, 64), (250, 50, "Serif Bold", c, 64)], 1300, 180),
           "Sans→Serif Bold")
    report(sample_image([(20, 90, "Sub", a, 44), (150, 30, "TOP", a, 44)], 900, 180),
           "同字号不同基线")


if __name__ == "__main__":
    main()
