"""纯探针：验证「整块文字被旋转 180°」时，翻正后 OCR / 字体比对能否恢复。

不改动任何产品代码。用法：
    python scripts/probe-flip180.py FD-20261112-100814
"""
import importlib.util
import json
import os
import sys

import cv2

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "packages", "ocr"))

spec = importlib.util.spec_from_file_location(
    "wk", os.path.join(ROOT, "packages", "ocr", "worker.py")
)
wk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wk)


def flip_box(box, w, h):
    """180° 中心对称的逆变换：翻正图里的框 → 原图里的框（同一个公式）。"""
    l, t, r, b = box
    return [w - r, h - b, w - l, h - t]


def main():
    log_id = sys.argv[1] if len(sys.argv) > 1 else "FD-20261112-100814"
    p = os.path.join(ROOT, "data", "feedback", log_id + ".json")
    d = json.load(open(p, encoding="utf-8"))
    c = d["context"]
    r = c["recognize"]
    png = r.get("png") or c["geom"].get("png")
    if not png or not os.path.exists(png):
        # 日志里的路径可能已失效，退回 feedback 里记录的渲染图路径
        txt = open(os.path.join(ROOT, "data", "feedback", log_id + ".txt"), encoding="utf-8").read()
        import re
        m = re.search(r"渲染图：(.+\.png)", txt)
        png = m.group(1).strip() if m else ""
    print("渲染图:", png)

    img = cv2.imread(png, cv2.IMREAD_GRAYSCALE)
    if img is None:
        print("读不到渲染图，退出")
        return
    H, W = img.shape
    print("尺寸 %dx%d" % (W, H))

    flipped = cv2.rotate(img, cv2.ROTATE_180)
    out = os.path.join(ROOT, "data", "_analysis")
    os.makedirs(out, exist_ok=True)
    fp = os.path.join(out, "flip180-ocr.png")
    cv2.imwrite(fp, flipped)

    boxes = []
    for l in (r.get("lines") or []):
        b = l.get("box") or {}
        if all(k in b for k in ("l", "t", "r", "b")):
            boxes.append([b["l"], b["t"], b["r"], b["b"]])
    if not boxes:
        # 退化：用行带把整幅宽度当行框
        for t, bot in (r.get("bands") or []):
            boxes.append([0, t, W, bot])
    fboxes = [flip_box(b, W, H) for b in boxes]

    print("\n=== 原图（日志里的行框） ===")
    eng = wk.build_engine("zh")
    for tag, path, bs in (("原图", png, boxes), ("180° 翻正", fp, fboxes)):
        res = wk.recognize_lines(eng, path, bs, 3)
        print("\n--- %s ---" % tag)
        for i, x in enumerate(res):
            print("  行%d [%.3f] %r" % (i + 1, x.get("score", 0), x.get("text", "")))
        print("  平均分 %.4f" % (sum(x.get("score", 0) for x in res) / max(1, len(res))))


if __name__ == "__main__":
    main()
