"""
字符级字体比对原型：验证「整行拉伸归一化」是不是字体匹配失真的根因。

现状（worker.py::line_feature）：把整行墨迹框**同时**缩放到 1024×96，
再切 12×64 密度块算余弦。这么做有两个副作用：
  1. 横向强制拉到固定宽度 → 候选字体的「窄/宽」信息被抹平；
  2. 余弦对向量整体缩放不敏感 → 「粗/细」几乎不体现。

结果就是：粗体、斜体、窄体全都挤在 0.84 附近，Top1 与 Top2 差 0.4%。

本原型改成：把一行切成字符，原稿按列投影切、候选按字体 advance 切，
逐字在「统一高度、保留各自宽度」下算 IoU —— 字宽、字重、骨架都在分数里。

用法：python scripts/probe-charmatch.py <诊断日志ID> [倍率]
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
CH = 64          # 统一字高
COLS = 12        # 旧方法的列块数（对照用）
ROWS = 12


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


def ink_mask(gray):
    """二值化 + 裁到墨迹框"""
    ink = (gray < 128).astype(np.uint8)
    ys, xs = ink.nonzero()
    if len(xs) == 0:
        return None
    return ink[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1]


def split_columns(mask):
    """按列投影的零间隙把一行切成若干单元（≈字符）"""
    col = mask.sum(axis=0)
    cuts = []
    run = None
    for i, v in enumerate(col):
        if v > 0 and run is None:
            run = i
        elif v == 0 and run is not None:
            cuts.append((run, i))
            run = None
    if run is not None:
        cuts.append((run, len(col)))
    return cuts


def norm_char(mask):
    """单元图 → 统一高度、宽度按比例（保留字宽信息）"""
    h, w = mask.shape
    if h < 2 or w < 1:
        return None
    nw = max(1, int(round(w * CH / h)))
    return cv2.resize(mask * 255, (nw, CH), interpolation=cv2.INTER_AREA) > 127


def char_iou(a, b):
    """两张统一高度的字形，居中对齐后的 IoU"""
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


def line_iou(a, b):
    """整行 IoU（等高、居中）"""
    return char_iou(a, b)


def old_feature(gray):
    """worker.py 现有做法：整行拉到 1024×96 的 12×64 密度块"""
    ink = gray < 128
    ys, xs = ink.nonzero()
    if len(xs) == 0:
        return None
    tight = ink[ys.min(): ys.max() + 1, xs.min(): xs.max() + 1].astype(np.float32)
    small = cv2.resize(tight, (1024, 96), interpolation=cv2.INTER_AREA)
    return small.reshape(12, 96 // 12, 64, 1024 // 64).mean(axis=(1, 3)).ravel()


def render_chars(path, text, index=0):
    """渲染文本并返回逐字掩膜（按字体 advance 切）"""
    try:
        f = ImageFont.truetype(path, 64, index=index)
    except Exception:
        return None
    widths = [f.getlength(text[: i + 1]) for i in range(len(text))]
    prev = 0.0
    spans = []
    for w in widths:
        spans.append((prev, w))
        prev = w
    bb = f.getbbox(text)
    im = Image.new("L", (int(bb[2] - bb[0] + 24), int(bb[3] - bb[1] + 24)), 255)
    ImageDraw.Draw(im).text((12 - bb[0], 12 - bb[1]), text, font=f, fill=0)
    arr = np.array(im)
    out = []
    for (a, b) in spans:
        x0 = int(round(a - bb[0] + 12))
        x1 = int(round(b - bb[0] + 12))
        if x1 <= x0:
            x1 = x0 + 1
        crop = arr[:, max(0, x0): min(arr.shape[1], x1)]
        m = ink_mask(crop)
        out.append(norm_char(m) if m is not None else None)
    return out, arr


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
    lines = r["lines"]
    print("图 %dx%d，%d 行" % (r["pngW"], r["pngH"], len(lines)))

    # 原稿逐行切字符
    srcs = []
    for l in lines:
        b = l["box"]
        crop = gray[b["t"]: b["b"], b["l"]: b["r"]]
        m = ink_mask(crop)
        if m is None:
            continue
        units = split_columns(m)
        chars = [norm_char(m[:, a:b]) for (a, b) in units]
        srcs.append({"text": l["text"], "chars": chars, "units": units,
                     "feat": old_feature(crop), "mask": m})
        print("  行: 文本 %d 字符 / 切出 %d 单元" % (len(l["text"]), len(units)))

    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))
    faces = idx["faces"] if isinstance(idx, dict) else idx
    pool = [f for f in faces if f.get("postScriptName") and f.get("health") != "missing-file" and f.get("filePath")]
    print("候选池 %d 个字体" % len(pool))

    results = []
    t0 = time.time()
    for n, f in enumerate(pool):
        old_acc, old_w, new_acc, new_w = 0.0, 0.0, 0.0, 0.0
        try:
            for s in srcs:
                got = render_chars(f["filePath"], s["text"], int(f.get("collectionIndex") or 0))
                if got is None:
                    continue
                cand_chars, cand_img = got
                # 旧方法
                if s["feat"] is not None:
                    cf = old_feature(cand_img)
                    if cf is not None:
                        a, b = s["feat"], cf
                        old_acc += float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
                        old_w += 1
                # 新方法：逐字 IoU，字符数一致时才对齐
                if len(cand_chars) == len(s["chars"]):
                    sim = [char_iou(a, b) for a, b in zip(s["chars"], cand_chars)]
                    new_acc += float(np.mean(sim))
                    new_w += 1
        except Exception:
            continue
        if old_w > 0 and new_w > 0:
            results.append({
                "id": f["id"], "name": ("%s %s" % (f.get("familyZh") or f.get("family"), f.get("subfamily") or "")).strip(),
                "old": old_acc / old_w, "new": new_acc / new_w,
                "path": f["filePath"], "index": int(f.get("collectionIndex") or 0),
            })
        if n % 100 == 0 and n:
            print("   ...%d/%d  %.0fs" % (n, len(pool), time.time() - t0))

    print("\n=== 旧方法（整行拉伸归一化）Top8 ===")
    for r_ in sorted(results, key=lambda x: -x["old"])[:8]:
        print("   %.4f  %s" % (r_["old"], r_["name"]))
    print("=== 新方法（逐字 IoU）Top12 ===")
    for r_ in sorted(results, key=lambda x: -x["new"])[:12]:
        print("   %.4f  %s" % (r_["new"], r_["name"]))

    best_old = sorted(results, key=lambda x: -x["old"])
    best_new = sorted(results, key=lambda x: -x["new"])
    print("\n旧方法 Top1-Top2 差距 %.4f ；新方法 %.4f"
          % (best_old[0]["old"] - best_old[1]["old"], best_new[0]["new"] - best_new[1]["new"]))

    frank = [r_ for r_ in results if "Franklin" in r_["name"]]
    frank.sort(key=lambda x: -x["new"])
    print("\nFranklin Gothic 系列（新方法前 8）：")
    for r_ in frank[:8]:
        print("   new %.4f  old %.4f  %s" % (r_["new"], r_["old"], r_["name"]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
