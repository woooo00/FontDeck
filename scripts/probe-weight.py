#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""用「墨迹面积 ÷ 墨迹高度」判定字重。

为什么不用别的：
- 笔画厚度中位数：量化太粗（整数跳变），且两边 rasterizer 不同
  （原稿 fillPoly 描边，候选 PIL 渲染），绝对值不可比。
- 面积 / 高度：对同一段文本，笔画根数基本固定，所以这个值正比于
  「笔画宽 ÷ 字高」——就是字重本身。而且它**不需要对齐**，
  完全绕开「字距误差累积导致 IoU 全掉」这个死结。

要验证的核心问题：这个指标能不能把「细体原稿」和「粗体候选」分开，
同时不把正确答案（历史 5 稿）误伤。

用法：python scripts/probe-weight.py <日志ID> [行号]
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


def weight_metric(mask):
    """面积 / 墨迹高度 = 正比于「笔画宽 ÷ 字高」。"""
    area = float(mask.sum())
    h = float(mask.shape[0])
    return area / h if h else 0.0


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
    sw = weight_metric(src)
    print("原稿第%d行：%d 字符，%dx%d，字重指标 %.2f"
          % (row, len(text), src.shape[1], src.shape[0], sw))
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
        cw = weight_metric(cand)
        if cw <= 0:
            continue
        rows.append({
            "name": (f.get("familyZh") or f.get("family")) + " " + (f.get("subfamily") or ""),
            "ps": f.get("postScriptName"),
            "cw": cw,
            "err": abs(cw - sw) / sw,
        })
    rows.sort(key=lambda x: x["err"])
    print("候选 %d 个；按字重指标误差排序 Top20：" % len(rows))
    for x in rows[:20]:
        mark = "   <== Arial" if x["ps"] == "ArialMT" else ""
        print("   %.2f (误差%.0f%%)  %-32s%s" % (x["cw"], x["err"] * 100, x["name"], mark))
    # 粗体一族的字重指标，用来确认这个指标真的分得开
    print("\n参照：几个已知名体的字重指标")
    for kw in ["Arial Regular", "Arial Bold", "맑은 고딕 Bold", "Open Sans Medium",
               "Noto Sans Light", "思源黑体", "Source Han Sans", "Roboto Light", "HarmonyOS Sans"]:
        for x in [y for y in rows if kw.lower() in y["name"].lower()][:1]:
            print("   %-30s %.2f (误差%.0f%%)" % (x["name"], x["cw"], x["err"] * 100))


if __name__ == "__main__":
    main()
