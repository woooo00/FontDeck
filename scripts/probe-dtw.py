"""
字符块 DP 对齐原型：解决「字距差异毁掉整行比对」。

背景
----
整行比对（无论余弦还是 IoU）都败在同一件事上：原稿的**字距（tracking）**
与候选字体默认间距不同，误差沿行累积，后半行完全错位 → 分数趋同、
没有区分度。要消除它，必须**逐字对齐**。

做法
----
1. 原稿行、候选行都按「列投影的零间隙」切成视觉字块（两边粒度一致，
   粘连情况相近），不依赖 OCR 字符数，OCR 幻觉不会破坏切分；
2. 字符块特征 = 密度块 + 宽高比 + 墨迹密度（宽高比单独一项，
   不会像整行拉伸那样被抹掉）；
3. Needleman-Wunsch 对齐两条块序列，允许一侧多出/粘连（gap 惩罚），
   每个字独立配对 → 字距差异被吸收。

用法：python scripts/probe-dtw.py <日志ID> [倍率] [粗筛数量]
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
UH, UW = 32, 16      # 单元密度块
GAP = 0.25           # gap 惩罚（相似度尺度）


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


def unit_feature(mask):
    """单元 → (密度块向量, 宽高比, 墨迹密度)"""
    h, w = mask.shape
    if h < 1 or w < 1:
        return None
    block = cv2.resize(mask * 255, (UW, UH), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    return {
        "d": block.ravel(),
        "wh": w / float(h),
        "dens": float(mask.sum()) / float(h * w),
    }


def unit_similarity(a, b):
    if a is None or b is None:
        return 0.0
    d = float(np.abs(a["d"] - b["d"]).mean())
    w = min(a["wh"], b["wh"]) / max(a["wh"], b["wh"])
    s = 0.55 * (1.0 - min(1.0, d * 2.2)) + 0.25 * w + 0.20 * (1.0 - min(1.0, abs(a["dens"] - b["dens"]) * 4))
    return max(0.0, min(1.0, s))


def align_score(u1, u2):
    """Needleman-Wunsch 对齐两条单元序列，返回 (平均相似度, 配对数)"""
    n, m = len(u1), len(u2)
    if not n or not m:
        return 0.0, 0
    sim = np.zeros((n, m), dtype=np.float32)
    for i in range(n):
        ai = u1[i]
        for j in range(m):
            sim[i, j] = unit_similarity(ai, u2[j])
    dp = np.zeros((n + 1, m + 1), dtype=np.float32)
    dp[:, 0] = -GAP * np.arange(n + 1)
    dp[0, :] = -GAP * np.arange(m + 1)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            dp[i, j] = max(dp[i - 1, j - 1] + sim[i - 1, j - 1],
                           dp[i - 1, j] - GAP,
                           dp[i, j - 1] - GAP)
    # 回溯
    i, j = n, m
    pairs = []
    while i > 0 and j > 0:
        cur = dp[i, j]
        if abs(cur - (dp[i - 1, j - 1] + sim[i - 1, j - 1])) < 1e-6:
            pairs.append(sim[i - 1, j - 1])
            i -= 1
            j -= 1
        elif abs(cur - (dp[i - 1, j] - GAP)) < 1e-6:
            i -= 1
        else:
            j -= 1
    if not pairs:
        return 0.0, 0
    return float(np.mean(pairs)), len(pairs)


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


def main():
    log_id = sys.argv[1]
    k = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    keep = int(sys.argv[3]) if len(sys.argv) > 3 else 150
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
        units = [unit_feature(m[:, a:b]) for (a, b) in split_units(m)]
        srcs.append({"text": l["text"], "units": units, "feat": old_feature(crop),
                     "n": len(units)})
        print("   原稿行：文本 %d 字符 → 切出 %d 块" % (len(l["text"]), len(units)))

    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))
    pool = [f for f in idx["faces"]
            if f.get("postScriptName") and f.get("health") != "missing-file" and f.get("filePath")]

    # 第一遍：老分粗筛
    coarse = []
    for n, f in enumerate(pool):
        acc, w = 0.0, 0.0
        try:
            for s in srcs:
                img = render_line(f["filePath"], s["text"], int(f.get("collectionIndex") or 0))
                if img is None:
                    continue
                cf = old_feature(img)
                if cf is None:
                    continue
                acc += float(s["feat"] @ cf / (np.linalg.norm(s["feat"]) * np.linalg.norm(cf) + 1e-9))
                w += 1
        except Exception:
            continue
        if w:
            coarse.append((acc / w, f))
    coarse.sort(key=lambda x: -x[0])
    print("粗筛保留 %d 个" % min(keep, len(coarse)))

    # 第二遍：字符块 DP 精排
    rows = []
    t0 = time.time()
    for rank, (old, f) in enumerate(coarse[:keep]):
        acc, w = 0.0, 0.0
        try:
            for s in srcs:
                img = render_line(f["filePath"], s["text"], int(f.get("collectionIndex") or 0))
                if img is None:
                    continue
                m = ink_tight(img)
                if m is None:
                    continue
                cu = [unit_feature(m[:, a:b]) for (a, b) in split_units(m)]
                sc, _ = align_score(s["units"], cu)
                acc += sc
                w += 1
        except Exception:
            continue
        if w:
            rows.append({"name": ("%s %s" % (f.get("familyZh") or f.get("family"), f.get("subfamily") or "")).strip(),
                         "old": old, "new": acc / w})
        if rank % 25 == 0 and rank:
            print("   ...%d/%d %.0fs" % (rank, min(keep, len(coarse)), time.time() - t0))

    rows.sort(key=lambda x: -x["new"])
    print("\n=== 字符块 DP Top12 ===")
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
