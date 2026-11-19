"""
把原稿某一行和若干候选字体的渲染结果叠在一起，用眼睛判谁像。

这是「字体不对」类问题最直接的排查手段：分数只能给线索，
字形对不对得看叠加图 —— 原稿黑、候选红描边，能看出笔画粗细、
字宽、倾斜、衬线是否一致。

用法：python scripts/compare-glyphs.py <日志ID> <行号1,行号2> <倍率> [字体名...]
"""
import json
import os
import sys
import urllib.request

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = os.environ.get("FONTDECK_API", "http://127.0.0.1:47615")
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
OUT = os.path.join(ROOT, "data", "_analysis")
LINE_H = 96
PAD = 16


def post(path, data, timeout=600):
    q = urllib.request.Request(
        API + path,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with OPENER.open(q, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def scale_shapes(shapes, k):
    out = []
    for s in shapes:
        segs = []
        for flat in s.get("p") or []:
            nf = []
            for i in range(0, len(flat), 2):
                nf.extend([flat[i] * k, flat[i + 1] * k])
            segs.append(nf)
        out.append({"c": s.get("c", 1), "p": segs})
    return out


def ink_tight(gray):
    ink = (gray < 128).astype(np.uint8)
    ys, xs = ink.nonzero()
    if len(xs) == 0:
        return None
    return ink[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1]


def fit_height(mask, h=LINE_H):
    hh, ww = mask.shape
    nw = max(1, int(round(ww * h / hh)))
    return cv2.resize(mask * 255, (nw, h), interpolation=cv2.INTER_AREA) > 127


def render_line(path, text, index=0):
    try:
        f = ImageFont.truetype(path, 64, index=index)
    except Exception:
        return None
    bb = f.getbbox(text)
    if bb is None:
        return None
    w, h = int(bb[2] - bb[0] + 24), int(bb[3] - bb[1] + 24)
    if w <= 0 or h <= 0:
        return None
    im = Image.new("L", (w, h), 255)
    ImageDraw.Draw(im).text((12 - bb[0], 12 - bb[1]), text, font=f, fill=0)
    return np.array(im)


def overlay(src, cand, width):
    """黑 = 原稿，红 = 候选"""
    h = LINE_H
    a = np.zeros((h, width), dtype=bool)
    b = np.zeros((h, width), dtype=bool)
    a[:, : min(width, src.shape[1])] = src[:, : min(width, src.shape[1])]
    b[:, : min(width, cand.shape[1])] = cand[:, : min(width, cand.shape[1])]
    rgb = np.full((h, width, 3), 255, dtype=np.uint8)
    rgb[a] = (20, 20, 20)
    both = np.logical_and(a, b)
    only = np.logical_and(b, np.logical_not(a))
    rgb[both] = (30, 30, 30)
    rgb[only] = (220, 40, 40)
    return rgb


def main():
    log_id = sys.argv[1]
    rows = [int(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 else [1]
    k = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    wanted = sys.argv[4:]

    d = json.load(open(os.path.join(ROOT, "data", "feedback", "%s.json" % log_id), encoding="utf-8"))
    g = d["context"]["geom"]
    # 服务端现在会按画布面积自适应放大渲染（RS），这里不再自己放大，
    # 保证对比图用的就是用户实际会看到的那张图。
    r = post("/api/recover/geometry", {
        "shapes": g["shapes"],
        "w": g["w"], "h": g["h"],
        "scale": g.get("scale", 4), "originX": g.get("originX", 0),
        "originY": g.get("originY", 0), "ptsW": g.get("ptsW", 0),
        "ptsH": g.get("ptsH", 0), "textFrames": g.get("textFrames", 0),
    })
    gray = cv2.imread(r["png"], cv2.IMREAD_GRAYSCALE)
    lines = r["lines"]

    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))
    faces = idx["faces"]
    picked = []
    for kw in wanted:
        hits = 0
        for f in faces:
            name = ("%s %s" % (f.get("familyZh") or f.get("family"), f.get("subfamily") or "")).strip()
            if kw.lower() in name.lower() and not any(p[1] == name for p in picked):
                picked.append((f, name))
                hits += 1
                if hits >= 2:      # 每个关键词最多取 2 个，避免图太长
                    break
    if not picked:
        print("没有匹配到字体：%s" % wanted)
        return 1

    os.makedirs(OUT, exist_ok=True)
    # OCR 常有错字，比对字体时要用用户粘贴的原文才准。
    # FONTDECK_TRUTH_TEXT 提供时覆盖该行识别文本（仅用于叠图排查）。
    truth = os.environ.get("FONTDECK_TRUTH_TEXT", "").strip()
    for row in rows:
        li = row - 1
        if li >= len(lines):
            continue
        b = lines[li]["box"]
        crop = gray[b["t"]: b["b"], b["l"]: b["r"]]
        src = fit_height(ink_tight(crop))
        text = truth or lines[li]["text"]
        width = max(src.shape[1], max(
            fit_height(ink_tight(render_line(f["filePath"], text, int(f.get("collectionIndex") or 0)))).shape[1]
            for f, _ in picked if render_line(f["filePath"], text, int(f.get("collectionIndex") or 0)) is not None
        )) + 4

        blocks = [("原稿（转曲）", src)]
        for f, name in picked:
            img = render_line(f["filePath"], text, int(f.get("collectionIndex") or 0))
            if img is None:
                continue
            blocks.append((name, fit_height(ink_tight(img))))

        label_w = 260
        img_h = len(blocks) * (LINE_H + PAD) + PAD
        canvas = Image.new("RGB", (label_w + width + PAD, img_h), (255, 255, 255))
        draw = ImageDraw.Draw(canvas)
        try:
            lf = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 15)
        except Exception:
            lf = ImageFont.load_default()
        y = PAD
        for name, mask in blocks:
            ov = overlay(src, mask, width)
            canvas.paste(Image.fromarray(ov), (label_w, y))
            draw.text((8, y + LINE_H // 2 - 9), name, fill=(20, 20, 20), font=lf)
            draw.line([(label_w, y + LINE_H + PAD // 2), (label_w + width, y + LINE_H + PAD // 2)],
                      fill=(225, 225, 230))
            y += LINE_H + PAD
        out = os.path.join(OUT, "glyph-%s-row%d.png" % (log_id, row))
        canvas.save(out)
        print("已生成", out, "（%d 组）" % len(blocks))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
