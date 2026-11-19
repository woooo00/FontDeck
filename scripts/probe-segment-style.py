"""纯探针：行内样式分段（render-and-compare）。

思路：用匹配到的字体把整行文本渲染出来，与原稿逐列比对 IoU。
同一段样式内匹配度高；换字体/字重/字号的地方会出现**连续低分区**，
那就是切点。不做像素级全局对齐（字距会累积漂移），改在局部窗口内
做水平搜索，抗漂移。

两个场景：
  A. 真实单一样式稿 → 期望「1 段」（不能误切）
  B. 人为拼接的混合稿 → 期望「2 段」
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def ink_tight(gray):
    ink = gray < 128
    ys, xs = np.nonzero(ink)
    if len(xs) == 0:
        return None
    return ink[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1].astype(np.uint8)


def norm_h(mask, h):
    w = max(1, int(round(mask.shape[1] * h / float(mask.shape[0]))))
    im = Image.fromarray((mask * 255).astype(np.uint8)).resize((w, h), Image.LANCZOS)
    return (np.array(im) > 127).astype(np.uint8)


def render(font_path, text, index=0, px=96):
    f = ImageFont.truetype(font_path, px, index=index) if False else None
    from PIL import ImageFont, ImageDraw
    f = ImageFont.truetype(font_path, px, index=index)
    bb = f.getbbox(text)
    im = Image.new("L", (int(bb[2] - bb[0] + 16), int(bb[3] - bb[1] + 16)), 255)
    ImageDraw.Draw(im).text((8 - bb[0], 8 - bb[1]), text, font=f, fill=0)
    return np.array(im)


def col_curve(src, cand, win=24, search=14):
    """逐列匹配度：每个窗口在 ±search 内找最佳水平位置，抗字距漂移。"""
    out = []
    W = src.shape[1]
    for x in range(0, W, win):
        a = src[:, x: x + win]
        n = a.shape[1]
        if a.sum() == 0:
            out.append((x, None))
            continue
        best = 0.0
        for dx in range(-search, search + 1):
            x0 = x + dx
            b = cand[:, max(0, x0): x0 + n]
            if b.shape[1] < n:
                b = np.pad(b, ((0, 0), (0, n - b.shape[1])))
            inter = np.logical_and(a, b).sum()
            uni = np.logical_or(a, b).sum()
            if uni > 0:
                best = max(best, inter / float(uni))
        out.append((x, best))
    return out


def segments(curve, win=24, thr=0.45, min_run=2):
    """连续低分区 → 段边界。返回 [(x_start, x_end), ...]"""
    bad = [(x, s) for x, s in curve if s is not None and s < thr]
    if not bad:
        return []
    runs, cur = [], [bad[0][0]]
    for (x, s), (px, ps) in zip(bad[1:], bad[:-1]):
        if x - px > win * 1.5:
            runs.append(cur); cur = [x]
        else:
            cur.append(x)
    runs.append(cur)
    return [(r[0], r[-1] + win) for r in runs if len(r) >= min_run]


def analyse(gray, text, font_path, index=0, tag=""):
    src = ink_tight(gray)
    if src is None:
        print("  %s: 空图" % tag); return
    cand = ink_tight(render(font_path, text, index))
    if cand is None:
        print("  %s: 渲染失败" % tag); return
    cand = norm_h(cand, src.shape[0])
    curve = col_curve(src, cand)
    segs = segments(curve)
    vals = [s for _, s in curve if s is not None]
    print("  %-28s 行宽%4d 窗口%2d 匹配中位 %.3f 最低 %.3f  低分区间 %d 个 %s"
          % (tag, src.shape[1], len(curve),
             float(np.median(vals)) if vals else 0,
             min(vals) if vals else 0,
             len(segs), segs[:4]))
    return segs


def face(kw):
    faces = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))["faces"]
    for f in faces:
        nm = ((f.get("familyZh") or f.get("family")) + " " + (f.get("subfamily") or ""))
        if kw.lower() in nm.lower():
            return f
    return None


def scenario_mixed():
    """构造：左半 Arial Regular 48px，右半 Arial Bold 48px + 字号放大。"""
    from PIL import ImageDraw, ImageFont
    a = face("Arial Regular")
    b = face("Arial Bold")
    if not a or not b:
        print("  缺 Arial，跳过"); return
    W, H = 1400, 200
    im = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(im)
    d.text((20, 70), "Weight:", font=ImageFont.truetype(a["filePath"], 56, index=int(a.get("collectionIndex") or 0)), fill=0)
    d.text((300, 40), "BOLD MIXED", font=ImageFont.truetype(b["filePath"], 96, index=int(b.get("collectionIndex") or 0)), fill=0)
    im.save(os.path.join(ROOT, "data", "_analysis", "seg-mixed.png"))
    print("  已生成 data/_analysis/seg-mixed.png，用 Arial Regular 当作「唯一候选」去比：")
    analyse(np.array(im), "Weight: BOLD MIXED", a["filePath"], int(a.get("collectionIndex") or 0), "混合稿(用Regular比)")


def main():
    os.makedirs(os.path.join(ROOT, "data", "_analysis"), exist_ok=True)

    print("=== A. 真实单一样式稿（必须 0 段 / 不切）===")
    cases = [
        ("FD-20261111-091907", 0, "Open Sans Medium"),
        ("FD-20261111-091907", 2, "Open Sans Medium"),
        ("FD-20261111-114755", 0, "DM Sans 9pt Regular"),
        ("FD-20261110-145847", 0, "HarmonyOS Sans Regular"),
    ]
    for logid, li, kw in cases:
        p = os.path.join(ROOT, "data", "feedback", logid + ".json")
        d = json.load(open(p, encoding="utf-8"))
        rec = d["context"]["recognize"]
        lines = rec.get("lines") or []
        if li >= len(lines):
            continue
        png = rec.get("png") or ""
        if not os.path.exists(png):
            print("  渲染图不在，跳过 %s" % logid); continue
        gray = cv2.imread(png, cv2.IMREAD_GRAYSCALE)
        box = lines[li]["box"]
        crop = gray[box["t"]: box["b"], box["l"]: box["r"]]
        f = face(kw)
        if not f:
            print("  缺字体 %s" % kw); continue
        analyse(crop, lines[li]["text"], f["filePath"],
                int(f.get("collectionIndex") or 0), "%s 行%d" % (logid[-6:], li + 1))

    print("\n=== B. 人为混合稿（期望切出边界）===")
    scenario_mixed()


if __name__ == "__main__":
    main()
