"""
FontDeck P0 辅助：解析本机字体文件，提取 PostScript 名 / family / 中文名。
用于和 Illustrator 探针导出的 tsv 做交集，判断 AI 是否识别用户级字体。

输出：fontdeck/docs/local-fonts.json
"""

import json
import os
import sys
from pathlib import Path

from fontTools.ttLib import TTFont, TTCollection

SKIP_EXT = {".fon", ".compositefont", ".rar", ".ini", ".xml", ".txt"}

USER_FONT_DIR = Path(os.environ["LOCALAPPDATA"]) / "Microsoft" / "Windows" / "Fonts"
SYS_FONT_DIR = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"


def pick(records, name_id, prefer_langs=(0x0804, 0x0409)):
    """从 name 记录里挑一个：优先简体中文(0x804)，其次英文(0x409)。"""
    cands = [r for r in records if r.nameID == name_id]
    if not cands:
        return None
    for lang in prefer_langs:
        for r in cands:
            if r.platformID == 3 and r.langID == lang:
                try:
                    return r.toUnicode()
                except Exception:
                    pass
    for r in cands:
        try:
            return r.toUnicode()
        except Exception:
            continue
    return None


def face_info(font, source_file, index):
    names = font["name"].names
    ps = pick(names, 6) or ""
    family = pick(names, 16) or pick(names, 1) or ""
    subfamily = pick(names, 17) or pick(names, 2) or ""
    zh_family = None
    for r in names:
        if r.nameID in (1, 4, 16) and r.platformID == 3 and r.langID == 0x0804:
            try:
                zh_family = r.toUnicode()
                break
            except Exception:
                continue

    os2 = font["OS/2"] if "OS/2" in font else None
    weight = getattr(os2, "usWeightClass", None) if os2 else None
    is_fixed = None
    try:
        is_fixed = bool(font["post"].isFixedPitch)
    except Exception:
        pass

    has_cjk = False
    try:
        cmap = font.getBestCmap()
        has_cjk = 0x6C38 in cmap or 0x4E2D in cmap  # 永 / 中
    except Exception:
        pass

    return {
        "postScriptName": ps,
        "family": family,
        "subfamily": subfamily,
        "familyZh": zh_family,
        "weightClass": weight,
        "isFixedPitch": is_fixed,
        "hasCJK": has_cjk,
        "collectionIndex": index,
        "file": str(source_file),
    }


def parse_file(path: Path):
    ext = path.suffix.lower()
    if ext in SKIP_EXT:
        return None
    out = []
    try:
        if ext in (".ttc", ".otc"):
            coll = TTCollection(str(path), lazy=True)
            for i, f in enumerate(coll.fonts):
                out.append(face_info(f, path, i))
            coll.close()
        else:
            f = TTFont(str(path), lazy=True, fontNumber=0)
            out.append(face_info(f, path, 0))
            f.close()
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}", "file": str(path)}
    return out


def scan(folder: Path, scope: str):
    faces = []
    errors = []
    skipped = []
    if not folder.exists():
        return faces, errors, skipped
    for p in sorted(folder.iterdir()):
        if not p.is_file():
            continue
        if p.suffix.lower() in SKIP_EXT:
            skipped.append({"file": str(p), "reason": p.suffix.lower()})
            continue
        r = parse_file(p)
        if r is None:
            continue
        if isinstance(r, dict) and "error" in r:
            errors.append(r)
            continue
        for face in r:
            face["scope"] = scope
            faces.append(face)
    return faces, errors, skipped


def main():
    user_faces, user_err, user_skip = scan(USER_FONT_DIR, "user")
    sys_faces, sys_err, sys_skip = scan(SYS_FONT_DIR, "system")

    result = {
        "userFontDir": str(USER_FONT_DIR),
        "systemFontDir": str(SYS_FONT_DIR),
        "user": {"faces": len(user_faces), "errors": len(user_err), "skipped": len(user_skip)},
        "system": {"faces": len(sys_faces), "errors": len(sys_err), "skipped": len(sys_skip)},
        "userFaces": user_faces,
        "systemFaces": sys_faces,
        "errors": user_err + sys_err,
        "skipped": user_skip[:20] + sys_skip[:5],
    }

    out_path = Path(__file__).resolve().parent.parent / "docs" / "local-fonts.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"用户级字体 face 数: {len(user_faces)}")
    print(f"系统字体   face 数: {len(sys_faces)}")
    print(f"解析失败: {len(user_err) + len(sys_err)}")
    print(f"跳过(非字体格式): {len(user_skip) + len(sys_skip)}")
    print(f"输出: {out_path}")


if __name__ == "__main__":
    main()
