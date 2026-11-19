#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""量「整行墨迹宽高比」这个特征能不能把真身单独挑出来。

背景：老分把整行拉到 1024x96（宽高各自拉伸），字体的窄/宽信息直接被
抹平，所以所有候选的余弦分都挤在 0.86~0.88，Top1 和 Top12 差不到 0.03。

这里换一条路：不归一化，直接量「渲染出来的整行墨迹宽 / 墨迹高」。
窄体窄、宽体宽，这个比值对字体非常敏感，而且不受字号影响。

复用 probe-weighted.py 里已经验证过的 render_line / ink_tight。

用法：python scripts/probe-lineratio.py <日志ID> [行号]
"""
import importlib.util
import json
import os
import sys

import cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_spec = importlib.util.spec_from_file_location(
    "pw", os.path.join(ROOT, "scripts", "probe-weighted.py")
)
pw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pw)


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
    sw, sh = src.shape[1], src.shape[0]
    src_ratio = sw / float(sh)
    print("原稿第%d行：%d 字符，墨迹 %dx%d，宽高比 %.4f" % (row, len(L["text"]), sw, sh, src_ratio))
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
        w, h = cm.shape[1], cm.shape[0]
        ratio = w / float(h)
        rows.append({
            "name": (f.get("familyZh") or f.get("family")) + " " + (f.get("subfamily") or ""),
            "ps": f.get("postScriptName"),
            "ratio": ratio,
            "err": abs(ratio - src_ratio),
        })
    rows.sort(key=lambda x: x["err"])
    print("候选 %d 个；按宽高比误差排序 Top15：" % len(rows))
    for x in rows[:15]:
        mark = "   <== Arial" if x["ps"] == "ArialMT" else ""
        print("   %.4f (误差 %.4f)  %-32s %s" % (x["ratio"], x["err"], x["name"], mark))
    ar = [x for x in rows if x["ps"] == "ArialMT"]
    if ar:
        print("\nArial 排名：第 %d 名，宽高比 %.4f（原稿 %.4f）"
              % (rows.index(ar[0]) + 1, ar[0]["ratio"], src_ratio))


if __name__ == "__main__":
    main()
