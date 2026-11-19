#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""对照：老特征（宽高各自拉伸）vs 新特征（等比缩放保比例）。

老特征的问题：cv2.resize(tight, (1024, 96)) 把宽和高**各自**拉伸，
窄体和宽体被拉成同一团，字宽信息彻底消失 → 所有候选分数挤在 0.86~0.88。

新特征：先按比例把墨迹缩放到固定字高（宽随比例变），再把宽度**等分**
成 64 段（不是拉伸到固定宽），每段算 12 个高度带的密度。
  - 宽字体每段覆盖的列更多 → 密度分布不同 → 窄/宽分得开
  - 高度归一化 → 字号/导出缩放被消掉
  - 不用精确对齐 → 字距误差不会像 IoU 那样累积

同时输出「字重误差」（墨迹面积 ÷ 归一化字高），它对字重的判别很准。

用法：python scripts/probe-feature.py <日志ID> [行号]
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

LINE_H, COLS, BANDS = 96, 64, 12


def tight_of(gray):
    ink = gray < 128
    ys, xs = ink.nonzero()
    if len(xs) == 0:
        return None
    return ink[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1].astype(np.uint8)


def feat_old(tight):
    small = cv2.resize(tight.astype(np.float32), (1024, LINE_H), interpolation=cv2.INTER_AREA)
    return small.reshape(BANDS, LINE_H // BANDS, COLS, 1024 // COLS).mean(axis=(1, 3)).ravel()


def feat_new(tight):
    h0, w0 = tight.shape
    nw = max(COLS, int(round(w0 * LINE_H / float(h0))))
    small = cv2.resize(tight.astype(np.float32), (nw, LINE_H), interpolation=cv2.INTER_AREA)
    edges = np.linspace(0, nw, COLS + 1).astype(int)
    cols = []
    for i in range(COLS):
        a = edges[i]
        b = max(a + 1, edges[i + 1])
        cols.append(small[:, a:b].mean(axis=1))
    mat = np.stack(cols, axis=1)
    bands = np.array_split(np.arange(LINE_H), BANDS)
    return np.stack([mat[ix, :].mean(axis=0) for ix in bands], axis=0).ravel()


def weight_metric(tight):
    """面积 ÷ 归一化字高 = 正比于「笔画宽 ÷ 字高」（字重本身）。"""
    h0, w0 = tight.shape
    nw = max(COLS, int(round(w0 * LINE_H / float(h0))))
    small = cv2.resize(tight.astype(np.float32), (nw, LINE_H), interpolation=cv2.INTER_AREA)
    return float((small > 0.5).sum()) / float(LINE_H)


def cos(a, b):
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    return float(a @ b / (na * nb)) if na and nb else 0.0


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
    src = tight_of(gray[b["t"]: b["b"], b["l"]: b["r"]])
    text = L["text"].strip()
    so, sn = feat_old(src), feat_new(src)
    sw = weight_metric(src)
    print("原稿第%d行：%d 字符，%dx%d，字重指标 %.2f" % (row, len(text), src.shape[1], src.shape[0], sw))
    print("文字：%s\n" % text[:90])

    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))["faces"]
    rows = []
    for f in idx:
        if not (f.get("postScriptName") and f.get("health") != "missing-file" and f.get("filePath")):
            continue
        try:
            img = pw.render_line(f["filePath"], text, int(f.get("collectionIndex") or 0))
            cm = tight_of(img)
            if cm is None:
                continue
        except Exception:
            continue
        rows.append({
            "name": (f.get("familyZh") or f.get("family")) + " " + (f.get("subfamily") or ""),
            "ps": f.get("postScriptName"),
            "old": cos(so, feat_old(cm)),
            "new": cos(sn, feat_new(cm)),
            "werr": abs(weight_metric(cm) - sw) / sw,
        })

    for key, tag in (("old", "老特征（宽高各自拉伸）"), ("new", "新特征（等比缩放）")):
        rs = sorted(rows, key=lambda x: -x[key])
        print("=== %s Top12 ===" % tag)
        for x in rs[:12]:
            print("   %.4f 字重误差%3.0f%%  %-32s" % (x[key], x["werr"] * 100, x["name"]))
        for kw in ("ArialMT",):
            hit = [x for x in rs if x["ps"] == kw]
            if hit:
                print("   -> Arial 第 %d 名，分数 %.4f（第一 %.4f）"
                      % (rs.index(hit[0]) + 1, hit[0][key], rs[0][key]))
        print()

    print("=== 老分 × 字重修正（0.5 + 0.5×exp(-4×err)）Top12 ===")
    for x in rows:
        x["mix_old"] = x["old"] * (0.5 + 0.5 * np.exp(-4.0 * x["werr"]))
        x["mix_new"] = x["new"] * (0.5 + 0.5 * np.exp(-4.0 * x["werr"]))
    for key, tag in (("mix_old", "老分×字重"), ("mix_new", "新分×字重")):
        rs = sorted(rows, key=lambda x: -x[key])
        print("--- %s ---" % tag)
        for x in rs[:12]:
            print("   %.4f  %-32s" % (x[key], x["name"]))
        hit = [x for x in rs if x["ps"] == "ArialMT"]
        if hit:
            print("   -> Arial 第 %d 名" % (rs.index(hit[0]) + 1))
        print()


if __name__ == "__main__":
    main()
