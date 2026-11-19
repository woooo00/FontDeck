"""
倾斜转曲文字的可行性实验。

用诊断日志里保存的**原始路径点串**合成旋转稿，验证：
  1. PCA / 投影搜索两种估角在 0°/±15°/30° 上准不准
  2. 按估角反向旋转几何点后，整行 OCR 能不能把文字读回来

不改动任何产品代码，纯粹做算法选型。

【已冻结 2026-11-10】按用户决定不再继续研发旋转 / 倾斜识别。
本脚本与 verify-skew.py 仅作实验留档，不属于日常回归；日常回归跑
scripts/verify-release.py。真实 AI 旋转稿与坐标回写未实机验证。
"""
import json
import math
import os
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "packages", "ocr"))
import worker  # noqa: E402

GEOM = json.load(
    open(os.path.join(ROOT, "data/feedback/FD-20261110-145847.json"), encoding="utf-8")
)["context"]["geom"]
TRUTH = [
    "Manufacturer: Guangzhou Welltop Intelligent Appliance Co., Ltd",
    "Address: Room 701-706, Building 3, No. 539 Shibei Gongye Road,",
    "Dashi Street, Panyu District, Guangzhou, Guangdong, China",
]
PAD = 10


def transform_geom(shapes, deg, pad=PAD):
    """绕画布中心旋转 deg 度，重算包围盒并平移到正坐标，返回 (新shapes, W, H)。"""
    cx, cy = GEOM["w"] / 2.0, GEOM["h"] / 2.0
    th = math.radians(deg)
    co, si = math.cos(th), math.sin(th)
    out, xs, ys = [], [], []
    for sh in shapes:
        pp = []
        for flat in sh["p"]:
            nf = []
            for k in range(0, len(flat), 6):
                for o in (0, 2, 4):  # ax,ay / ix,iy / ox,oy
                    x, y = flat[k + o] - cx, flat[k + o + 1] - cy
                    vx, vy = co * x - si * y, si * x + co * y
                    nf.extend([vx + cx, vy + cy])
            for k in range(0, len(nf), 2):
                xs.append(nf[k])
                ys.append(nf[k + 1])
            pp.append(nf)
        out.append({"c": sh.get("c", 1), "p": pp})

    dx, dy = pad - min(xs), pad - min(ys)
    for sh in out:
        for flat in sh["p"]:
            for k in range(0, len(flat), 2):
                flat[k] += dx
                flat[k + 1] += dy
    W = int(math.ceil(max(xs) + dx + pad))
    H = int(math.ceil(max(ys) + dy + pad))
    return out, W, H


def pca_angle(shapes):
    """只用锚点做 PCA，主方向即文字行方向。"""
    pts = []
    for sh in shapes:
        for flat in sh["p"]:
            for k in range(0, len(flat), 6):
                pts.append((flat[k], flat[k + 1]))
    if len(pts) < 8:
        return 0.0, 0.0
    P = np.asarray(pts, dtype=np.float64)
    C = np.cov(P.T)
    vals, vecs = np.linalg.eigh(C)
    v = vecs[:, int(np.argmax(vals))]
    a = math.degrees(math.atan2(v[1], v[0]))
    while a > 45:
        a -= 90
    while a <= -45:
        a += 90
    ratio = float(vals.max() / max(vals.min(), 1e-9))
    return a, ratio


def proj_angle(png, lo=-45, hi=45, step=1.0):
    """位图投影搜索：水平时墨迹集中在少数行，投影平方和/总和最大。"""
    g = cv2.imread(png, cv2.IMREAD_GRAYSCALE)
    if g is None:
        return 0.0
    ink = (g < 128).astype(np.uint8)
    scale = min(1.0, 600.0 / ink.shape[1])
    if scale < 1.0:
        ink = cv2.resize(ink, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
    h, w = ink.shape
    center = (w / 2.0, h / 2.0)
    best_a, best_s = 0.0, -1.0
    for a in np.arange(lo, hi + 0.001, step):
        M = cv2.getRotationMatrix2D(center, float(a), 1.0)
        rot = cv2.warpAffine(ink, M, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
        p = rot.sum(axis=1).astype(np.float64)
        s = float((p * p).sum()) / (float(p.sum()) + 1.0)
        if s > best_s:
            best_s, best_a = s, float(a)
    return best_a


def render(shapes, W, H, tag):
    p = os.path.join(ROOT, "data", "skew-%s.png" % tag)
    return worker.render_geometry(shapes, W, H, p, 3)


def ocr(png):
    g = cv2.imread(png, cv2.IMREAD_GRAYSCALE)
    bands = worker.find_row_bands(255 - g)
    eng = worker.build_engine()
    rs = worker.recognize_lines(eng, png, [[0, t, g.shape[1], b] for t, b in bands], 3)
    return bands, [(r.get("text") or "", r.get("score") or 0) for r in rs]


def score(texts):
    hit = sum(1 for a, b in zip(texts, TRUTH) if a[0].strip() == b)
    return hit


def main():
    eng = worker.build_engine()
    print("原稿 3 行；画布 %sx%s；轮廓 %d 条\n" % (GEOM["w"], GEOM["h"], len(GEOM["shapes"])))
    for deg in (0, 15, 30, -20, 8):
        sh, W, H = transform_geom(GEOM["shapes"], deg)
        r = render(sh, W, H, "raw%d" % deg)
        pa, ratio = pca_angle(sh)
        ja = proj_angle(r["png"])
        bands0, o0 = ocr(r["png"])
        print("=== 旋转 %+d°  画布 %dx%d ===" % (deg, W, H))
        print("   PCA %.1f° (轴比 %.1f)   投影 %.1f°" % (pa, ratio, ja))
        print("   摆正前 bands=%d  OCR=%s" % (len(bands0), [t[:28] for t, s in o0]))

        for name, est in (("PCA", pa), ("投影", ja)):
            fixed, W2, H2 = transform_geom(sh, -est)
            r2 = render(fixed, W2, H2, "fix%d_%s" % (deg, name))
            bands1, o1 = ocr(r2["png"])
            acc = score(o1)
            print(
                "   %s 摆正 %+.1f° -> bands=%d 命中 %d/3  %s"
                % (name, -est, len(bands1), acc, [t[:26] for t, s in o1])
            )
        print()


if __name__ == "__main__":
    main()
