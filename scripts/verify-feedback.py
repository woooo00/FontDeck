"""
用诊断日志里保存的**原始轮廓**重放识别全链路（渲染 → 分行 → OCR → 字体比对）。

用法：
    python scripts/verify-feedback.py FD-20261110-144828 [FD-...]

比截图可靠得多：日志 JSON 里有 shapes / originX / scale，服务端能用完全
相同的输入再跑一次，改代码前后的差异一眼可见。
"""
import json
import os
import sys
import time
import urllib.request

API = "http://127.0.0.1:47615"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 系统代理会把 127.0.0.1 的请求也拐走，必须显式禁用
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def post(path, payload, timeout=300):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with OPENER.open(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def replay(tag):
    fp = os.path.join(ROOT, "data", "feedback", tag + ".json")
    if not os.path.exists(fp):
        print("找不到日志:", fp)
        return
    fb = json.load(open(fp, encoding="utf-8"))
    g = fb["context"]["geom"]
    old_rec = fb["context"].get("recognize", {})
    old_font = fb["context"].get("font", {})

    print("\n" + "=" * 68)
    print("重放", tag, " 画布 %sx%s  轮廓 %s 条" % (g["w"], g["h"], g.get("shapeCount", len(g["shapes"]))))
    print("=" * 68)

    payload = {k: g[k] for k in ("shapes", "w", "h", "scale", "originX", "originY") if k in g}
    if "textFrames" in g:
        payload["textFrames"] = g["textFrames"]
    t0 = time.time()
    d = post("/api/recover/geometry", payload)
    print("\n[几何 / 识别] ok=%s  %.2fs" % (d.get("ok"), time.time() - t0))
    bands = d.get("bands", [])
    print("  旧 bands %d 段 %s" % (len(old_rec.get("bands", [])), old_rec.get("bands", [])))
    print("  新 bands %d 段 %s" % (len(bands), bands))
    st = d.get("stats", {})
    print("  聚类 %s 行 / %s 单元 / 字高 %s / 耗时 %sms" % (
        st.get("rows"), st.get("chars"), st.get("charHeight"), st.get("durationMs")))

    old_lines = old_rec.get("lines", [])
    new_lines = d.get("lines", [])
    print("  逐行对比（旧 → 新）：")
    for i in range(max(len(old_lines), len(new_lines))):
        o = old_lines[i].get("text", "") if i < len(old_lines) else "-"
        n = new_lines[i].get("text", "") if i < len(new_lines) else "-"
        ns = new_lines[i].get("score", 0) if i < len(new_lines) else 0
        print("    行%-2d %.3f  %s" % (i + 1, ns, n))
        if o != n:
            print("         旧: %s" % o)

    lines = []
    for ln in new_lines:
        b = ln.get("box") or {}
        if not b or not ln.get("text"):
            continue
        w = max(1, b.get("r", 0) - b.get("l", 0))
        h = max(1, b.get("b", 0) - b.get("t", 0))
        lines.append({
            "text": ln["text"],
            "box": [b["l"], b["t"], b["r"], b["b"]],
            "weight": w * h,
        })
    if not lines:
        print("  （没有可用行，跳过字体比对）")
        return

    t1 = time.time()
    m = post("/api/recover/match", {"png": d["png"], "chars": [], "lines": lines})
    print("\n[字体] mode=%s  %.2fs  参比 %d 行" % (m.get("mode"), time.time() - t1, len(lines)))
    old_top = (old_font.get("candidates") or [{}])[0]
    if old_top:
        print("  旧第一名: %s %s  %s" % (
            old_top.get("familyZh") or old_top.get("family"),
            old_top.get("subfamily"), old_top.get("score")))
    for c in m.get("candidates", [])[:6]:
        print("  新 %-26s %-16s %.4f  %d%%" % (
            str(c.get("familyZh") or c.get("family"))[:26],
            str(c.get("subfamily"))[:16], c.get("score", 0), c.get("rel", 0)))


if __name__ == "__main__":
    tags = sys.argv[1:] or ["FD-20261110-144828", "FD-20261110-145847"]
    for t in tags:
        replay(t)
