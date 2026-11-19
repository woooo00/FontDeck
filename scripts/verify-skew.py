"""
倾斜转曲文字的端到端回归：合成旋转稿 → /api/recover/geometry → 字体比对。

用诊断日志里的原始路径点串合成 0°/±15°/30°/8° 的倾斜稿，
验证自动摆正后文字、行分界、字体推荐都能恢复到水平稿的水平。

【已冻结 2026-11-10】旋转 / 倾斜识别不再继续研发，本脚本仅作实验留档，
不属于日常回归；日常回归跑 scripts/verify-release.py。
"""
import importlib.util
import json
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API = "http://127.0.0.1:47615"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
spec = importlib.util.spec_from_file_location("ps", os.path.join(ROOT, "scripts/probe-skew.py"))
ps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ps)

TRUTH = ps.TRUTH


def post(p, d, timeout=300):
    q = urllib.request.Request(
        API + p,
        data=json.dumps(d).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with OPENER.open(q, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    g = ps.GEOM
    print("原稿：3 行英文，%d 条轮廓，画布 %sx%s\n" % (len(g["shapes"]), g["w"], g["h"]))
    failed = 0
    for deg in (0, 8, 15, 30, -20):
        sh, W, H = ps.transform_geom(g["shapes"], deg)
        payload = {
            "shapes": sh, "w": W, "h": H,
            "scale": g["scale"], "originX": g["originX"], "originY": g["originY"],
        }
        d = post("/api/recover/geometry", payload)
        lines = d.get("lines", [])
        texts = [l["text"].strip() for l in lines]
        hit = sum(1 for a, b in zip(texts, TRUTH) if a == b)
        skew = d.get("skew")
        angle = skew["angle"] if skew else 0.0
        bands = d.get("bands", [])

        # 字体比对：lines[].box 与摆正后的 png 同坐标系
        targets = [
            {"text": l["text"], "box": [l["box"]["l"], l["box"]["t"],
                                        l["box"]["r"], l["box"]["b"]],
             "weight": (l["box"]["r"] - l["box"]["l"]) * (l["box"]["b"] - l["box"]["t"])}
            for l in lines if l.get("text") and l.get("box")
        ]
        font = "（无可比对行）"
        top = {}
        if targets:
            m = post("/api/recover/match", {"png": d["png"], "chars": [], "lines": targets})
            top = (m.get("candidates") or [{}])[0]
            font = "%s %s" % (top.get("familyZh") or top.get("family"),
                              top.get("subfamily") or "")

        expect_deskew = abs(deg) >= 5
        ok = (hit == 3 and len(bands) == 3 and bool(skew) == expect_deskew)
        if deg == 0:
            ok = ok and not skew
        if not ok:
            failed += 1
        print("旋转 %+3d° -> 估角 %+6.2f°  摆正=%-5s  bands=%d  文本 %d/3  字体 %s  %s"
              % (deg, angle, "是" if skew else "否", len(bands), hit,
                 font.strip()[:28], "✓" if ok else "✗ FAIL"))
        for t in texts:
            print("        " + t[:72])

    print("\n" + ("全部通过" if failed == 0 else "%d 个角度未通过" % failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
