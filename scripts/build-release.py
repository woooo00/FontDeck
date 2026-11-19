"""打包 FontDeck 便携发行包。

为什么不用 pkg / node --experimental-sea 打成单个 exe
----------------------------------------------------
服务本身没有原生 addon，但依赖三样原生资产：koffi（FFI，调 Win32 装字体）、
@resvg 的 .node、以及一整个 Python 环境（RapidOCR 的 onnxruntime + opencv）。
SEA 只能塞一个 JS 入口，塞不了这些，还得自己解压到临时目录再改 DLL 搜索路径 ——
比直接发一个目录复杂得多，也更容易在杀软那里出问题。

所以走「便携运行时 + 目录解压」：
    <包>/app/      代码（每个版本一份，约 40MB）
    <包>/runtime/  node.exe + 便携 Python（所有版本共享，约 400MB）

分层的好处很实际：以后发 1.1.1 只需要下 app 那 40MB，
runtime 没变就不用重下；出问题换个目录指针就回滚。

用法：
    python scripts/build-release.py            # 完整打包
    python scripts/build-release.py --skip-npm # 复用上次的 node_modules（调试用）
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, "build")
DIST = os.path.join(BUILD, "dist")

# 开发机上跑这套东西用的运行时。打包时从这里取，避免依赖系统 PATH。
NODE_DIR = r"C:\Users\6\.workbuddy\binaries\node\versions\22.22.2-6"
NODE_EXE = os.path.join(NODE_DIR, "node.exe")
NPM_CLI = os.path.join(NODE_DIR, "node_modules", "npm", "bin", "npm-cli.js")
PY_BASE = r"C:\Users\6\.workbuddy\binaries\python\versions\3.13.12"
PY_SITE = r"C:\Users\6\.workbuddy\binaries\python\envs\default\Lib\site-packages"

# 运行时真正需要的依赖。原始 package.json 把 typescript / @types 也放在
# dependencies 里（类型检查用），打进去白占 35MB，这里只取运行时的。
RUNTIME_DEPS = {
    "@resvg/resvg-js": "^2.6.2",
    "fontkit": "^2.0.4",
    "koffi": "^3.3.7",
    "tsx": "^4.23.15",
}

# OCR 链路要的 Python 包。不用 pip 重装：版本必须与本机解释器严格一致
# （cp313 的二进制轮子），从现成环境复制比重新解析依赖更可靠。
PY_KEEP = [
    "cv2",
    "numpy",
    "numpy.libs",
    "onnxruntime",
    "PIL",
    "rapidocr_onnxruntime",
    "fontTools",
    "pyclipper",
    "shapely",
    "shapely.libs",
    "yaml",
    "_yaml",
    "six.py",
    "typing_extensions.py",
    "packaging",
    "flatbuffers",
    "google",
    "zhconv",
    "certifi",
    "charset_normalizer",
    "idna",
    "urllib3",
    "requests",
    "loguru",
    "win32_setctime",
]

# data 只带"重建面板要用的索引"，不带任何用户数据。
# feedback/ 里是用户稿件的截图和诊断，绝不能发到公开仓库的 Release 里。
DATA_KEEP = ["index.json", "neighbors.json", "similarity.json"]

PANEL_FILES = ["CSXS", "js", "host", "index.html", ".debug"]


def log(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def clean_dir(p):
    if os.path.isdir(p):
        shutil.rmtree(p, ignore_errors=True)
    os.makedirs(p, exist_ok=True)


def ignore_pycache(dirpath, names):
    drop = []
    for n in names:
        if n in ("__pycache__", ".pytest_cache", ".DS_Store"):
            drop.append(n)
        elif n.endswith((".pyc", ".pyo")):
            drop.append(n)
    return drop


def copy_tree(src, dst, extra_ignore=None):
    def _ignore(dirpath, names):
        out = ignore_pycache(dirpath, names)
        if extra_ignore:
            out += extra_ignore(dirpath, names)
        return out

    shutil.copytree(src, dst, ignore=_ignore, dirs_exist_ok=True)


def read_version():
    with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as f:
        return json.load(f)["version"]


def stage_node(stage):
    dst = os.path.join(stage, "runtime", "node")
    os.makedirs(dst, exist_ok=True)
    for name in ("node.exe",):
        shutil.copy2(os.path.join(NODE_DIR, name), os.path.join(dst, name))
    log("  node.exe  %.0f MB" % (os.path.getsize(os.path.join(dst, "node.exe")) / 1048576))


def stage_python(stage):
    """复制基础解释器 + 白名单 site-packages。

    不复制 venv：venv 里的 python.exe 只是个转发器，pyvenv.cfg 里写着
    base 解释器的绝对路径（C:\\Users\\6\\...），换台机器就找不到家了。
    直接搬基础安装 + 把包装进它的 Lib\\site-packages，才是一份能带走的 Python。
    """
    dst = os.path.join(stage, "runtime", "python")
    clean_dir(dst)

    # 解释器本体和它需要的 DLL
    for name in os.listdir(PY_BASE):
        if name.lower().endswith(".exe") or name.lower().endswith(".dll"):
            shutil.copy2(os.path.join(PY_BASE, name), os.path.join(dst, name))
    for name in ("DLLs",):
        copy_tree(os.path.join(PY_BASE, name), os.path.join(dst, name))

    # 标准库：去掉测试、GUI、打包相关，剩下的才是运行必需
    drop_lib = {
        "test",
        "idlelib",
        "tkinter",
        "turtledemo",
        "ensurepip",
        "lib2to3",
        "unittest",
        "distutils",
        "pydoc_data",
        "site-packages",
    }

    def lib_ignore(dirpath, names):
        if os.path.abspath(dirpath).lower() == os.path.abspath(os.path.join(PY_BASE, "Lib")).lower():
            return [n for n in names if n in drop_lib]
        return []

    copy_tree(os.path.join(PY_BASE, "Lib"), os.path.join(dst, "Lib"), extra_ignore=lib_ignore)

    # 三方包
    site_dst = os.path.join(dst, "Lib", "site-packages")
    os.makedirs(site_dst, exist_ok=True)
    missing = []
    for name in PY_KEEP:
        src = os.path.join(PY_SITE, name)
        if not os.path.exists(src):
            missing.append(name)
            continue
        if os.path.isdir(src):
            copy_tree(src, os.path.join(site_dst, name))
        else:
            shutil.copy2(src, os.path.join(site_dst, name))
    if missing:
        log("  ! site-packages 缺少: %s" % ", ".join(missing))

    total = sum(
        os.path.getsize(os.path.join(dp, f))
        for dp, _, fs in os.walk(dst)
        for f in fs
    )
    log("  python    %.0f MB" % (total / 1048576))


def stage_node_modules(stage, skip_npm):
    dst = os.path.join(stage, "app", "node_modules")
    if skip_npm and os.path.isdir(dst):
        log("  node_modules  跳过（复用）")
        return

    clean_dir(dst)
    # 在系统临时目录里按精简依赖装一遍，让 npm 自己解传递依赖 ——
    # 手抄依赖树最容易漏，尤其是 fontkit 那一串。
    # mkdtemp 而不是 build/_npm：装完有上千个文件，留在项目里既脏又要删除，
    # 放到 TEMP 下由系统清理更省事。
    tmp = tempfile.mkdtemp(prefix="fontdeck-npm-")
    with open(os.path.join(tmp, "package.json"), "w", encoding="utf-8") as f:
        json.dump({"name": "fontdeck-runtime", "version": "0.0.0", "dependencies": RUNTIME_DEPS}, f, indent=2)

    env = dict(os.environ)
    env["npm_config_audit"] = "false"
    env["npm_config_fund"] = "false"
    env["npm_config_loglevel"] = "error"
    # koffi 的 postinstall 会回调 `node`（构建原生部分）。开发机的 node 不在
    # PATH 里，不塞进去 install 会直接失败 —— 报错还是一句 'node' 不是内部命令。
    env["PATH"] = NODE_DIR + os.pathsep + env.get("PATH", "")
    log("  npm install ...（首次约 1 分钟）")
    proc = subprocess.run(
        [NODE_EXE, NPM_CLI, "install", "--omit=dev", "--no-audit", "--no-fund"],
        cwd=tmp,
        env=env,
        capture_output=True,
    )
    if proc.returncode != 0:
        log(proc.stdout.decode("utf-8", "replace")[-2000:])
        log(proc.stderr.decode("utf-8", "replace")[-2000:])
        raise SystemExit("npm install 失败")

    copy_tree(os.path.join(tmp, "node_modules"), dst)
    total = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(dst) for f in fs)
    log("  node_modules  %.0f MB" % (total / 1048576))


def stage_app(stage, skip_npm):
    app = os.path.join(stage, "app")
    os.makedirs(app, exist_ok=True)

    # 不清空整个 app：node_modules 装一次要一分钟，调试时反复重装没有意义。
    # 代码目录用覆盖复制，node_modules 交给下面的 --skip-npm 判断。
    for name in ("apps", "packages", "docs"):
        src = os.path.join(ROOT, name)
        if os.path.isdir(src):
            copy_tree(src, os.path.join(app, name))

    for name in ("launcher.pyw", "package.json", "tsconfig.json"):
        src = os.path.join(ROOT, name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(app, name))

    # 面板壳由安装脚本单独放到 CEP 目录，app 里不留一份，避免两处不一致
    shutil.rmtree(os.path.join(app, "apps", "cep"), ignore_errors=True)

    data_dst = os.path.join(app, "data")
    os.makedirs(data_dst, exist_ok=True)
    for name in DATA_KEEP:
        src = os.path.join(ROOT, "data", name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(data_dst, name))

    # 首次启动要能重建索引，但索引本身通常已经在包里，不给默认配置留死值
    with open(os.path.join(data_dst, "update.json"), "w", encoding="utf-8") as f:
        json.dump({"repo": "woooo00/FontDeck", "api": "", "check": True}, f, indent=2)

    stage_node_modules(stage, skip_npm)


def stage_panel(stage):
    src = os.path.join(ROOT, "apps", "cep")
    dst = os.path.join(stage, "panel")
    clean_dir(dst)
    for name in PANEL_FILES:
        s = os.path.join(src, name)
        if not os.path.exists(s):
            continue
        d = os.path.join(dst, name)
        if os.path.isdir(s):
            copy_tree(s, d)
        else:
            shutil.copy2(s, d)


def stage_scripts(stage, version):
    """安装脚本统一转成 CRLF。

    仓库里存的是 LF（git 会警告并自行转换），但 cmd.exe 解析 LF-only 的
    批处理时 goto/label 有概率失效 —— 恰恰是出错分支走不到，看起来"装完了"
    其实什么都没做。按二进制写，避免 Python 再插一手换行转换。
    """
    for name in ("install.cmd", "README.txt"):
        src = os.path.join(ROOT, "scripts", "release", name)
        raw = open(src, "rb").read().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
        raw = raw.replace(b"{VER}", version.encode("ascii"))
        with open(os.path.join(stage, name), "wb") as f:
            f.write(raw)

    # 安装脚本自己要知道版本号，写进一个小文件比在 cmd 里 sed 安全
    with open(os.path.join(stage, "VERSION"), "w", encoding="ascii") as f:
        f.write(version + "\n")

    # 小工具：写 CEP 的 PlayerDebugMode。未签名扩展靠它才能被加载，
    # 而 reg.exe 在部分公司镜像上是被拉黑的，所以用 Python 直接调 winreg。
    tools = os.path.join(stage, "tools")
    os.makedirs(tools, exist_ok=True)
    shutil.copy2(
        os.path.join(ROOT, "scripts", "release", "set-debug.py"),
        os.path.join(tools, "set-debug.py"),
    )


def make_zip(stage, version):
    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, "FontDeck-%s.zip" % version)
    if os.path.exists(out):
        os.remove(out)

    log("  压缩中（几百 MB，需要几分钟）...")
    base = os.path.dirname(stage)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for dp, _, fs in os.walk(stage):
            for f in fs:
                full = os.path.join(dp, f)
                arc = os.path.relpath(full, base)
                z.write(full, arc)
    log("  %s  %.0f MB" % (out, os.path.getsize(out) / 1048576))
    return out


def make_update_zip(stage, version):
    """增量包：只装 app + panel + VERSION，不带 runtime。

    首次安装必须用完整包（机器上还没有 Node/Python）。但已经装着 1.1.x 的机器
    更新时，runtime 一个字都没变，再下 350MB 纯属浪费流量和时间。
    这个包大约 40MB，面板内自动更新下的就是它。
    """
    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, "FontDeck-%s-update.zip" % version)
    if os.path.exists(out):
        os.remove(out)

    base = os.path.dirname(stage)
    top = os.path.basename(stage)
    keep_prefixes = ("app/", "panel/")
    keep_files = ("VERSION",)

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for dp, _, fs in os.walk(stage):
            for f in fs:
                full = os.path.join(dp, f)
                arc = os.path.relpath(full, base).replace("\\", "/")
                inner = arc[len(top) + 1:] if arc.startswith(top + "/") else arc
                if inner in keep_files or inner.startswith(keep_prefixes):
                    z.write(full, arc)

    log("  %s  %.0f MB" % (out, os.path.getsize(out) / 1048576))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-npm", action="store_true", help="复用已有 node_modules")
    ap.add_argument("--no-zip", action="store_true", help="只组包不压缩")
    ap.add_argument("--reuse-runtime", action="store_true", help="复用已复制好的 runtime，调试迭代用")
    args = ap.parse_args()

    version = read_version()
    stage = os.path.join(BUILD, "stage", "FontDeck-%s" % version)
    log("FontDeck %s 打包开始" % version)
    log("  目标 %s" % stage)

    reuse = args.reuse_runtime and os.path.isdir(os.path.join(stage, "runtime", "python"))
    if not reuse:
        clean_dir(stage)
        log("[1/5] 运行时 · Node")
        stage_node(stage)
        log("[2/5] 运行时 · Python")
        stage_python(stage)
    else:
        log("[1-2/5] 复用现有 runtime")

    log("[3/5] 应用代码与依赖")
    stage_app(stage, args.skip_npm)
    log("[4/5] 面板壳与安装脚本")
    stage_panel(stage)
    stage_scripts(stage, version)

    total = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(stage) for f in fs)
    log("  解压后总大小 %.0f MB" % (total / 1048576))

    if args.no_zip:
        log("完成（未压缩）")
        return
    log("[5/5] 压缩")
    make_zip(stage, version)
    make_update_zip(stage, version)
    log("完成")


if __name__ == "__main__":
    main()
