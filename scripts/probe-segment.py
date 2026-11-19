#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""分段 + 等比缩放的 IoU 比对原型。

核心想法：
1. 老分把整行拉到 1024x96（宽高各自拉伸），比例信息全毁 → 所有候选挤成一片。
2. 整行直接比 IoU 也不行：字距差一点点，到行尾就累积成整行错位，分数全掉。
3. 所以：把行切成若干段，每段独立按「保持宽高比、统一缩放到同一字高」处理，
   左对齐后算 IoU，再按段平均。
   - 等比缩放 → 窄体/宽体的差异直接体现（宽的会多出空白，IoU 掉）
   - 分段 → 字距误差不会累积，一段最多错 1~2 个字符的相对位移
   - 段用列投影的空白间隙切，天然对应「词」，不依赖 OCR 文本对齐

用法：python scripts/probe-segment.py <日志ID> [行号]
"""
import importlib.util
import json
import os
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_spec = importlib.util.spec_from_file_location(
    "pw", os.path.join(ROOT, "scripts", "probe-weighted.py")
)
pw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pw)

TARGET_H = 56


def split_segments(mask, max_gap=12):
    """按列投影把一行切成若干段：连续空白超过 max_gap 就断开。"""
    col = mask.sum(axis=0)
    gaps = []
    run = 0
    for i, v in enumerate(col):
        if v == 0:
            run += 1
        else:
            if run >= max_gap:
                gaps.append(i - run)
            run = 0
    if run >= max_gap:
        gaps.append(len(col) - run)
    if not gaps:
        return [(0, mask.shape[1])]
    bounds = []
    start = 0
    for g in gaps:
        bounds.append((start, g))
        start = g
    bounds.append((start, mask.shape[1]))
    return [(a, b) for a, b in bounds if b - a > 1]


def norm_seg(mask):
    """裁出墨迹 → 等比缩放到统一字高 → 左对齐到统一画布宽度（保持比例）。"""
    ys, xs = mask.nonzero()
    if len(xs) == 0:
        return None
    tight = mask[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1]
    h, w = tight.shape
    scale = TARGET_H / float(h)
    nw = max(1, int(round(w * scale)))
    small = cv2.resize(tight.astype(np.float32), (nw, TARGET_H), interpolation=cv2.INTER_AREA)
    return (small > 0.35).astype(np.uint8)


def seg_iou(a, b):
    """两个等高段左对齐后的 IoU；宽度不同不强行拉伸，空白算进并集。"""
    if a is None or b is None:
        return 0.0
    w = max(a.shape[1], b.shape[1])
    ca = np.zeros((TARGET_H, w), dtype=np.uint8)
    cb = np.zeros((TARGET_H, w), dtype=np.uint8)
    ca[:, : a.shape[1]] = a
    cb[:, : b.shape[1]] = b
    inter = int(np.logical_and(ca, cb).sum())
    union = int(np.logical_or(ca, cb).sum())
    return inter / float(union) if union else 0.0


def segs_of(mask):
    return [norm_seg(mask[:, a:b]) for a, b in split_segments(mask)]


def main():
    log_id = sys.argv[1]
    row = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    d = json.load(open(os.path.join(ROOT, "data", "feedback", log_id + ".json"), encoding="utf-8"))
    g = d["context"]["geom"]
    r = pw.post("/api/recover/geometry", {
        "shapes": g["shapes"], "w": g["w"], "h": g["h"],
        "scale": g.get("scale", 4), "originX": g.get("originX", 0),
        "originY": g.get("originY", 0), "ptsW": g.get("ptsW", 0),
        "ptsH": g.get("ptsH", 0), "textFrames": g.get("textFrames", 0),
    })
    gray = cv2.imread(r["png"], cv2.IMREAD_GRAYSCALE)
    L = r["lines"][row - 1]
    b = L["box"]
    src = pw.ink_tight(gray[b["t"]: b["b"], b["l"]: b["r"]])
    src_segs = segs_of(src)
    print("原稿第%d行：%d 字符，切成 %d 段" % (row, len(L["text"]), len(src_segs)))
    print("文字：%s" % L["text"].strip()[:90])

    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))["faces"]
    rows = []
    for f in idx:
        if not (f.get("postScriptName") and f.get("health") != "missing-file" and f.get("filePath")):
            continue
        try:
            img = pw.render_line(f["filePath"], L["text"].strip(), int(f.get("collectionIndex") or 0))
            cm = pw.ink_tight(img)
            if cm is None:
                continue
        except Exception:
            continue
        cs = segs_of(cm)
        n = min(len(src_segs), len(cs))
        if n < 2:
            continue
        scores = [seg_iou(src_segs[i], cs[i]) for i in range(n)]
        rows.append({
            "name": (f.get("familyZh") or f.get("family")) + " " + (f.get("subfamily") or ""),
            "ps": f.get("postScriptName"),
            "score": float(np.mean(scores)),
            "n": n,
        })
    rows.sort(key=lambda x: -x["score"])
    print("候选 %d 个；按分段 IoU 排序 Top15：" % len(rows))
    for x in rows[:15]:
        mark = "   <== Arial" if x["ps"] == "ArialMT" else ""
        print("   %.4f (%d段)  %-32s%s" % (x["score"], x["n"], x["name"], mark))
    ar = [x for x in rows if x["ps"] == "ArialMT"]
    if ar:
        print("\nArial 排名：第 %d 名，分数 %.4f（第一��� %.4f）"
              % (rows.index(ar[0]) + 1, ar[0]["score"], rows[0]["score"]))


if __name__ == "__main__":
    main()
