"""用无头 Edge 按 CEP 面板宽度截图，肉眼核对窄屏排版。

两张图：
  ui-filters.png  字体库分类栏是否换行成两排、后面标签是否都能看到
  ui-progress.png 恢复页进度条（临时把 hidden 去掉并设成 62%，截完还原）

Edge 在本机是唯一现成的无头浏览器；--force-device-scale-factor=1
是为了绕开系统 125% 缩放，让 420px 窗口真的等于 420px 视口。
"""
import pathlib
import shutil
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "apps" / "web"
OUT = ROOT / "data"
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
BASE = "http://127.0.0.1:47615/"


def shot(url, name, tag, dpr=1):
    profile = pathlib.Path.home() / "AppData" / "Local" / "Temp" / ("fd-shot-" + tag)
    if profile.exists():
        shutil.rmtree(profile, ignore_errors=True)
    cmd = [
        EDGE,
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--no-proxy-server",
        "--hide-scrollbars",
        "--force-device-scale-factor=" + str(dpr),
        "--window-size=420,900",
        "--virtual-time-budget=6000",
        f"--user-data-dir={profile}",
        f"--screenshot={OUT / name}",
        url,
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=120)
    ok = (OUT / name).exists()
    print(f"{name}: exit={r.returncode} file={ok} size={(OUT / name).stat().st_size if ok else 0}")


def main():
    shot(BASE, "ui-filters.png", "filters")
    # 1.5 倍设备像素比 → CSS 视口约 280px，模拟更窄的 CEP 面板
    shot(BASE, "ui-filters-narrow.png", "narrow", dpr=1.5)

    # 临时把进度条显示成「渲染与识别 62%」，截完立刻还原源文件
    index = WEB / "index.html"
    original = index.read_text(encoding="utf-8")
    staged = (
        original.replace('class="rec-progress" hidden', 'class="rec-progress"')
        .replace(
            'id="recProgressBar" class="rec-progress-bar"',
            'id="recProgressBar" class="rec-progress-bar" style="width:62%"',
        )
        .replace('id="recProgressText">准备中', 'id="recProgressText">渲染与识别')
        .replace('id="recProgressPct">0%', 'id="recProgressPct">62%')
    )
    index.write_text(staged, encoding="utf-8")
    try:
        shot(BASE + "#recover", "ui-progress.png", "progress")
    finally:
        index.write_text(original, encoding="utf-8")
        print("index.html 已还原:", index.read_text(encoding="utf-8") == original)

    # 临时把「排版整理」的状态栏设成成功态，核对色块在窄面板里不溢出
    staged2 = original.replace(
        '<div id="recLayoutStatus" class="rec-status"></div>',
        '<div id="recLayoutStatus" class="rec-status is-ok">'
        "已拆成 3 个文本框，位置按合并前的原始位置还原，"
        "在图层「FontDeck · 拆分结果」</div>",
    )
    index.write_text(staged2, encoding="utf-8")
    try:
        shot(BASE + "#recover", "ui-layout-status.png", "layout")
    finally:
        index.write_text(original, encoding="utf-8")
        print("index.html 已还原(2):", index.read_text(encoding="utf-8") == original)


if __name__ == "__main__":
    main()
