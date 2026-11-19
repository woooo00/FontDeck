"""探针（2026-11-17 日志 FD-20261117-142243）：为什么整行字体分只有 0.48。

该稿实际内容：`• WARNING: Do not use this appliance near bathtubs,`
左边 WARNING: 是**粗体**，右边正文是**常规体** —— 一行两种字重。
整行只按一个字重渲染 → 一半字形对不上，分数被压到 0.48。

本探针验证三件事（全部实测，不猜）：
  A. 复现：整行文本 + 整行框，看最高分是否约 0.48
  B. 分段：按 WARNING: 后的空白切开，两段各自比对，看分数是否明显回升
  C. 行首 ・ 符号：OCR 把它读成 "-"，是否也在污染比对文本
"""
import json
import os
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "packages", "ocr"))

import worker  # noqa: E402


def load_pool():
    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))
    out = []
    seen = set()
    for f in idx["faces"]:
        ps = (f.get("postScriptName") or "").strip()
        if not ps or ps.lower() in seen:
            continue
        if f.get("health") == "missing-file" or not f.get("filePath"):
            continue
        seen.add(ps.lower())
        out.append({
            "id": f["id"],
            "path": f["filePath"],
            "index": int(f.get("collectionIndex") or 0),
        })
    return out, idx["faces"]


def top(scores, faces, n=6):
    byid = {f["id"]: f for f in faces}
    rows = []
    for s in scores[:n]:
        f = byid.get(s["id"], {})
        nm = ((f.get("familyZh") or f.get("family") or "?") + " " + (f.get("subfamily") or "")).strip()
        rows.append("    %-34s %.4f" % (nm[:34], s["score"]))
    return "\n".join(rows) if rows else "    （无）"


def gaps(gray_crop, min_run=6):
    ink = (gray_crop < 128).sum(axis=0)
    runs, start = [], None
    for x, v in enumerate(ink):
        if v == 0:
            if start is None:
                start = x
        else:
            if start is not None:
                if x - start >= min_run:
                    runs.append((start, x - 1, x - start))
                start = None
    if start is not None and len(ink) - start >= min_run:
        runs.append((start, len(ink) - 1, len(ink) - start))
    return runs


def main():
    logid = sys.argv[1] if len(sys.argv) > 1 else "FD-20261117-142243"
    p = os.path.join(ROOT, "data", "feedback", logid + ".json")
    d = json.load(open(p, encoding="utf-8"))
    rec = d["context"]["recognize"]
    png = rec["png"]
    ln = rec["lines"][0]
    box = ln["box"]
    text = ln["text"]
    print("图：%s" % png)
    print("行文本：%r  行框：%s" % (text, box))

    gray = cv2.imread(png, cv2.IMREAD_GRAYSCALE)
    print("画布：%dx%d" % (gray.shape[1], gray.shape[0]))

    crop = gray[box["t"]:box["b"], box["l"]:box["r"]]
    gs = gaps(crop)
    print("\n全零空白列（>=6px）：%s" % (gs[:10],))
    if gs:
        widest = max(gs, key=lambda r: r[2])
        print("最宽空白：x=%d..%d 宽 %d  （占行宽 %.0f%%）"
              % (widest[0], widest[1], widest[2], 100.0 * widest[0] / crop.shape[1]))

    pool, faces = load_pool()
    print("候选 %d 个\n" % len(pool))

    print("=== A. 整行单一样式（复现用户看到的结果）===")
    a = worker.compare_line_fonts(png, [{"box": [box["l"], box["t"], box["r"], box["b"]],
                                        "text": text, "weight": 1.0}], pool)
    print(top(a, faces, 6))

    # 把「WARNING:」后面那条最宽空白当切点
    cut = None
    if gs:
        widest = max(gs, key=lambda r: r[2])
        if 0.15 * crop.shape[1] < widest[0] < 0.6 * crop.shape[1]:
            cut = widest[0] + widest[2] // 2
    if cut is None:
        cut = int(crop.shape[1] * 0.36)
    left_r = box["l"] + cut
    print("\n切点 x=%d（行内 %d px，占 %.0f%%）" % (left_r, cut, 100.0 * cut / crop.shape[1]))

    print("\n=== B1. 左段（粗体 WARNING:）===")
    b1 = worker.compare_line_fonts(
        png, [{"box": [box["l"], box["t"], left_r, box["b"]],
               "text": "WARNING:", "weight": 1.0}], pool)
    print(top(b1, faces, 6))

    print("\n=== B2. 右段（常规正文）===")
    b2 = worker.compare_line_fonts(
        png, [{"box": [left_r, box["t"], box["r"], box["b"]],
               "text": "Do not use this appliance near bathtubs,", "weight": 1.0}], pool)
    print(top(b2, faces, 6))

    print("\n=== C. 行首符号对比对文本的影响（整行，去掉 '-' 保留框）===")
    c = worker.compare_line_fonts(
        png, [{"box": [box["l"], box["t"], box["r"], box["b"]],
               "text": text.replace("-", "", 1), "weight": 1.0}], pool)
    print(top(c, faces, 6))

    print("\n=== D. 右段再细分：只看正文前 4 个词（样本更短更纯）===")
    d1 = worker.compare_line_fonts(
        png, [{"box": [left_r, box["t"], box["r"], box["b"]],
               "text": "Do not use this", "weight": 1.0}], pool)
    print(top(d1, faces, 6))


if __name__ == "__main__":
    main()
