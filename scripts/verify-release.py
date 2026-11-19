"""
FontDeck 现有功能回归（不碰 Illustrator、不改用户文档）。

素材是历史诊断日志里存下来的「原始路径轮廓」，直接回放
/api/recover/geometry → /api/recover/match，验证已经修好的能力没有回退：

  两行英文   行首幻觉点裁剪 + 整行识别
  三行英文   行分界 + 字体推荐
  俄语长文   自动切到东斯拉夫模型（日志里是修复前的拉丁乱码）
  超粗装饰字 硬间隙分行 + 字体推荐

另外检查服务健康检查、字体索引、诊断日志三个基础接口。
用法：python scripts/verify-release.py [--case 121909] [--keep-report]
"""
import argparse
import glob
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

CASES = [
    {
        "key": "121909",
        "tag": "两行英文 / 行首幻觉裁剪",
        "expect": {"lines": 2, "bands": 2, "fontTop": "MiSans", "minScore": 0.85},
        "truth": [
            "When using the steam function, do not place your fingers",
            "on the ridged area of the water tank.",
        ],
    },
    {
        # 用户报的「字体不对」案例：细体、窄身、正体的英文说明文字。
        # 老算法把整行同时拉到 1024×96 再算余弦，字宽/字重信息全被抹掉，
        # 结果把细体正体推成了 Franklin Gothic Heavy Italic（粗斜体）。
        # 现在：① 4 倍分辨率渲染，OCR 的 outiook→outlook、reaa?→? ；
        #      ② 候选排序加字宽/字重/倾斜一致性核对；
        #      ③ 倾斜改硬门槛（正体稿不再出现斜体候选）。
        "key": "091907",
        "tag": "细体窄身英文 / 字体纠正",
        "expect": {"lines": 3, "bands": 3},
        "mustContain": ["outlook.com"],
        "mustNotContain": ["outiook", "reaa"],
        "fontNotItalic": True,
    },
    {
        # 同上（修好之前）的日志是 16 条行带把两行粘在一起、文字是拉丁乱码。
        # 修复后真实基线是 18 行西里尔文本，回归按修复后结果断言。
        "key": "144316",
        "tag": "18 行俄语长文 / 自动语种切换",
        "expect": {"lines": 18, "bands": 18, "cyrillic": 0.12, "fontTop": "MiSans", "minScore": 0.85},
    },
    {
        # 同理，日志里 1 行是超粗装饰字被误粘的结果；加全白硬间隙后正确分成 2 行，
        # 字体从 Gabriola 0.7892 提到华文琥珀 0.9962。装饰字形的文字内容本身
        # OCR 无法还原（面板有「粘贴整句回填」兜底），这里只验分行与字体。
        "key": "144828",
        "tag": "装饰字 / 全白硬间隙分行",
        "expect": {"lines": 2, "bands": 2, "fontTop": "华文琥珀", "minScore": 0.95},
    },
    {
        "key": "145847",
        "tag": "三行英文 / 字体匹配",
        "expect": {"lines": 3, "bands": 3, "fontTop": "HarmonyOS Sans", "minScore": 0.85},
        "truth": [
            "Manufacturer: Guangzhou Welltop Intelligent Appliance Co., Ltd",
            "Address: Room 701-706, Building 3, No. 539 Shibei Gongye Road,",
            "Dashi Street, Panyu District, Guangzhou, Guangdong, China",
        ],
    },
    {
        # 整块文字被旋转 180°：OCR 从 0.93 崩到 0.28，字体 / 字号 / 位置
        # 全被乱码带偏，用户一次报五个问题。按用户决定**不做自动摆正**，
        # 只验：① 能识别出来「这是倒转稿」；② 翻正后读到的原文完整；
        # ③ 正常稿不会被误判；④ 字体最高分确实低到该标「不可信」。
        "key": "100814",
        "tag": "180° 倒转稿 / 低置信度自检",
        "expect": {"lines": 2, "bands": 2, "fontUnreliable": 0.7},
        "expectFlipped": True,
        "flipMustContain": [
            "Forbidden to be used by children",
            "Please keep away from water",
        ],
    },
]


def get(path, timeout=15):
    with OPENER.open(API + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def post(path, data, timeout=300):
    q = urllib.request.Request(
        API + path,
        data=json.dumps(data).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with OPENER.open(q, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def cyrillic_ratio(text):
    if not text:
        return 0.0
    hits = sum(1 for c in text if "\u0400" <= c <= "\u04ff")
    return hits / max(1, sum(1 for c in text if not c.isspace()))


def load_case(key):
    hits = glob.glob(os.path.join(ROOT, "data", "feedback", "FD-*%s.json" % key))
    if not hits:
        raise RuntimeError("找不到诊断日志：%s" % key)
    d = json.load(open(hits[0], encoding="utf-8"))
    g = d.get("context", {}).get("geom", {})
    if not g.get("shapes"):
        raise RuntimeError("日志里没有原始轮廓：%s" % key)
    return os.path.basename(hits[0]), g


def check_case(case):
    name, g = load_case(case["key"])
    exp = case["expect"]
    payload = {
        "shapes": g["shapes"],
        "w": g["w"],
        "h": g["h"],
        "scale": g.get("scale", 4),
        "originX": g.get("originX", 0),
        "originY": g.get("originY", 0),
        "ptsW": g.get("ptsW", 0),
        "ptsH": g.get("ptsH", 0),
        "textFrames": g.get("textFrames", 0),
    }

    t0 = time.time()
    d = post("/api/recover/geometry", payload)
    t_geom = time.time() - t0
    problems = []
    if not d.get("ok"):
        return {"name": name, "tag": case["tag"], "ok": False,
                "problems": ["geometry 返回失败：%s" % d.get("error")],
                "geomMs": int(t_geom * 1000), "fontMs": 0, "top": "-", "lines": []}

    lines = d.get("lines") or []
    texts = [str(l.get("text") or "").strip() for l in lines]
    bands = d.get("bands") or []
    skew = d.get("skew")

    if len(bands) != exp["bands"]:
        problems.append("行分界 %d 条，期望 %d 条" % (len(bands), exp["bands"]))
    if len(lines) != exp["lines"]:
        problems.append("识别 %d 行，期望 %d 行" % (len(lines), exp["lines"]))
    if skew:
        problems.append("水平稿被误判为倾斜并摆正（%s°）" % skew.get("angle"))

    # 180° 倒转自检：只在低置信度时触发，正常稿不能被误判
    likely = bool(d.get("likelyFlipped180"))
    if case.get("expectFlipped"):
        if not likely:
            problems.append("倒转稿未触发 180° 自检（ocrAvg=%s flipAvg=%s）"
                            % (d.get("ocrAvg"), d.get("flipAvg")))
        else:
            ft = str(d.get("flipText") or "")
            for kw in case.get("flipMustContain", []):
                if kw not in ft:
                    problems.append("翻正文本缺少 %r：%r" % (kw, ft[:120]))
            if float(d.get("flipAvg") or 0) < 0.75:
                problems.append("翻正 OCR 平均分过低：%s" % d.get("flipAvg"))
    elif likely:
        problems.append("正常稿被误判为 180° 倒转")

    if case.get("truth"):
        # 允许比对时忽略首尾空白；OCR 是确定性模型，正常应逐行完全一致
        for i, want in enumerate(case["truth"]):
            got = texts[i] if i < len(texts) else ""
            if got != want:
                problems.append("行%d 文本不一致：%r" % (i + 1, got[:64]))
    joined = " ".join(texts)
    for kw in case.get("mustContain", []):
        if kw not in joined:
            problems.append("文本缺少 %r：%s" % (kw, joined[:120]))
    for kw in case.get("mustNotContain", []):
        if kw in joined:
            problems.append("文本仍含错误片段 %r：%s" % (kw, joined[:120]))
    if "cyrillic" in exp:
        joined = " ".join(texts)
        ratio = cyrillic_ratio(joined)
        engines = sorted({str(l.get("engine") or "") for l in lines} - {""})
        if ratio < exp["cyrillic"]:
            problems.append("西里尔占比 %.3f < %.3f（疑似退回中英模型）" % (ratio, exp["cyrillic"]))
        if "ru" not in engines:
            problems.append("未切到 ru 引擎（engines=%s）" % (engines or "空"))

    # 字体匹配：整行轮廓比对，按墨迹面积加权
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
    top, t_font = "-", 0.0
    if targets and d.get("png"):
        t1 = time.time()
        m = post("/api/recover/match", {"png": d["png"], "chars": [], "lines": targets})
        t_font = time.time() - t1
        cands = m.get("candidates") or []
        if not m.get("ok") or not cands:
            problems.append("字体匹配失败：%s" % m.get("error"))
        elif not (m.get("best") or {}).get("score"):
            problems.append("字体候选分数全 0")
        else:
            b = cands[0]
            top = "%s %s %.4f" % (b.get("familyZh") or b.get("family"),
                                  b.get("subfamily") or "", b.get("score") or 0)
            if exp.get("fontTop") and exp["fontTop"] not in top:
                problems.append("字体第一名应为 %s，实得 %s" % (exp["fontTop"], top))
            if exp.get("minScore") and (b.get("score") or 0) < exp["minScore"]:
                problems.append("字体最高分 %.4f < %.4f" % (b.get("score") or 0, exp["minScore"]))
            if exp.get("fontUnreliable") and (b.get("score") or 0) >= exp["fontUnreliable"]:
                problems.append("倒转稿字体最高分 %.4f 应低于 %.2f（不可信标注依据）"
                                % (b.get("score") or 0, exp["fontUnreliable"]))
            if exp.get("fontNotItalic"):
                nm = top.lower()
                if any(k in nm for k in ("italic", "oblique")):
                    problems.append("原稿是正体，第一名却是斜体：%s" % top)
                if any(k in nm for k in ("heavy", "black", "extrabold", "ultrabold")):
                    problems.append("原稿是细体，第一名却是超粗：%s" % top)
    else:
        problems.append("没有可参与字体比对的行")

    return {
        "name": name, "tag": case["tag"], "ok": not problems,
        "problems": problems, "geomMs": int(t_geom * 1000),
        "fontMs": int(t_font * 1000), "top": top.strip(),
        "lines": texts, "bands": len(bands), "skew": bool(skew),
        "flip": likely, "ocrAvg": d.get("ocrAvg"), "flipAvg": d.get("flipAvg"),
    }


def check_base(keep_report):
    out = []

    def add(tag, ok, detail):
        out.append((tag, ok, detail))

    try:
        h = get("/api/health")
        add("服务健康", bool(h.get("ok")) and h.get("faces", 0) > 0,
            "%d face / %s" % (h.get("faces", 0), h.get("generatedAt", "?")))
    except Exception as e:
        add("服务健康", False, str(e))

    try:
        f = get("/api/families?limit=1")
        n = len(f.get("families") or f.get("items") or [])
        add("字体索引", bool(f.get("ok", True)), "接口可用，返回 %d 条" % n)
    except Exception as e:
        add("字体索引", False, str(e))

    try:
        ins = get("/api/installed")
        add("已安装台账", bool(ins.get("ok", True)), "接口可用")
    except Exception as e:
        add("已安装台账", False, str(e))

    try:
        rep = post("/api/feedback/report", {
            "issues": ["回归自检"],
            "note": "verify-release.py 自动生成（可删）",
            "appVersion": "regression",
            "uiVersion": "regression",
            "context": {
                "geom": {"w": 100, "h": 40, "shapeCount": 3, "scale": 4},
                "recognize": {"lines": [{"text": "自检", "score": 1, "box": {"l": 0, "t": 0, "r": 10, "b": 10}}],
                              "bands": [[0, 40]], "stats": {"rows": 1, "chars": 2}},
            },
        }, timeout=20)
        txt = str(rep.get("text") or "")
        need = ["--- 几何 / 输入 ---", "--- 识别 ---", "--- 字体 ---", "--- 排版整理 trace"]
        miss = [x for x in need if x not in txt]
        add("诊断日志", bool(rep.get("ok")) and not miss,
            "生成 %s，缺段：%s" % (rep.get("id"), miss or "无"))
        if not keep_report and rep.get("jsonPath") and rep.get("txtPath"):
            for p in (rep["jsonPath"], rep["txtPath"]):
                try:
                    os.remove(p)
                except OSError:
                    pass
    except Exception as e:
        add("诊断日志", False, str(e))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", help="只跑某个样本（日志 ID 片段）")
    ap.add_argument("--keep-report", action="store_true", help="保留自检生成的诊断日志")
    args = ap.parse_args()

    print("FontDeck 回归 @ %s\n" % API)
    base = check_base(args.keep_report)
    for tag, ok, detail in base:
        print("  [%s] %-12s %s" % ("✓" if ok else "✗", tag, detail))

    print("\n--- 历史稿回放（原始轮廓） ---")
    cases = [c for c in CASES if not args.case or args.case in c["key"]]
    failed = sum(1 for _, ok, _ in base if not ok)
    for c in cases:
        try:
            r = check_case(c)
        except Exception as e:
            failed += 1
            print("  [✗] %s  异常：%s" % (c["tag"], e))
            continue
        print("  [%s] %s  %s" % ("✓" if r["ok"] else "✗", c["tag"], r["name"]))
        print("       bands=%d 倾斜=%s 识别 %dms / 字体 %dms  Top1 %s"
              % (r["bands"], "是" if r["skew"] else "否",
                 r["geomMs"], r["fontMs"], r["top"]))
        if r.get("flip"):
            print("       180° 倒转已检出：原图 %s / 翻正 %s，翻正原文已交给面板"
                  % (r.get("ocrAvg"), r.get("flipAvg")))
        for t in r["lines"][:3]:
            print("       " + t[:88])
        for p in r["problems"]:
            print("       ! " + p)
        if not r["ok"]:
            failed += 1

    print("\n%s（%d 项未通过）" % ("全部通过" if failed == 0 else "存在回归", failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
