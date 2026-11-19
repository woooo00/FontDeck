#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""最终验证：单词级 IoU × 字重校正。

要同时解决三件事：
1) 整行密度向量区分度差（所有候选挤在 0.86~0.88）
   → 换成**单词级像素 IoU**，短词字距误差不累积，像素级差异直接体现
2) IoU 系统性偏袒「比原稿更粗」的字体（源墨迹被候选完全包住时
   intersection≈源、union≈候选，粗字体反而占便宜）
   → 乘一个**字重校正因子**：墨迹面积÷归一化字高（正比于「笔画宽÷字高」）
3) 老分粗筛会把正确答案挡在门外
   → 粗筛放宽，并让字重筛选参与粗筛

用法：python scripts/probe-wordmatch.py <日志ID> [每行取前N词]
"""
import importlib.util
import json
import os
import sys

import math

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_spec = importlib.util.spec_from_file_location(
    "pw", os.path.join(ROOT, "scripts", "probe-weighted.py")
)
pw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pw)

TARGET_H = 96
SHIFT = 6


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


def split_words(mask, nwords):
    """按列投影找最大的 (nwords-1) 个空隙，把一行切成 nwords 个词。"""
    if nwords <= 1:
        ys, xs = mask.nonzero()
        return [mask[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1]]
    col = mask.sum(axis=0)
    gaps = []
    run = 0
    for i, v in enumerate(col):
        if v == 0:
            run += 1
        else:
            if run > 0:
                gaps.append((run, i - run))
            run = 0
    if run > 0:
        gaps.append((run, len(col) - run))
    gaps.sort(key=lambda g: -g[0])
    cuts = sorted(g[1] for g in gaps[: nwords - 1])
    bounds = []
    start = 0
    for c in cuts:
        bounds.append((start, c))
        start = c
    bounds.append((start, mask.shape[1]))
    out = []
    for a, b in bounds:
        piece = mask[:, a:b]
        ys, xs = piece.nonzero()
        if len(xs) == 0:
            continue
        out.append(piece[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1])
    return out


def iou_shift(a, b, rng=SHIFT):
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
            v = inter / float(union)
            if v > best:
                best = v
    return best


def weight_metric(mask):
    """面积 ÷ 归一化字高 = 正比于「笔画宽 ÷ 字高」。"""
    return float(mask.sum()) / float(TARGET_H)


def main():
    log_id = sys.argv[1]
    max_words = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    d = json.load(open(os.path.join(ROOT, "data", "feedback", log_id + ".json"), encoding="utf-8"))
    g = d["context"]["geom"]
    r = pw.post("/api/recover/geometry", {
        "shapes": g["shapes"], "w": g["w"], "h": g["h"],
        "scale": g.get("scale", 4), "originX": g.get("originX", 0),
        "originY": g.get("originY", 0), "ptsW": g.get("ptsW", 0),
        "ptsH": g.get("ptsH", 0), "textFrames": g.get("textFrames", 0),
    })
    gray = cv2.imread(r["png"], cv2.IMREAD_GRAYSCALE)

    # ---- 原稿：每行切成词 ----
    src_lines = []
    for L in r["lines"]:
        b = L["box"]
        full = tight_of(gray[b["t"]: b["b"], b["l"]: b["r"]])
        if full is None:
            continue
        words = [w for w in (L["text"] or "").split() if w.strip()]
        if not words:
            continue
        take = min(len(words), max_words)
        pieces = split_words(full, take)
        if len(pieces) != take:
            continue
        src_lines.append({
            "text": L["text"].strip(),
            "words": words[:take],
            "imgs": [fit_height(p) for p in pieces],
            "w": weight_metric(full),
        })
    if not src_lines:
        print("没有可用行")
        return
    print("原稿 %d 行，每行取前 %d 个词" % (len(src_lines), max_words))
    for s in src_lines:
        print("   %-58s 词=%d 字重=%.1f" % (s["text"][:56], len(s["words"]), s["w"]))

    # ---- 候选 ----
    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))["faces"]
    rows = []
    for f in idx:
        if not (f.get("postScriptName") and f.get("health") != "missing-file" and f.get("filePath")):
            continue
        path = f["filePath"]
        cidx = int(f.get("collectionIndex") or 0)
        acc_iou, acc_w, used = 0.0, 0.0, 0.0
        ok = True
        for s in src_lines:
            try:
                line_img = pw.render_line(path, s["text"], cidx)
                cm = tight_of(line_img)
                if cm is None:
                    ok = False
                    break
                cw = weight_metric(cm)
                # 字重校正：偏得越多扣得越狠，但只当修正项（指数衰减）
                werr = abs(cw - s["w"]) / max(1e-6, s["w"])
                wf = math.exp(-8.0 * werr)
                ious = []
                for word, simg in zip(s["words"], s["imgs"]):
                    cimg = pw.render_line(path, word, cidx)
                    ccm = tight_of(cimg)
                    if ccm is None:
                        continue
                    ious.append(iou_shift(simg, fit_height(ccm)))
                if not ious:
                    ok = False
                    break
                wt = max(1.0, len(s["words"]))
                acc_iou += wt * (sum(ious) / len(ious))
                acc_w += wt * wf
                used += wt
            except Exception:
                ok = False
                break
        if not ok or used <= 0:
            continue
        rows.append({
            "name": (f.get("familyZh") or f.get("family")) + " " + (f.get("subfamily") or ""),
            "ps": f.get("postScriptName"),
            "iou": acc_iou / used,
            "wf": acc_w / used,
            "score": (acc_iou / used) * (0.35 + 0.65 * (acc_w / used)),
        })
    rows.sort(key=lambda x: -x["score"])
    print("\n=== 单词 IoU × 字重校正 Top15 ===")
    for x in rows[:15]:
        print("   %.4f (IoU %.4f 字重%.4f)  %-32s" % (x["score"], x["iou"], x["wf"], x["name"]))
    for kw in ("ArialMT",):
        hit = [x for x in rows if x["ps"] == kw]
        if hit:
            print("   -> Arial 第 %d 名，分数 %.4f（第一 %.4f）"
                  % (rows.index(hit[0]) + 1, hit[0]["score"], rows[0]["score"]))
    rows2 = sorted(rows, key=lambda x: -x["iou"])
    print("\n=== 纯单词 IoU Top8（看 IoU 单独的行为）===")
    for x in rows2[:8]:
        print("   %.4f  %-32s" % (x["iou"], x["name"]))


if __name__ == "__main__":
    import math
    main()
