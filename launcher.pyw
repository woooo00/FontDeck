"""
FontDeck service launcher.

Why this file exists
--------------------
Starting the Node service directly from a console host leaves a console window
behind: `DETACHED_PROCESS` and `CREATE_NO_WINDOW` conflict in libuv, so the
child can still get attached to Windows Terminal and show a window that never
closes on its own.

This script is meant to be run with pythonw.exe (GUI subsystem, no console at
all). It starts the service with CREATE_NO_WINDOW and exits immediately, so no
console window is ever created anywhere in the chain.

Usage:
    pythonw.exe launcher.pyw        (silent, no window)
    python.exe  launcher.pyw        (shows diagnostics, for testing)
"""

import http.client
import os
import subprocess
import sys
import time

ROOT = r"C:\Users\6\WorkBuddy\2026-11-09-14-23-57\fontdeck"
PORT = int(os.environ.get("FONTDECK_PORT", "47615"))
NODE_EXE = r"C:\Users\6\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
TSX = os.path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")
ENTRY = os.path.join(ROOT, "apps", "service", "src", "main.ts")
LOG = os.path.join(ROOT, "data", "service.log")

CREATE_NO_WINDOW = 0x08000000
DETACHED_PROCESS = 0x00000008
# 父进程常被宿主放进 Windows Job 对象里（命令行工具、IDE、CEP 都这样）。
# Job 一结束，里面的子进程会被一并杀掉 —— 表现就是「服务刚起来能探活，
# 过几秒就没了」，日志里还完全没有错误。让服务脱离这个 Job 才能长期驻留。
CREATE_BREAKAWAY_FROM_JOB = 0x01000000


def spawn(flags):
    with open(LOG, "ab") as log:
        return subprocess.Popen(
            [NODE_EXE, TSX, ENTRY],
            cwd=ROOT,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=log,
            # CREATE_NO_WINDOW: no console window at all.
            # Do not combine with DETACHED_PROCESS - the two flags conflict.
            creationflags=flags,
            close_fds=True,
        )


def service_alive(tries=2):
    """Ask the local service before spawning another one.

    Illustrator starts this launcher on every launch. Without the check, a
    second Node process boots, rescans 781 font faces, notices EADDRINUSE and
    exits -- pure noise in service.log. A short direct HTTP call (no proxy)
    is enough to tell whether a healthy FontDeck is already listening.

    Two tries: right after a restart the old process can still hold the port
    for a moment while it is on its way out. Probing once would then report
    "already running", skip the launch, and leave nothing listening.
    """
    for attempt in range(tries):
        try:
            conn = http.client.HTTPConnection("127.0.0.1", PORT, timeout=0.8)
            conn.request("GET", "/api/health")
            resp = conn.getresponse()
            body = resp.read(256)
            conn.close()
            if resp.status == 200 and b'"ok":true' in body:
                return True
        except Exception:
            pass
        if attempt + 1 < tries:
            time.sleep(1.2)
    return False


# Debug PNGs pile up one per recognition. Never touch the feedback logs or
# the font index -- only these known throwaway prefixes are eligible, and
# only when they are both old and beyond the recent-files window.
CACHE_PREFIXES = ("recover-debug-", "geom-", "scan-", "skew-", "cmp-", "crop-", "ui-", "user-")
CACHE_KEEP = 120
CACHE_MAX_AGE_DAYS = 7


def prune_debug_images():
    dirs = [
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "FontDeck", "recover"),
        os.path.join(ROOT, "data"),
    ]
    found = []
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for name in os.listdir(d):
            if not name.lower().endswith(".png") or not name.startswith(CACHE_PREFIXES):
                continue
            p = os.path.join(d, name)
            try:
                found.append((os.stat(p).st_mtime, p))
            except OSError:
                pass
    found.sort(reverse=True)
    cutoff = time.time() - CACHE_MAX_AGE_DAYS * 86400
    for mtime, p in found[CACHE_KEEP:]:
        if mtime < cutoff:
            try:
                os.remove(p)
            except OSError:
                pass


def main():
    for path in (NODE_EXE, TSX, ENTRY):
        if not os.path.exists(path):
            if sys.stderr:
                sys.stderr.write("missing: %s\n" % path)
            return 1

    os.makedirs(os.path.dirname(LOG), exist_ok=True)

    # Already running (e.g. Illustrator was reopened): do nothing, stay silent.
    if service_alive():
        return 0

    prune_debug_images()

    # 不在 Job 里时这个标志会被系统忽略；Job 禁止 breakaway 时 CreateProcess
    # 会失败，退回不带标志的调用（至少还能在当前会话内正常工作）。
    try:
        spawn(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
    except OSError:
        spawn(CREATE_NO_WINDOW)

    if sys.stderr:
        sys.stderr.write("service spawned\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
