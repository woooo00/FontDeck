#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""整行「等比缩放 + 左对齐」后的 IoU 比对。

这是叠加图（compare-glyphs.py）用的同一套对齐方式 —— 叠图上 Arial
看起来几乎完全重合，所以这里把它变成可量化的分数。

两种对齐都测：
  left   : 左边缘对齐（叠图用的就是这个）
  center : 水平居中（去掉「起始字符位置不同」的影响）
宽度差多少直接体现在并集里 → 窄体/宽体立刻拉开。

用法：python scripts/probe-lineiou.py <日志ID> [行号]
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

TARGET_H = 96


def fit_height(mask, h=TARGET_H):
    hh, ww = mask.shape
    nw = max(1, int(round(ww * h / hh)))
    return (cv2.resize(mask * 255, (nw, h), interpolation=cv2.INTER_AREA) > 127).astype(np.uint8)


def align_iou(a, b, mode="left"):
    w = max(a.shape[1], b.shape[1]) + 2
    ca = np.zeros((TARGET_H, w), dtype=np.uint8)
    cb = np.zeros((TARGET_H, w), dtype=np.uint8)
    if mode == "left":
        oa, ob = 0, 0
    else:
        oa = (w - a.shape[1]) // 2
        ob = (w - b.shape[1]) // 2
    ca[:, oa: oa + a.shape[1]] = a
    cb[:, ob: ob + b.shape[1]] = b
    inter = int(np.logical_and(ca, cb).sum())
    union = int(np.logical_or(ca, cb).sum())
    return inter / float(union) if union else 0.0


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
    src = fit_height(pw.ink_tight(gray[b["t"]: b["b"], b["l"]: b["r"]]))
    text = L["text"].strip()
    print("原稿第%d行：%d 字符，归一化后 %dx%d" % (row, len(text), src.shape[1], src.shape[0]))

    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))["faces"]
    rows = []
    for f in idx:
        if not (f.get("postScriptName") and f.get("health") != "missing-file" and f.get("filePath")):
            continue
        try:
            img = pw.render_line(f["filePath"], text, int(f.get("collectionIndex") or 0))
            cm = pw.ink_tight(img)
            if cm is None:
                continue
            cand = fit_height(cm)
        except Exception:
            continue
        rows.append({
            "name": (f.get("familyZh") or f.get("family")) + " " + (f.get("subfamily") or ""),
            "ps": f.get("postScriptName"),
            "left": align_iou(src, cand, "left"),
            "center": align_iou(src, cand, "center"),
            "w": cand.shape[1],
        })
    for key, tag in (("left", "左对齐"), ("center", "居中对齐")):
        rs = sorted(rows, key=lambda x: -x[key])
        print("\n=== %s IoU 排序 Top12 ===" % tag)
        for x in rs[:12]:
            mark = "   <== Arial" if x["ps"] == "ArialMT" else ""
            print("   %.4f (宽%4d)  %-32s%s" % (x[key], x["w"], x["name"], mark))
        ar = [x for x in rs if x["ps"] == "ArialMT"]
        if ar:
            print("   -> Arial 第 %d 名，分数 %.4f（第一 %.4f）"
                  % (rs.index(ar[0]) + 1, ar[0][key], rs[0][key]))


if __name__ == "__main__":
    main()
