"""验证「整行渲染比对」能不能把原稿字体排到第一。

几何图是转曲后的真实轮廓；用候选字体把 OCR 认出的整句渲染一遍，
两边都按墨迹包围盒归一化到同一尺寸，再比 64x12 分块密度向量。
整行形状里包含字母宽度分布、词间距、笔画粗细，区分度远高于单字。
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEXT = "3. Fold the cord in the same way as it was first delivered in its packaging."
GEOM = r"C:/Users/6/AppData/Local/FontDeck/recover/geom-1794280920299.png"
W, H = 1024, 96


def feature(gray):
    ink = gray < 128
    ys, xs = ink.nonzero()
    if len(xs) == 0:
        return None
    tight = ink[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1].astype(np.float32)
    small = cv2.resize(tight, (W, H), interpolation=cv2.INTER_AREA)
    return small.reshape(12, H // 12, 64, W // 64).mean(axis=(1, 3)).ravel()


def render(path, text, index=0):
    f = ImageFont.truetype(path, 64, index=index)
    bb = f.getbbox(text)
    w, h = int(bb[2] - bb[0] + 24), int(bb[3] - bb[1] + 24)
    im = Image.new("L", (w, h), 255)
    ImageDraw.Draw(im).text((12 - bb[0], 12 - bb[1]), text, font=f, fill=0)
    return np.array(im)


def cos(a, b):
    return float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def main():
    g = cv2.imread(GEOM, cv2.IMREAD_GRAYSCALE)
    target = feature(g)
    print("几何图", g.shape, "特征维度", len(target))

    idx = json.load(open(os.path.join(ROOT, "data/index.json"), encoding="utf-8"))
    faces = idx.get("faces") or idx

    want = ["MiSans-Regular", "MiSans-Medium", "MiSans-Normal", "MiSans-Light",
            "Gilroy-Regular", "Gilroy_Regular", "ArialMT", "Inter-Regular",
            "HelveticaNeue", "STXinwei", "MicrosoftYaHei", "DengXian"]
    seen, cands = set(), []
    for f in faces:
        ps = f.get("postScriptName") or ""
        fam = f.get("family") or ""
        if ps in want or fam in ("MiSans", "Gilroy", "Arial", "Inter"):
            key = (fam, f.get("subfamily"), f.get("filePath"))
            if key in seen:
                continue
            seen.add(key)
            cands.append(f)

    # 再加上几个中文/黑体做对照
    for f in faces:
        if (f.get("family") or "") in ("SimHei", "SimSun", "DengXian", "Microsoft YaHei"):
            cands.append(f)
            if len(cands) > 40:
                break

    scored = []
    for f in cands:
        p = f.get("filePath") or ""
        if not os.path.exists(p):
            continue
        try:
            v = feature(render(p, TEXT, int(f.get("collectionIndex") or 0)))
            if v is None:
                continue
            scored.append((cos(target, v), f.get("family"), f.get("subfamily"), p))
        except Exception as e:  # noqa: BLE001
            print("  跳过", f.get("family"), e)

    scored.sort(reverse=True)
    print("\n%-22s %-14s %s" % ("family", "subfamily", "相似度"))
    for s, fam, sub, p in scored[:15]:
        print("%-22s %-14s %.4f   %s" % (str(fam)[:22], str(sub)[:14], s, os.path.basename(p)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
