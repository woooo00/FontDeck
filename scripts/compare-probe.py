"""
FontDeck P0-A 判定脚本
对比 Illustrator 探针导出的 tsv 与本机字体索引，判断 AI 是否识别"用户级字体"。

用法：
  python compare-probe.py <桌面上的 ai-fonts-*.tsv>

判定规则：
  用户级可见率 = |AI 识别 ∩ 用户级| / |用户级|
  系统级可见率 = |AI 识别 ∩ 系统级| / |系统级|   （基准参考）
  - 用户级可见率 >= 0.9  -> GO：AI 认识用户级字体，走浏览器级安装方案
  - 0 < 可见率 < 0.9     -> PARTIAL：部分可见，需个案排查
  - 可见率 == 0          -> NO-GO：必须改用 AddFontResource 会话激活
"""

import json
import re
import sys
from pathlib import Path


def norm(name: str) -> str:
    return re.sub(r"[\s\-_]", "", (name or "").strip().lower())


def main():
    if len(sys.argv) < 2:
        print("用法: python compare-probe.py <ai-fonts-*.tsv>")
        sys.exit(1)

    tsv_path = Path(sys.argv[1])
    if not tsv_path.exists():
        print(f"文件不存在: {tsv_path}")
        sys.exit(1)

    index_path = Path(__file__).resolve().parent.parent / "docs" / "local-fonts.json"
    data = json.loads(index_path.read_text(encoding="utf-8"))

    ai_names = set()
    ai_raw = []
    lines = tsv_path.read_text(encoding="utf-8-sig", errors="replace").splitlines()
    for i, line in enumerate(lines):
        if i == 0:
            continue
        parts = line.split("\t")
        if parts and parts[0].strip():
            ai_names.add(norm(parts[0]))
            ai_raw.append(parts[0].strip())

    user_faces = data["userFaces"]
    sys_faces = data["systemFaces"]

    user_ps = {norm(f["postScriptName"]): f for f in user_faces if f["postScriptName"]}
    sys_ps = {norm(f["postScriptName"]): f for f in sys_faces if f["postScriptName"]}

    user_hit = [k for k in user_ps if k in ai_names]
    sys_hit = [k for k in sys_ps if k in ai_names]

    u_rate = len(user_hit) / len(user_ps) if user_ps else 0
    s_rate = len(sys_hit) / len(sys_ps) if sys_ps else 0

    print("=" * 56)
    print("FontDeck P0-A 判定结果")
    print("=" * 56)
    print(f"AI 导出的字体数      : {len(ai_raw)}")
    print(f"本机用户级 face 数   : {len(user_ps)}")
    print(f"本机系统级 face 数   : {len(sys_ps)}")
    print(f"用户级命中           : {len(user_hit)}  ({u_rate:.1%})")
    print(f"系统级命中           : {len(sys_hit)}  ({s_rate:.1%})")
    print("-" * 56)

    if u_rate >= 0.9:
        verdict = "GO"
        msg = "AI 认识用户级字体。走「复制到 LocalAppData + 写 HKCU」方案，不需要管理员。"
    elif u_rate > 0:
        verdict = "PARTIAL"
        msg = "部分用户级字体可见，需排查是不是特定格式（.otf/.ttc）不被识别。"
    else:
        verdict = "NO-GO"
        msg = "AI 完全看不到用户级字体。必须改用 AddFontResource 会话激活方案。"

    print(f"判定: {verdict}")
    print(msg)
    print("=" * 56)

    if 0 < u_rate < 1:
        missing = [user_ps[k] for k in user_ps if k not in ai_names]
        print(f"\n未被 AI 识别的用户级字体（前 25 个，共 {len(missing)}）:")
        for f in missing[:25]:
            ext = Path(f["file"]).suffix.lower()
            zh = f" / {f['familyZh']}" if f.get("familyZh") else ""
            print(f"  [{ext:6}] {f['postScriptName']}  |  {f['family']}{zh}")

    out = Path(__file__).resolve().parent.parent / "docs" / "p0a-result.json"
    out.write_text(json.dumps({
        "aiFontCount": len(ai_raw),
        "userFaceCount": len(user_ps),
        "systemFaceCount": len(sys_ps),
        "userHit": len(user_hit),
        "systemHit": len(sys_hit),
        "userVisibleRate": round(u_rate, 4),
        "systemVisibleRate": round(s_rate, 4),
        "verdict": verdict,
        "message": msg,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n结果已写入: {out}")


if __name__ == "__main__":
    main()
