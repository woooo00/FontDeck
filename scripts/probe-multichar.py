"""复现「一个字被识别成多个字符」：对真实转曲图里的每个字框，
把所有预处理变体的识别结果都打印出来，看多字符是从哪个变体来的。

用法: python scripts/probe-multichar.py <geom.png>
"""
import sys

import cv2
import numpy as np

sys.path.insert(0, "packages/ocr")
import worker  # noqa: E402


def split_columns(gray, min_gap=2):
    ink = (gray < 200).astype(np.uint8)
    cols = ink.sum(axis=0)
    boxes, start, gap = [], None, 0
    for x in range(len(cols)):
        if cols[x] > 0:
            if start is None:
                start = x
            gap = 0
        elif start is not None:
            gap += 1
            if gap >= min_gap:
                boxes.append((start, x - gap + 1))
                start, gap = None, 0
    if start is not None:
        boxes.append((start, len(cols) - 1))
    out = []
    for l, r in boxes:
        sub = ink[:, l : r + 1]
        rows = np.nonzero(sub.sum(axis=1) > 0)[0]
        if len(rows):
            out.append([int(l), int(rows.min()), int(r) + 1, int(rows.max()) + 1])
    return out


def variants(crop):
    prepared, pol = worker.prepare_crop(crop)
    base_pad = max(2, int(round(max(crop.shape[:2]) * 0.18)))
    raw_border = cv2.copyMakeBorder(
        crop, base_pad, base_pad, base_pad, base_pad,
        cv2.BORDER_CONSTANT, value=(255, 255, 255),
    )
    p55, _ = worker.prepare_crop(crop, pad_ratio=0.55)
    big = cv2.resize(prepared, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC)
    return [
        ("standard", prepared),
        ("pad55", p55),
        ("scale2x", big),
        ("raw", raw_border),
    ]


def main():
    png = sys.argv[1] if len(sys.argv) > 1 else None
    img = cv2.imread(png)
    if img is None:
        print("读不到图", png)
        return 1
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    boxes = split_columns(gray)
    eng = worker.build_engine()

    for i, b in enumerate(boxes):
        l, t, r, bt = b
        crop = img[t:bt, l:r]
        parts = []
        for name, v in variants(crop):
            if v is None:
                continue
            res = worker.recognize_array(eng, v)
            parts.append("%s=%r(%.2f)" % (name, res.get("text"), res.get("score") or 0))
        print("#%02d %-22s %s" % (i, str(b), "  ".join(parts)))

    # 额外：把「喝」框左右各放宽 15%，模拟聚类框偏大
    print("\n--- 框放宽后的表现 ---")
    for grow in (0.10, 0.20, 0.35):
        for i in (9, 10, 11):
            if i >= len(boxes):
                continue
            l, t, r, bt = boxes[i]
            dw = int((r - l) * grow)
            l2, r2 = max(0, l - dw), min(img.shape[1], r + dw)
            crop = img[t:bt, l2:r2]
            parts = []
            for name, v in variants(crop):
                if v is None:
                    continue
                res = worker.recognize_array(eng, v)
                parts.append("%s=%r(%.2f)" % (name, res.get("text"), res.get("score") or 0))
            print("grow %.2f #%02d  %s" % (grow, i, "  ".join(parts)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
