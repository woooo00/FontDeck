"""
字体比对新算法原型：等高归一化 + 列投影对齐 + 重叠系数。

为什么换算法（2026-11-11，诊断 FD-20261111-091907）
---------------------------------------------------
旧法 line_feature()：整行墨迹框**同时**缩放到 1024×96（宽高各自拉伸），
再切 12×64 密度块算余弦。副作用有两个：
  1. 宽高各自拉伸 → 候选字体的「窄/宽」被抹掉；
  2. 余弦对向量整体缩放不敏感 → 「粗/细」几乎不体现。
结果：粗体斜体窄体全挤在 0.84 附近，Top1 与 Top2 差 0.4%，推荐等于随机。

新法：
  1. 两边都**等比**缩放到同一字高（保留字宽高比 = 字宽信息）；
  2. 用列投影互相关找最佳水平偏移（容忍 OCR 幻觉造成的错位）；
  3. 在该偏移下算「重叠系数」= 交集 / 较小面积（字重、骨架、字宽都进分数）。

用法：python scripts/probe-alignmatch.py <日志ID> [倍率]
"""
import json
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
LINE_H = 96


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


def fit_height(mask, h=LINE_H):
    """等比缩放到指定高度，宽度按比例"""
    hh, ww = mask.shape
    nw = max(1, int(round(ww * h / hh)))
    return cv2.resize(mask * 255, (nw, h), interpolation=cv2.INTER_AREA) > 127


def old_feature(gray):
    ink = gray < 128
    ys, xs = ink.nonzero()
    if len(xs) == 0:
        return None
    tight = ink[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1].astype(np.float32)
    small = cv2.resize(tight, (1024, 96), interpolation=cv2.INTER_AREA)
    return small.reshape(12, 96 // 12, 64, 1024 // 64).mean(axis=(1, 3)).ravel()


def _prof(m, n=512):
    p = m.sum(axis=0).astype(np.float64)
    if len(p) > n:
        idx = np.linspace(0, len(p) - 1, n).astype(int)
        p = p[idx]
    return p - p.mean()


def align_overlap(a, b):
    """a、b 等高的布尔图 → 最佳水平偏移下的重叠系数"""
    if a is None or b is None:
        return 0.0
    pa, pb = _prof(a), _prof(b)
    if len(pa) > len(pb):
        pa, pb = pb, pa
        a, b = b, a
    if len(pb) < len(pa):
        return 0.0
    corr = np.correlate(pb, pa, mode="valid")
    if corr.size == 0:
        return 0.0
    shift = int(np.argmax(corr))

    h = a.shape[0]
    width = max(a.shape[1], b.shape[1])
    ca = np.zeros((h, width), dtype=bool)
    cb = np.zeros((h, width), dtype=bool)
    ca[:, : a.shape[1]] = a
    cb[:, shift: shift + b.shape[1]] = b
    inter = np.logical_and(ca, cb).sum()
    union = np.logical_or(ca, cb).sum()
    # 用标准 IoU（交集/并集）：重叠系数会让「更粗的候选把原稿整个包住」拿满分，
    # 粗体会因此永远排在细体前面 —— 正是旧算法把细体稿推成 Heavy 的原因。
    return float(inter) / float(union) if union else 0.0


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
        srcs.append({"text": l["text"], "new": fit_height(m), "old": old_feature(crop)})
    print("图 %dx%d，%d 行参与比对" % (r["pngW"], r["pngH"], len(srcs)))

    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))
    pool = [f for f in idx["faces"]
            if f.get("postScriptName") and f.get("health") != "missing-file" and f.get("filePath")]

    rows = []
    t0 = time.time()
    for n, f in enumerate(pool):
        old_acc, old_w, new_acc, new_w = 0.0, 0.0, 0.0, 0.0
        try:
            for s in srcs:
                img = render_line(f["filePath"], s["text"], int(f.get("collectionIndex") or 0))
                if img is None:
                    continue
                if s["old"] is not None:
                    cf = old_feature(img)
                    if cf is not None:
                        old_acc += float(s["old"] @ cf / (np.linalg.norm(s["old"]) * np.linalg.norm(cf) + 1e-9))
                        old_w += 1
                m = ink_tight(img)
                if m is not None:
                    new_acc += align_overlap(s["new"], fit_height(m))
                    new_w += 1
        except Exception:
            continue
        if old_w > 0:
            rows.append({"name": ("%s %s" % (f.get("familyZh") or f.get("family"), f.get("subfamily") or "")).strip(),
                         "old": old_acc / old_w, "new": new_acc / new_w if new_w else 0.0})
        if n % 200 == 0 and n:
            print("   ...%d/%d %.0fs" % (n, len(pool), time.time() - t0))

    bo = sorted(rows, key=lambda x: -x["old"])[:8]
    bn = sorted(rows, key=lambda x: -x["new"])[:12]
    print("\n=== 旧方法 Top8 ===")
    for r_ in bo:
        print("   %.4f  %s" % (r_["old"], r_["name"]))
    print("=== 新方法 Top12 ===")
    for r_ in bn:
        print("   %.4f  %s" % (r_["new"], r_["name"]))
    print("\nTop1-Top2 差距：旧 %.4f ；新 %.4f"
          % (bo[0]["old"] - bo[1]["old"], bn[0]["new"] - bn[1]["new"]))
    kw = [x for x in rows if "Franklin" in x["name"]]
    kw.sort(key=lambda x: -x["new"])
    print("\nFranklin Gothic 系列（新方法前 8）：")
    for r_ in kw[:8]:
        print("   new %.4f  old %.4f  %s" % (r_["new"], r_["old"], r_["name"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
