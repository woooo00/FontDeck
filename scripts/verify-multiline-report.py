"""同一会话内验证两件事：多行整行识别、诊断日志生成。

需要先启动服务：python launcher.pyw && sleep 9
用法: python scripts/verify-multiline-report.py
"""
import sys

import cv2

sys.path.insert(0, "scripts")
from probe_trace import post, split_columns  # noqa: E402

PNG = "C:/Users/6/AppData/Local/FontDeck/recover/geom-1794282776133.png"
EXPECT = [
    "2. When not in use, disconnect the appliance and store in a safe and",
    "dry location. Keep out of the reach of children. Do not wrap the",
    "cord around the appliance.",
]


def main():
    img = cv2.imread(PNG)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    boxes = split_columns(gray)
    bands = [[0, 40], [40, 74], [74, 114]]

    d = post(
        "/api/recover/recognize",
        {
            "png": PNG,
            "pngW": img.shape[1],
            "pngH": img.shape[0],
            "scale": 4,
            "originX": 0,
            "originY": 0,
            "ptsW": 0,
            "ptsH": 0,
            "textFrames": 0,
            "shapeCount": len(boxes),
            "shapes": boxes,
            "bands": bands,
        },
    )

    lines = d.get("lines") or []
    print("聚类行数 =", (d.get("stats") or {}).get("rows"))
    for i, l in enumerate(lines):
        print("  行%d  %.3f  %r" % (i + 1, l.get("score") or 0, l.get("text")))
    got = [l.get("text") for l in lines]
    print("多行识别:", "PASS" if got == EXPECT else "FAIL")

    rep = post(
        "/api/feedback/report",
        {
            "issues": ["识别不出 / 卡住没反应", "字体不对"],
            "note": "联调测试：三行英文说明书",
            "appVersion": "29.6",
            "uiVersion": "v16",
            "serviceGeneratedAt": "selftest",
            "context": {
                "geom": {
                    "w": img.shape[1],
                    "h": img.shape[0],
                    "scale": 4,
                    "shapeCount": len(boxes),
                    "textFrames": 0,
                },
                "recognize": d,
                "font": {
                    "mode": "line",
                    "durationMs": 2554,
                    "candidates": [
                        {"family": "MiSans", "subfamily": "Normal", "score": 0.9569, "rel": 100}
                    ],
                },
                "apply": {
                    "ok": True,
                    "created": 3,
                    "rows": 3,
                    "font": "MiSans-Regular",
                    "calib": {"size": 7.5, "tracking": 0, "actualW": 245.5, "targetW": 245.5},
                    "errors": [],
                },
                "ui": {"lineText": "\n".join(EXPECT), "fontName": "MiSans-Regular"},
            },
        },
    )
    print("\n日志 id =", rep.get("id"), " 文本行数 =", len((rep.get("text") or "").splitlines()))
    print("--- 日志预览 ---")
    print("\n".join((rep.get("text") or "").splitlines()[:26]))
    return 0 if got == EXPECT and rep.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
