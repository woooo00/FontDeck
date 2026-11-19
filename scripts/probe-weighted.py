"""
字体比对加权法原型：老余弦分 × 字宽/字重/倾斜三项一致性惩罚。

依据（2026-11-11，FD-20261111-091907 + 叠加图诊断）
----------------------------------------------------
原稿是「窄体、细身、正体」，老算法却推了 Heavy Italic（粗斜体）。
根因是老特征把整行同时拉到 1024×96：宽高各自拉伸 → 字宽信息被抹平；
余弦对整体缩放不敏感 → 字重几乎不体现。候选于是全部挤在 0.84 附近。

这里在老分上乘三个「一致性因子」：
  w_width  候选字宽高比 vs 原稿字宽高比（用字符单元宽度中位数 / 行高，抗 tracking）
  w_weight 墨迹密度（笔画粗细）之比
  w_slant 倾斜角之差
这三项都是行级特征，代价可忽略，可以直接进生产路径。

用法：python scripts/probe-weighted.py <日志ID> [倍率] [行号...]
"""
import json
import math
import os
import sys
import time
import urllib.request

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = os.environ.get("FONTDECK_API", "http://127.0.0.1:47615")
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post(path, data, timeout=600):
    q = urllib.request.Request(
        API + path,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with OPENER.open(q, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def scale_shapes(shapes, k):
    out = []
    for s in shapes:
        segs = []
        for flat in s.get("p") or []:
            nf = []
            for i in range(0, len(flat), 2):
                nf.extend([flat[i] * k, flat[i + 1] * k])
            segs.append(nf)
        out.append({"c": s.get("c", 1), "p": segs})
    return out


def ink_tight(gray):
    ink = (gray < 128).astype(np.uint8)
    ys, xs = ink.nonzero()
    if len(xs) == 0:
        return None
    return ink[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1]


def split_units(mask):
    col = mask.sum(axis=0)
    units = []
    run = None
    for i, v in enumerate(col):
        if v > 0 and run is None:
            run = i
        elif v == 0 and run is not None:
            units.append((run, i))
            run = None
    if run is not None:
        units.append((run, len(col)))
    return units


def line_stats(mask):
    """行级特征：字宽（字符紧致宽高比中位数）、墨迹密度、倾斜角

    注意：切出来的块是「列区间」，高度仍是整行高 —— 必须再取一次紧致
    bbox，否则每个块的高度都一样，字宽特征会退化成「块宽/行高」。
    """
    h, w = mask.shape
    ratios = []
    for a, b in split_units(mask):
        piece = mask[:, a:b]
        ys, xs = piece.nonzero()
        if len(xs) == 0:
            continue
        pw = xs.max() - xs.min() + 1
        ph = ys.max() - ys.min() + 1
        if ph > 0:
            ratios.append(pw / float(ph))
    ratios.sort()
    med = ratios[len(ratios) // 2] if ratios else 1.0
    density = float(mask.sum()) / float(max(1, h * w))
    # 倾斜：每列的墨迹重心做线性拟合
    prof = mask.sum(axis=0)
    idx = np.nonzero(prof)[0]
    if len(idx) > 3:
        ys = np.arange(h)[:, None]
        centers = (mask[:, idx] * ys).sum(axis=0) / (prof[idx] + 1e-9)
        A = np.vstack([idx.astype(float), np.ones(len(idx))]).T
        try:
            slope = float(np.linalg.lstsq(A, centers, rcond=None)[0][0])
        except Exception:
            slope = 0.0
        angle = math.degrees(math.atan(slope))
    else:
        angle = 0.0
    return {"width": med, "density": density, "angle": angle}


def old_feature(gray):
    ink = gray < 128
    ys, xs = ink.nonzero()
    if len(xs) == 0:
        return None
    tight = ink[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1].astype(np.float32)
    small = cv2.resize(tight, (1024, 96), interpolation=cv2.INTER_AREA)
    return small.reshape(12, 96 // 12, 64, 1024 // 64).mean(axis=(1, 3)).ravel()


def render_line(path, text, index=0):
    try:
        f = ImageFont.truetype(path, 64, index=index)
    except Exception:
        return None
    bb = f.getbbox(text)
    if bb is None:
        return None
    w, h = int(bb[2] - bb[0] + 24), int(bb[3] - bb[1] + 24)
    if w <= 0 or h <= 0:
        return None
    im = Image.new("L", (w, h), 255)
    ImageDraw.Draw(im).text((12 - bb[0], 12 - bb[1]), text, font=f, fill=0)
    return np.array(im)


def penalty(src, cand, k_width=2.0, k_weight=2.0, k_slant=3.0):
    """三项一致性因子（都取 0..1）"""
    r_w = math.log(max(1e-6, src["width"] / max(1e-6, cand["width"])))
    r_d = math.log(max(1e-6, src["density"] / max(1e-6, cand["density"])))
    da = src["angle"] - cand["angle"]
    return (math.exp(-k_width * abs(r_w)) * math.exp(-k_weight * abs(r_d))
            * math.exp(-k_slant * abs(da)))


def main():
    log_id = sys.argv[1]
    k = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    d = json.load(open(os.path.join(ROOT, "data", "feedback", "%s.json" % log_id), encoding="utf-8"))
    g = d["context"]["geom"]
    r = post("/api/recover/geometry", {
        "shapes": scale_shapes(g["shapes"], k),
        "w": g["w"] * k, "h": g["h"] * k,
        "scale": g.get("scale", 4), "originX": g.get("originX", 0),
        "originY": g.get("originY", 0), "ptsW": g.get("ptsW", 0),
        "ptsH": g.get("ptsH", 0), "textFrames": g.get("textFrames", 0),
    })
    if not r.get("ok"):
        print("渲染失败", r.get("error"))
        return 1
    gray = cv2.imread(r["png"], cv2.IMREAD_GRAYSCALE)

    srcs = []
    for l in r["lines"]:
        b = l["box"]
        crop = gray[b["t"]: b["b"], b["l"]: b["r"]]
        m = ink_tight(crop)
        if m is None:
            continue
        srcs.append({"text": l["text"], "feat": old_feature(crop), "stats": line_stats(m)})
    print("图 %dx%d，%d 行" % (r["pngW"], r["pngH"], len(srcs)))
    for s in srcs:
        print("   原稿统计：字宽 %.3f  密度 %.3f  倾角 %+.2f°"
              % (s["stats"]["width"], s["stats"]["density"], s["stats"]["angle"]))

    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))
    pool = [f for f in idx["faces"]
            if f.get("postScriptName") and f.get("health") != "missing-file" and f.get("filePath")]

    rows = []
    t0 = time.time()
    for n, f in enumerate(pool):
        old_acc, new_acc, w = 0.0, 0.0, 0.0
        try:
            for s in srcs:
                img = render_line(f["filePath"], s["text"], int(f.get("collectionIndex") or 0))
                if img is None:
                    continue
                cf = old_feature(img)
                cm = ink_tight(img)
                if cf is None or cm is None:
                    continue
                cos = float(s["feat"] @ cf / (np.linalg.norm(s["feat"]) * np.linalg.norm(cf) + 1e-9))
                cst = line_stats(cm)
                old_acc += cos
                new_acc += cos * penalty(s["stats"], cst)
                w += 1
        except Exception:
            continue
        if w > 0:
            rows.append({"name": ("%s %s" % (f.get("familyZh") or f.get("family"), f.get("subfamily") or "")).strip(),
                         "old": old_acc / w, "new": new_acc / w})
        if n % 200 == 0 and n:
            print("   ...%d/%d %.0fs" % (n, len(pool), time.time() - t0))

    bo = sorted(rows, key=lambda x: -x["old"])[:6]
    bn = sorted(rows, key=lambda x: -x["new"])[:12]
    topn = sorted(sorted(rows, key=lambda x: -x["old"])[:24], key=lambda x: -x["new"])[:8]
    print("\n=== 老方法 Top6 ===")
    for x in bo:
        print("   %.4f  %s" % (x["old"], x["name"]))
    print("=== 加权后 Top12（全体重排）===")
    for x in bn:
        print("   %.4f (老 %.4f)  %s" % (x["new"], x["old"], x["name"]))
    print("=== 两阶段：老分 Top24 内按加权分重排 Top8 ===")
    for x in topn:
        print("   %.4f (老 %.4f)  %s" % (x["new"], x["old"], x["name"]))
    print("\nTop1-Top2 差距：老 %.4f ；加权 %.4f"
          % (bo[0]["old"] - bo[1]["old"], bn[0]["new"] - bn[1]["new"]))
    kw = [x for x in rows if "Franklin" in x["name"]]
    kw.sort(key=lambda x: -x["new"])
    print("\nFranklin Gothic 系列（加权后前 8）：")
    for x in kw[:8]:
        print("   new %.4f  old %.4f  %s" % (x["new"], x["old"], x["name"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
