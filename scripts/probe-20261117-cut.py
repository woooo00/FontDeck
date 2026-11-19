"""探针：现有 split-line 的切点在本例落在哪 / 按「正确边界」切能得多少分。

本行实际：`• WARNING:(粗) Do not use this appliance near bathtubs,(常规)`
正确样式边界在 "WARNING:" 之后（约 x 占 19%），而全行最宽空白在
"this|appliance"（占 31%）。所以「最宽空白」策略切不出正确边界。

要回答两件事：
  1) 现在点「2 段」会切在哪、切完两段各自分数多少
  2) 若切在正确边界，两段分数多少（上限参照）
"""
import json
import os
import sys

import cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "packages", "ocr"))

import worker  # noqa: E402


def load_pool():
    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))
    out, seen = [], set()
    for f in idx["faces"]:
        ps = (f.get("postScriptName") or "").strip().lower()
        if not ps or ps in seen or f.get("health") == "missing-file" or not f.get("filePath"):
            continue
        seen.add(ps)
        out.append({"id": f["id"], "path": f["filePath"], "index": int(f.get("collectionIndex") or 0)})
    return out, idx["faces"]


def top(scores, faces, n=5):
    byid = {f["id"]: f for f in faces}
    for s in scores[:n]:
        f = byid.get(s["id"], {})
        nm = ((f.get("familyZh") or f.get("family") or "?") + " " + (f.get("subfamily") or "")).strip()
        print("    %-32s %.4f" % (nm[:32], s["score"]))


def main():
    d = json.load(open(os.path.join(ROOT, "data", "feedback", "FD-20261117-142243.json"), encoding="utf-8"))
    rec = d["context"]["recognize"]
    png = rec["png"]
    ln = rec["lines"][0]
    b = ln["box"]
    box = [b["l"], b["t"], b["r"], b["b"]]
    pool, faces = load_pool()

    print("=== 1. 现有 split-line(2) 的切点 ===")
    r = worker.split_line_gaps(png, box, 2)
    print("  返回：%s" % (r,))

    print("\n=== 2. 按「去掉行首圆点 + WARNING: 后」切 ===")
    gray = cv2.imread(png, cv2.IMREAD_GRAYSCALE)
    crop = gray[box[1]:box[3], box[0]:box[2]]
    mask = (crop < 128).astype("uint8")
    cols = mask.sum(axis=0)
    nz = [x for x, v in enumerate(cols) if v > 0]
    print("  墨迹 x 范围：%d..%d（行宽 %d）" % (nz[0], nz[-1], crop.shape[1]))

    # 从左往右找前几个「宽 ≥ 30px」的空白，看哪一个是 WARNING: 之后
    runs, start = [], None
    for x, v in enumerate(cols):
        if v == 0 and start is None:
            start = x
        elif v != 0 and start is not None:
            if x - start >= 25:
                runs.append((start, x))
            start = None
    print("  较宽空白：%s" % (runs[:6],))

    def seg(l, r, text, tag):
        s = worker.compare_line_fonts(png, [{"box": [l, box[1], r, box[3]], "text": text, "weight": 1.0}], pool)
        print("\n  [%s] box=[%d..%d] text=%r" % (tag, l, r, text))
        top(s, faces, 4)
        return s

    # 用第 2 个空白（WARNING: 之后）当边界
    for i, (gl, gr) in enumerate(runs[:4]):
        cut = box[0] + gl
        print("\n--- 候选切点 %d：x=%d（占 %.0f%%）---" % (i + 1, cut, 100.0 * gl / crop.shape[1]))
        seg(box[0], cut, "• WARNING:", "左")
        seg(cut, box[2], "Do not use this appliance near bathtubs,", "右")


if __name__ == "__main__":
    main()
