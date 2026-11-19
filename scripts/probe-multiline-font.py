"""复盘 FD-20261110-121909：两行英文的字体比对为什么塌成 0.82~0.84。

几何事实：第一行墨迹从 x=185 开始，左侧 185px 全空白；整行 OCR 却
给出了 "...When using ..."，那三个点是识别器对空白的幻觉。
本脚本对比若干 (裁剪框, 文本) 组合，看哪种能让正确字体回到第一名。
"""
import json
import os
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "packages", "ocr"))
import worker  # noqa: E402

GEOM = r"C:/Users/6/AppData/Local/FontDeck/recover/geom-1794284302161.png"
IDX = os.path.join(ROOT, "data", "index.json")

FULL1 = [0, 0, 995, 40]
INK1 = [185, 8, 987, 39]
FULL2 = [0, 40, 995, 81]
INK2 = [8, 42, 533, 73]
T1_HALLU = "...When using the steam function, do not place your fingers"
T1 = "When using the steam function, do not place your fingers"
T2 = "on the ridged area of the water tank."


def load_candidates():
    idx = json.load(open(IDX, encoding="utf-8"))
    faces = idx.get("faces") or idx
    out = []
    for f in faces:
        p = f.get("filePath") or ""
        if not p or not os.path.exists(p) or not f.get("postScriptName"):
            continue
        if f.get("health") == "missing-file":
            continue
        out.append({
            "id": f["id"], "path": p,
            "index": int(f.get("collectionIndex") or 0),
            "name": (f.get("familyZh") or f.get("family") or "?") + " " + str(f.get("subfamily") or ""),
        })
    return out


def run(tag, box, text, cands, limit=6):
    targets = [{"box": box, "text": text, "weight": 1.0}]
    scores = {s["id"]: s["score"] for s in worker.compare_line_fonts(GEOM, targets, cands)}
    by_name = {c["id"]: c["name"] for c in cands}
    ranked = sorted(((v, by_name[k]) for k, v in scores.items()), reverse=True)
    top = ranked[:limit]
    gap = (top[0][0] - top[1][0]) if len(top) > 1 else 0
    print("\n=== %s ===" % tag)
    print("  框 %s   文本 %r" % (box, text[:46] + ("..." if len(text) > 46 else "")))
    print("  参比字体 %d，top1=%.4f，与第二名差 %.4f" % (len(scores), top[0][0] if top else 0, gap))
    for s, n in top:
        print("    %-32s %.4f" % (n[:32], s))
    return scores


def main():
    cands = load_candidates()
    print("候选字体", len(cands))

    a = run("A 现状：全宽框 + 带幻觉的 ...", FULL1, T1_HALLU, cands)
    b = run("B 只用紧框，文本仍带幻觉", INK1, T1_HALLU, cands)
    c = run("C 紧框 + 去掉幻觉（推荐）", INK1, T1, cands)
    d = run("D 第二行单独比", INK2, T2, cands)

    # 多行加权：按各行墨迹像素数加权
    w1 = (INK1[2] - INK1[0]) * (INK1[3] - INK1[1])
    w2 = (INK2[2] - INK2[0]) * (INK2[3] - INK2[1])
    merged = {}
    for k in set(c) | set(d):
        merged[k] = (c.get(k, 0) * w1 + d.get(k, 0) * w2) / (w1 + w2)
    by_name = {x["id"]: x["name"] for x in cands}
    ranked = sorted(((v, by_name[k]) for k, v in merged.items()), reverse=True)[:6]
    print("\n=== E 两行按墨迹面积加权（手算） ===")
    for s, n in ranked:
        print("    %-32s %.4f" % (n[:32], s))

    # 与 worker 内置的多目标加权对照，确认服务端走的是同一套算法
    ts = [
        {"box": INK1, "text": T1, "weight": w1},
        {"box": INK2, "text": T2, "weight": w2},
    ]
    builtin = {s["id"]: s["score"] for s in worker.compare_line_fonts(GEOM, ts, cands)}
    ranked2 = sorted(((v, by_name[k]) for k, v in builtin.items()), reverse=True)[:6]
    print("\n=== F worker 多目标加权（服务端实际用这套） ===")
    for s, n in ranked2:
        print("    %-32s %.4f" % (n[:32], s))

    # 顺便估算真实字号：几何图 1pt = 4px
    from PIL import ImageFont
    arial = "C:/Windows/Fonts/arial.ttf"
    if os.path.exists(arial):
        f = ImageFont.truetype(arial, 64)
        bb = f.getbbox(T1)
        w64 = bb[2] - bb[0]
        print("\n=== 字号估算（Arial，1pt=4px）===")
        print("  第一行真实墨迹宽 %dpx = %.1fpt" % (INK1[2] - INK1[0], (INK1[2] - INK1[0]) / 4))
        print("  Arial 64px 渲染同句墨迹宽 %dpx → 反推字号 %.2fpt" % (w64, 16 * (INK1[2] - INK1[0]) / w64))


if __name__ == "__main__":
    main()
