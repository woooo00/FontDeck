"""
字符块精确 IoU 对齐（最后一版原型）。

和 probe-dtw.py 的区别：代价函数从「粗特征距离」换成**精确单字 IoU**。
16×32 的密度块太粗，所有候选都被压到 0.79 分不开；单字 IoU 保留
字宽高比、笔画粗细和骨架，差距才拉得开。

粗筛放宽到三路并集（老分 Top40 ∪ 密度最接近 40 ∪ 字宽最接近 40），
因为老分会把窄体字排在 200 名开外，只靠老分粗筛会把正确答案直接滤掉。

用法：python scripts/probe-char.py <日志ID> [倍率]
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
CH = 72
GAP = 0.20


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
    units, run = [], None
    for i, v in enumerate(col):
        if v > 0 and run is None:
            run = i
        elif v == 0 and run is not None:
            units.append((run, i))
            run = None
    if run is not None:
        units.append((run, len(col)))
    return units


def norm_unit(mask):
    """单元 → 等高 CH、宽度按比例（保留字宽高比）的 bool 图"""
    h, w = mask.shape
    if h < 1 or w < 1:
        return None
    nw = max(1, int(round(w * CH / h)))
    return cv2.resize(mask * 255, (nw, CH), interpolation=cv2.INTER_AREA) > 127


def unit_iou(a, b):
    if a is None or b is None:
        return 0.0
    w = max(a.shape[1], b.shape[1])
    ca = np.zeros((CH, w), dtype=bool)
    cb = np.zeros((CH, w), dtype=bool)
    ca[:, (w - a.shape[1]) // 2: (w - a.shape[1]) // 2 + a.shape[1]] = a
    cb[:, (w - b.shape[1]) // 2: (w - b.shape[1]) // 2 + b.shape[1]] = b
    inter = np.logical_and(ca, cb).sum()
    union = np.logical_or(ca, cb).sum()
    return float(inter) / float(union) if union else 0.0


def align_score(u1, u2):
    n, m = len(u1), len(u2)
    if not n or not m:
        return 0.0
    sim = np.zeros((n, m), dtype=np.float32)
    for i in range(n):
        for j in range(m):
            sim[i, j] = unit_iou(u1[i], u2[j])
    dp = np.zeros((n + 1, m + 1), dtype=np.float32)
    dp[:, 0] = -GAP * np.arange(n + 1)
    dp[0, :] = -GAP * np.arange(m + 1)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            dp[i, j] = max(dp[i - 1, j - 1] + sim[i - 1, j - 1],
                           dp[i - 1, j] - GAP,
                           dp[i, j - 1] - GAP)
    i, j = n, m
    pairs = []
    while i > 0 and j > 0:
        cur = dp[i, j]
        if abs(cur - (dp[i - 1, j - 1] + sim[i - 1, j - 1])) < 1e-6:
            pairs.append(float(sim[i - 1, j - 1]))
            i -= 1
            j -= 1
        elif abs(cur - (dp[i - 1, j] - GAP)) < 1e-6:
            i -= 1
        else:
            j -= 1
    return float(np.mean(pairs)) if pairs else 0.0


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


def row_stats(mask):
    units = split_units(mask)
    ws = sorted(b - a for a, b in units)
    med = ws[len(ws) // 2] if ws else mask.shape[1]
    h = mask.shape[0]
    return {"width": med / float(max(1, h)), "dens": float(mask.sum()) / float(max(1, mask.size))}


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
    gray = cv2.imread(r["png"], cv2.IMREAD_GRAYSCALE)

    srcs = []
    for l in r["lines"]:
        b = l["box"]
        crop = gray[b["t"]: b["b"], b["l"]: b["r"]]
        m = ink_tight(crop)
        if m is None:
            continue
        srcs.append({"text": l["text"], "units": [norm_unit(m[:, a:b]) for (a, b) in split_units(m)],
                     "feat": old_feature(crop), "stats": row_stats(m)})
        print("   原稿行：%d 字符 → %d 块，字宽比 %.3f 密度 %.3f"
              % (len(l["text"]), len(srcs[-1]["units"]), srcs[-1]["stats"]["width"], srcs[-1]["stats"]["dens"]))

    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))
    pool = [f for f in idx["faces"]
            if f.get("postScriptName") and f.get("health") != "missing-file" and f.get("filePath")]

    cached = {}
    coarse = []
    t0 = time.time()
    for n, f in enumerate(pool):
        acc, w = 0.0, 0.0
        st = {"width": 0.0, "dens": 0.0}
        try:
            for s in srcs:
                img = render_line(f["filePath"], s["text"], int(f.get("collectionIndex") or 0))
                if img is None:
                    continue
                cf = old_feature(img)
                cm = ink_tight(img)
                if cf is None or cm is None:
                    continue
                acc += float(s["feat"] @ cf / (np.linalg.norm(s["feat"]) * np.linalg.norm(cf) + 1e-9))
                cs = row_stats(cm)
                st["width"] += cs["width"]
                st["dens"] += cs["dens"]
                w += 1
                cached[(f["id"], s["text"])] = cm
        except Exception:
            continue
        if w:
            coarse.append({"f": f, "old": acc / w, "width": st["width"] / w, "dens": st["dens"] / w})
    print("全量粗筛 %.0fs" % (time.time() - t0))

    by_old = sorted(coarse, key=lambda x: -x["old"])[:40]
    src_w = sum(s["stats"]["width"] for s in srcs) / len(srcs)
    src_d = sum(s["stats"]["dens"] for s in srcs) / len(srcs)
    by_width = sorted(coarse, key=lambda x: abs(x["width"] - src_w))[:40]
    by_dens = sorted(coarse, key=lambda x: abs(x["dens"] - src_d))[:40]
    sel = {id(x["f"]): x for x in by_old + by_width + by_dens}
    print("精排候选 %d 个" % len(sel))

    rows = []
    t0 = time.time()
    for i, x in enumerate(sel.values()):
        f = x["f"]
        acc, w = 0.0, 0.0
        try:
            for s in srcs:
                cm = cached.get((f["id"], s["text"]))
                if cm is None:
                    img = render_line(f["filePath"], s["text"], int(f.get("collectionIndex") or 0))
                    if img is None:
                        continue
                    cm = ink_tight(img)
                if cm is None:
                    continue
                cu = [norm_unit(cm[:, a:b]) for (a, b) in split_units(cm)]
                acc += align_score(s["units"], cu)
                w += 1
        except Exception:
            continue
        if w:
            rows.append({"name": ("%s %s" % (f.get("familyZh") or f.get("family"), f.get("subfamily") or "")).strip(),
                         "old": x["old"], "new": acc / w})
        if i % 20 == 0 and i:
            print("   ...%d/%d %.0fs" % (i, len(sel), time.time() - t0))

    rows.sort(key=lambda x: -x["new"])
    print("\n=== 字符块 IoU 对齐 Top12 ===")
    for x in rows[:12]:
        print("   %.4f (老 %.4f)  %s" % (x["new"], x["old"], x["name"]))
    if len(rows) > 1:
        print("\nTop1-Top2 差距 %.4f" % (rows[0]["new"] - rows[1]["new"]))
    kw = [x for x in rows if "Franklin" in x["name"]]
    kw.sort(key=lambda x: -x["new"])
    print("\nFranklin Gothic 系列：")
    for x in kw[:8]:
        print("   new %.4f  old %.4f  %s" % (x["new"], x["old"], x["name"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
