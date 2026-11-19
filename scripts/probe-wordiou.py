#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""短单词级 IoU 比对实验。

前面的整行 IoU 全都失败，根因是字距误差累积：整行末尾错开几个像素，
整行 IoU 就全掉。分段也不行，因为分段边界在两边不对应。

短单词级是折中：
  - 单词只有 10 来个字符，字距误差最多累积几个像素，IoU 还有区分度
  - 单词由同一个 OCR 文本给出，两边内容确定对应
  - 原稿的单词边界用「列投影找第一个空隙」切出来，不靠猜

用法：python scripts/probe-wordiou.py <日志ID> [行号]
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


def tight_of(gray):
    ink = gray < 128
    ys, xs = ink.nonzero()
    if len(xs) == 0:
        return None
    return ink[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1].astype(np.uint8)


def fit_height(mask, h=TARGET_H):
    hh, ww = mask.shape
    nw = max(1, int(round(ww * h / hh)))
    return (cv2.resize(mask * 255, (nw, h), interpolation=cv2.INTER_AREA) > 127).astype(np.uint8)


def first_word(mask, min_gap):
    """列投影找第一个宽度 >= min_gap 的空隙，右边就是第一个词的结束。

    切完之后要**重新收紧上下边界**：切出来的高度还是整行高（含 descender），
    而候选渲染出的同一个词是紧致高度，两边按各自的墨迹框缩放到同一高，
    x-height 的位置就错开了，IoU 直接崩。
    """
    col = mask.sum(axis=0)
    run = 0
    for i, v in enumerate(col):
        if v == 0:
            run += 1
            if run >= min_gap:
                piece = mask[:, : i - run + 1]
                ys, xs = piece.nonzero()
                if len(xs) == 0:
                    return None
                return piece[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1]
        else:
            run = 0
    return mask


def left_iou(a, b):
    w = max(a.shape[1], b.shape[1]) + 2
    ca = np.zeros((TARGET_H, w), dtype=np.uint8)
    cb = np.zeros((TARGET_H, w), dtype=np.uint8)
    ca[:, : a.shape[1]] = a
    cb[:, : b.shape[1]] = b
    inter = int(np.logical_and(ca, cb).sum())
    union = int(np.logical_or(ca, cb).sum())
    return inter / float(union) if union else 0.0


def best_shift_iou(a, b, rng=6):
    """允许水平微调 ±rng 像素，取最优（消除起始位置的亚像素偏差）。"""
    best = 0.0
    for dx in range(-rng, rng + 1):
        w = max(a.shape[1], b.shape[1] + abs(dx)) + 4
        ca = np.zeros((TARGET_H, w), dtype=np.uint8)
        cb = np.zeros((TARGET_H, w), dtype=np.uint8)
        ca[:, 2: 2 + a.shape[1]] = a
        off = 2 + dx
        if off >= 0:
            cb[:, off: off + b.shape[1]] = b
        else:
            cb[:, : b.shape[1] + off] = b[:, -off:]
        inter = int(np.logical_and(ca, cb).sum())
        union = int(np.logical_or(ca, cb).sum())
        if union:
            best = max(best, inter / float(union))
    return best


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
    full = tight_of(gray[b["t"]: b["b"], b["l"]: b["r"]])
    word = first_word(full, 14)
    if word is None:
        print("没切出第一个词")
        return
    src = fit_height(word)
    text = L["text"].strip()
    first = text.split()[0]
    print("原稿第%d行第一个词：%r  裁切 %dx%d → 归一化 %dx%d"
          % (row, first, word.shape[1], word.shape[0], src.shape[1], src.shape[0]))

    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))["faces"]
    rows = []
    for f in idx:
        if not (f.get("postScriptName") and f.get("health") != "missing-file" and f.get("filePath")):
            continue
        try:
            img = pw.render_line(f["filePath"], first, int(f.get("collectionIndex") or 0))
            cm = tight_of(img)
            if cm is None:
                continue
            cand = fit_height(cm)
        except Exception:
            continue
        rows.append({
            "name": (f.get("familyZh") or f.get("family")) + " " + (f.get("subfamily") or ""),
            "ps": f.get("postScriptName"),
            "iou": left_iou(src, cand),
            "shi": best_shift_iou(src, cand),
            "w": cand.shape[1],
        })
    for key, tag in (("iou", "单词 IoU（固定左对齐）"), ("shi", "单词 IoU（±6px 微调）")):
        rs = sorted(rows, key=lambda x: -x[key])
        print("\n=== %s Top15 ===" % tag)
        for x in rs[:15]:
            mark = "   <== Arial" if x["ps"] == "ArialMT" else ""
            print("   %.4f (宽%4d)  %-32s%s" % (x[key], x["w"], x["name"], mark))
        hit = [x for x in rs if x["ps"] == "ArialMT"]
        if hit:
            print("   -> Arial 第 %d 名，分数 %.4f（第一 %.4f）"
                  % (rs.index(hit[0]) + 1, hit[0][key], rs[0][key]))


if __name__ == "__main__":
    main()
