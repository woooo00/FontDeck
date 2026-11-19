"""复现 FD-20261110-144316（18 行俄语说明书），验证俄语识别 + 行分界 + 提速。

用诊断日志里保存的原始 678 条轮廓重放，不依赖 Illustrator。
"""
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "http://127.0.0.1:47615"
# 本机环境变量里有 http(s)_proxy，不显式绕过的话 127.0.0.1 也会被发给代理
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post(path, payload, timeout=300):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with OPENER.open(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    fb_path = os.path.join(ROOT, "data", "feedback", "FD-20261110-144316.json")
    fb = json.load(open(fb_path, encoding="utf-8"))
    g = fb["context"]["geom"]
    payload = {k: g[k] for k in ("shapes", "w", "h", "scale", "originX", "originY")}

    t0 = time.time()
    geo = post("/api/recover/geometry", payload)
    print("识别总耗时 %.2fs" % (time.time() - t0))
    print("bands %d：%s" % (len(geo.get("bands", [])), geo.get("bands")))
    print("stats", json.dumps(geo.get("stats", {}), ensure_ascii=False))

    lines = geo.get("lines", [])
    for i, l in enumerate(lines):
        print(
            "  行%02d [%-2s] %.3f %s"
            % (i + 1, l.get("engine") or "zh", l.get("score", 0), repr(l.get("text")))
        )

    targets = []
    for l in sorted(lines, key=lambda x: -len(x.get("text") or ""))[:5]:
        b = l["box"]
        targets.append({
            "text": l["text"],
            "box": [b["l"], b["t"], b["r"], b["b"]],
            "weight": (b["r"] - b["l"]) * (b["b"] - b["t"]),
        })
    t1 = time.time()
    m = post("/api/recover/match", {"png": geo["png"], "chars": [], "lines": targets})
    print("字体比对 %.2fs  mode=%s" % (time.time() - t1, m.get("mode")))
    for c in m.get("candidates", [])[:6]:
        print(
            "  %-26s %-16s %.4f %d%%"
            % (
                str(c.get("familyZh") or c.get("family"))[:26],
                str(c.get("subfamily"))[:16],
                c.get("score", 0),
                c.get("rel", 0),
            )
        )

    print("\n=== 位置与字号（最长行反推）===")
    for i, l in enumerate(lines[:4]):
        d = l["doc"]
        print(
            "  行%02d x=%.1f y=%.1f w=%.1f h=%.1f"
            % (i + 1, d["x"], d["y"], d["w"], d["h"])
        )
    longest = max(lines, key=lambda x: len(x.get("text") or ""))
    idx = json.load(open(os.path.join(ROOT, "data", "index.json"), encoding="utf-8"))
    faces = idx.get("faces") or idx
    path = next(
        (
            f["filePath"]
            for f in faces
            if (f.get("family") or "") == "MiSans"
            and (f.get("subfamily") or "") in ("Regular", "Normal")
            and os.path.exists(f.get("filePath") or "")
        ),
        None,
    )
    if path:
        from PIL import ImageFont

        fnt = ImageFont.truetype(path, 64)
        bb = fnt.getbbox(longest["text"])
        w64 = bb[2] - bb[0]
        # 几何图 1pt = 4px；PIL 64px 字号相当于 16pt
        print(
            "  最长行目标宽 %.1fpt → MiSans 反推字号 %.2fpt"
            % (longest["doc"]["w"], 64.0 * longest["doc"]["w"] / w64)
        )


if __name__ == "__main__":
    main()
