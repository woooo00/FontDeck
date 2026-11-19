"""探针：行内「字重剖面」能否定位样式切换点（本案例是 Bold↔Light）。

背景：FD-20261117-142243 那行是 `• WARNING:(粗) Do not use ...(常规)`，
整行单字重渲染 → 最高分只有 0.48，面板推荐了 Gabriola（装饰体，完全不对）。
但把行切成两段后，正文段单段就有 0.9434（HarmonyOS Sans Light）。

现在验证：不用「分数试切」，靠每字符的 stroke_weight（墨迹面积/字高²）
剖面能不能直接找到切换点。若同一样式稿的剖面是平的、混合稿有明显台阶，
这个信号就可用；否则如实放弃。
"""
import json
import os
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "packages", "ocr"))

import worker  # noqa: E402


def unit_profile(gray_crop):
    """按垂直投影切字符块，返回 [(l, r, w, stroke_weight, ink_h)]。"""
    mask = (gray_crop < 128).astype(np.uint8)
    out = []
    for l, r in worker.split_units(mask):
        sub = mask[:, l:r]
        rows = np.flatnonzero(sub.sum(axis=1) > 0)
        if rows.size == 0:
            continue
        sub = sub[rows.min(): rows.max() + 1]
        if sub.shape[0] < 4:
            continue
        out.append((l, r, r - l, float(worker.stroke_weight(sub)), int(sub.shape[0])))
    return out


def show(name, gray, box):
    crop = gray[box[1]:box[3], box[0]:box[2]]
    prof = unit_profile(crop)
    if not prof:
        print("%-22s 空" % name)
        return
    print("\n%-22s 单元 %d" % (name, len(prof)))
    ws = [p[3] for p in prof]
    print("  字重 min/med/max = %.3f / %.3f / %.3f   max/min = %.2f"
          % (min(ws), float(np.median(ws)), max(ws), max(ws) / max(1e-6, min(ws))))
    # 相邻差分：找最大台阶
    steps = []
    for i in range(1, len(prof)):
        a, b = prof[i - 1][3], prof[i][3]
        steps.append((abs(b - a) / max(1e-6, min(a, b)), i, prof[i][0]))
    steps.sort(reverse=True)
    print("  最大三处台阶（相对变化 / 第几单元 / 像素 x）：")
    for s in steps[:3]:
        print("    %.2f  单元%2d  x=%d" % s)
    # 剖面（前 40 个）
    print("  剖面：" + " ".join("%.2f" % w for w in ws[:40]))


def main():
    cases = []

    d = json.load(open(os.path.join(ROOT, "data", "feedback", "FD-20261117-142243.json"), encoding="utf-8"))
    rec = d["context"]["recognize"]
    ln = rec["lines"][0]
    cases.append(("2026-11-17 混合字重", rec["png"], [ln["box"]["l"], ln["box"]["t"], ln["box"]["r"], ln["box"]["b"]]))

    # 对照组：确认是单一样式的稿子（之前实测结论里用过的）
    for logid, li in [("FD-20261111-091907", 0), ("FD-20261111-114755", 0), ("FD-20261110-145847", 0)]:
        p = os.path.join(ROOT, "data", "feedback", logid + ".json")
        if not os.path.exists(p):
            continue
        dd = json.load(open(p, encoding="utf-8"))
        rr = dd["context"]["recognize"]
        lines = rr.get("lines") or []
        if li >= len(lines):
            continue
        b = lines[li]["box"]
        png = rr.get("png") or ""
        if not os.path.exists(png):
            continue
        cases.append((logid[-6:] + " 单一", png, [b["l"], b["t"], b["r"], b["b"]]))

    for name, png, box in cases:
        g = cv2.imread(png, cv2.IMREAD_GRAYSCALE)
        show(name, g, box)


if __name__ == "__main__":
    main()
