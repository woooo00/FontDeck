"""用真实转曲图重放一次「识别 + 字体匹配」，定位两个问题：
   1) 「长」字为什么识别成空
   2) 字体匹配分数为什么全是 0

不依赖 AI，直接读 geom-*.png（服务端渲染出来的那张），
按列投影自己切框，等价于 pipeline 里的聚类结果。
"""

import base64
import json
import sys
import urllib.request

import cv2
import numpy as np

API = "http://127.0.0.1:47615"

# 本机请求必须绕开系统代理：环境里的 http_proxy 会把它转发出去，返回 502
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post(path, payload):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with _OPENER.open(req, timeout=120) as r:
        return json.loads(r.read().decode("utf-8"))


def split_columns(gray, min_gap=2):
    """按列投影切字。中文等宽，列上有墨迹就算在字里，间隙超过 min_gap 断开。"""
    ink = (gray < 200).astype(np.uint8)
    cols = ink.sum(axis=0)
    boxes = []
    start = None
    gap = 0
    for x in range(len(cols)):
        if cols[x] > 0:
            if start is None:
                start = x
            gap = 0
        else:
            if start is not None:
                gap += 1
                if gap >= min_gap:
                    boxes.append((start, x - gap + 1))
                    start = None
                    gap = 0
    if start is not None:
        boxes.append((start, len(cols) - 1))

    out = []
    for l, r in boxes:
        sub = ink[:, l : r + 1]
        rows = np.nonzero(sub.sum(axis=1) > 0)[0]
        if len(rows) == 0:
            continue
        out.append([int(l), int(rows.min()), int(r) + 1, int(rows.max()) + 1])
    return out


def crop_png_b64(img, box, pad=3):
    l, t, r, b = box
    h, w = img.shape[:2]
    l2, t2 = max(0, l - pad), max(0, t - pad)
    r2, b2 = min(w, r + pad), min(h, b + pad)
    ok, buf = cv2.imencode(".png", img[t2:b2, l2:r2])
    return base64.b64encode(buf.tobytes()).decode("ascii")


def main():
    png = sys.argv[1] if len(sys.argv) > 1 else None
    if not png:
        print("用法: python probe_trace.py <geom.png>")
        return 1

    img = cv2.imread(png)
    if img is None:
        print("读不到图:", png)
        return 1
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    print("图片 %dx%d，暗像素占比 %.3f" % (img.shape[1], img.shape[0], (gray < 128).mean()))

    boxes = split_columns(gray)
    print("切出 %d 个字框：" % len(boxes))
    for i, b in enumerate(boxes):
        print("  #%d %s  宽 %d 高 %d" % (i, b, b[2] - b[0], b[3] - b[1]))

    # 1) 逐字原样识别，看「长」到底返回什么
    items = [crop_png_b64(img, b) for b in boxes]
    r = post("/api/recover/recognize", {"png": png, "pngW": img.shape[1], "pngH": img.shape[0],
                                        "scale": 4, "originX": 0, "originY": 0,
                                        "ptsW": 0, "ptsH": 0, "textFrames": 0,
                                        "shapeCount": len(boxes), "shapes": boxes})
    if r.get("ok"):
        print("\n识别结果：", "".join((c.get("ch") or "□") for c in r["chars"]))
        for c in r["chars"]:
            print("  %r 分数 %.2f %s" % (c.get("ch"), c.get("score") or 0, c.get("error") or ""))
    else:
        print("识别失败:", r.get("error"))

    # 2) 字体匹配，打印**原始**分数而不是归一化后的百分比
    chars = [{"ch": c.get("ch") or "", "score": c.get("score") or 0,
              "box": [c["box"]["l"], c["box"]["t"], c["box"]["r"], c["box"]["b"]]}
             for c in (r.get("chars") or [])]
    if chars:
        m = post("/api/recover/match", {"png": png, "chars": chars})
        if m.get("ok"):
            print("\n字体匹配（原始分 / 归一化）：")
            for c in m["candidates"]:
                print("  %-24s %.4f  %d%%" % ((c.get("familyZh") or c.get("family")) + " " + (c.get("subfamily") or ""),
                                              c.get("score"), c.get("rel")))
            print("  参比字:", m.get("samples"))
        else:
            print("匹配失败:", m.get("error"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
