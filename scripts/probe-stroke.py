#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""量笔画厚度 + 宽高比，筛出「笔画粗细对得上」的字体。

叠图实测发现：原稿是细体，Arial Regular 的笔画明显比原稿粗，
所以真身不是 Arial。字重不对时，光比形状没用，得先把「笔画厚度」
这一维卡住。

笔画厚度：取墨迹里横向连续段的长度分布中位数（横穿竖笔的地方）。
对同一个字号来说，这个值正比于字重。

用法：python scripts/probe-stroke.py <日志ID> [行号]
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


def stroke_width(mask):
    """横向连续墨迹段长度的中位数 = 笔画厚度。"""
    rows = mask.sum(axis=1)
    mid = np.nonzero(rows > 0)[0]
    if len(mid) == 0:
        return 0.0
    # 只取上下 1/3 的行：那里多半是竖笔的主体，不会被上下部件连成一团
    band = mask[mid.min(): mid.max() + 1]
    lens = []
    for r in band:
        run = 0
        for v in r:
            if v:
                run += 1
            elif run:
                lens.append(run)
                run = 0
        if run:
            lens.append(run)
    if not lens:
        return 0.0
    lens.sort()
    return float(lens[len(lens) // 2])


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
    sw = stroke_width(src)
    src_aspect = src.shape[1] / float(src.shape[0])
    print("原稿第%d行：%d 字符，%dx%d，笔画厚 %.2fpx，宽高比 %.3f"
          % (row, len(text), src.shape[1], src.shape[0], sw, src_aspect))
    print("文字：%s" % text[:90])

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
        cw = stroke_width(cand)
        if cw <= 0:
            continue
        rows.append({
            "name": (f.get("familyZh") or f.get("family")) + " " + (f.get("subfamily") or ""),
            "ps": f.get("postScriptName"),
            "cw": cw,
            "aspect": cand.shape[1] / float(cand.shape[0]),
            "err": abs(cw - sw) / sw,
        })
    rows.sort(key=lambda x: x["err"])
    print("候选 %d 个；按笔画厚度误差排序 Top20：" % len(rows))
    for x in rows[:20]:
        mark = "   <== Arial" if x["ps"] == "ArialMT" else ""
        print("   粗细%.2f (误差%.0f%%) 宽高比%.3f  %-30s%s"
              % (x["cw"], x["err"] * 100, x["aspect"], x["name"], mark))
    ar = [x for x in rows if x["ps"] == "ArialMT"]
    if ar:
        print("\nArial：粗细 %.2f（原稿 %.2f），宽高比 %.3f（原稿 %.3f）"
              % (ar[0]["cw"], sw, ar[0]["aspect"], src_aspect))


if __name__ == "__main__":
    main()
