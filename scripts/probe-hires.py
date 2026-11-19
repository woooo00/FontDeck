"""
「字体不对」类问题的分辨率对照实验。

起因（2026-11-11 诊断 FD-20261111-091907）：一行 12pt 的说明文字，转曲后
几何回传按 1px = 1pt 渲染 —— 画布只有 417×58 像素，字高 12~14px。
这个尺寸下字形骨架、衬线、比例全糊成黑块，字体比对只能比「墨迹密度分布」，
Top1 和 Top2 的差距常常只有 0.4%，推荐结果自然不准。

本脚本拿同一份原始轮廓，分别按 1x / 2x / 4x 渲染，看两件事：
  1. OCR 文本是否变干净（行尾幻觉、邮箱错字这类）
  2. 字体候选的排序和「Top1 与 Top2 的差距」是否拉开

用法：python scripts/probe-hires.py <诊断日志ID> [倍率...]
"""
import copy
import json
import os
import sys
import time
import urllib.request

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


def run(log_id, k):
    path = os.path.join(ROOT, "data", "feedback", "%s.json" % log_id)
    d = json.load(open(path, encoding="utf-8"))
    g = d["context"]["geom"]
    payload = {
        "shapes": scale_shapes(g["shapes"], k),
        "w": g["w"] * k,
        "h": g["h"] * k,
        "scale": g.get("scale", 4),
        "originX": g.get("originX", 0),
        "originY": g.get("originY", 0),
        "ptsW": g.get("ptsW", 0),
        "ptsH": g.get("ptsH", 0),
        "textFrames": g.get("textFrames", 0),
    }
    t0 = time.time()
    r = post("/api/recover/geometry", payload)
    t_geom = time.time() - t0
    if not r.get("ok"):
        print("  %dx 渲染失败：%s" % (k, r.get("error")))
        return

    lines = r.get("lines") or []
    targets = []
    for l in lines:
        b = l.get("box") or {}
        if not (l.get("text") or "").strip() or not b:
            continue
        targets.append({
            "text": str(l["text"]).strip(),
            "box": [b.get("l", 0), b.get("t", 0), b.get("r", 0), b.get("b", 0)],
            "weight": max(1, (b.get("r", 0) - b.get("l", 0)) * (b.get("b", 0) - b.get("t", 0))),
        })

    print("\n=== %dx ===  图 %dx%d，行带 %d，识别 %.1fs"
          % (k, r.get("pngW", 0), r.get("pngH", 0), len(r.get("bands") or []), t_geom))
    for l in lines:
        b = l.get("box") or {}
        print("   [%.3f] 字高 %dpx  %s"
              % (l.get("score", 0), (b.get("b", 0) - b.get("t", 0)), l.get("text", "")))

    if not targets:
        return
    t1 = time.time()
    m = post("/api/recover/match", {"png": r["png"], "chars": [], "lines": targets})
    cands = m.get("candidates") or []
    print("   字体比对 %.1fs" % (time.time() - t1))
    for i, c in enumerate(cands[:6]):
        gap = ""
        if i == 0 and len(cands) > 1:
            gap = "  (与第2名差 %.4f)" % (cands[0]["score"] - cands[1]["score"])
        print("     %d. %-34s %.4f %d%%%s"
              % (i + 1, ("%s %s" % (c.get("familyZh") or c.get("family"), c.get("subfamily") or "")).strip(),
                 c.get("score", 0), c.get("rel", 0), gap))


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    log_id = sys.argv[1]
    ks = [int(x) for x in sys.argv[2:]] or [1, 2, 4]
    print("分辨率对照：%s" % log_id)
    for k in ks:
        run(log_id, k)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
