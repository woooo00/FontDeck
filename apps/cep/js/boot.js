/*
 * FontDeck 面板启动器
 *
 * 目标：用户不需要知道"服务"这个东西存在。
 * 打开面板 → 探活 → 没起就自己用 Node 拉起来（windowsHide，无窗口）→ 轮询 → 加载 UI。
 *
 * 为什么必须有服务进程：CEP 面板是 Chromium 沙盒，写不了注册表、也不能把文件
 * 放进系统字体目录。字体安装/卸载只能在沙盒外做。但这个进程不该让用户管。
 */
(function () {
    "use strict";

    var PORT = 47615;
    var BASE = "http://127.0.0.1:" + PORT;

    /*
     * 下面这些路径写死是有意的：面板运行在 CEP 沙盒里，
     * 拿不到项目根目录（扩展目录和项目目录不是一个地方）。
     * 换机器 / 换目录时只需要改这几行。
     */
    var ROOT = "C:\\Users\\6\\WorkBuddy\\2026-11-09-14-23-57\\fontdeck";

    /*
     * 关键：启动器必须是 GUI 子系统程序（pythonw），不能直接 spawn node。
     * node.exe 是控制台程序，即使用 detached + windowsHide 拉起，
     * 在 Win11 上仍可能被 Windows Terminal 接管，留下一个不会自己关的窗口。
     * pythonw 本身没有控制台，它再用 CREATE_NO_WINDOW 拉起服务，全链路无窗口。
     */
    var PYTHONW = "C:\\Users\\6\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\pythonw.exe";
    var LAUNCHER = ROOT + "\\launcher.pyw";

    var frame = document.getElementById("frame");
    var bootEl = document.getElementById("boot");
    var msgEl = document.getElementById("msg");
    var spinEl = document.getElementById("spin");

    var deadline = 0;
    var spawned = false;

    function setMsg(html) {
        if (msgEl) msgEl.innerHTML = html;
    }

    function showFrame() {
        frame.src = BASE + "/";
        frame.style.display = "block";
        bootEl.style.display = "none";
    }

    function showError(html) {
        if (spinEl) spinEl.style.display = "none";
        if (msgEl) msgEl.className = "msg err";

        /* 自动启动失败时把关键状态摊开，省得靠猜 */
        var diag =
            "<div style=\"margin-top:16px;font-size:11px;color:#a0a0aa;line-height:1.9;\">" +
            "Node 运行时：" + (nodeRequire() ? "可用" : "不可用") + "<br>" +
            "启动器：" + (nodeRequire() && nodeRequire()("fs").existsSync(LAUNCHER) ? "就绪" : "缺失") + "<br>" +
            "启动方式：" + (spawned ? "已静默调用，但服务没响应" : "未能调用静默通道") +
            "</div>";

        setMsg(html + diag);

        var retry = document.createElement("button");
        retry.textContent = "重试";
        retry.style.cssText =
            "margin-top:16px;padding:7px 18px;border:1px solid #d4d4da;" +
            "background:#fff;border-radius:7px;font-size:12px;cursor:pointer;" +
            "font-family:inherit;color:#5c5c66";
        retry.onclick = function () {
            retry.parentNode.removeChild(retry);
            if (spinEl) spinEl.style.display = "block";
            if (msgEl) msgEl.className = "msg";
            setMsg("正在连接字体服务…");
            begin();
        };
        bootEl.appendChild(retry);
    }

    function health() {
        return new Promise(function (resolve) {
            var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
            var timer = setTimeout(function () {
                if (ctrl) ctrl.abort();
            }, 1500);
            var init = ctrl ? { signal: ctrl.signal, cache: "no-store" } : { cache: "no-store" };
            fetch(BASE + "/api/health", init)
                .then(function (r) { return r.json(); })
                .then(function (d) {
                    clearTimeout(timer);
                    resolve(!!(d && d.ok));
                })
                .catch(function () {
                    clearTimeout(timer);
                    resolve(false);
                });
        });
    }

    /** 拿 CEP 自带的 Node 运行时（开 --enable-nodejs 后可用） */
    function nodeRequire() {
        try {
            if (window.cep_node && typeof window.cep_node.require === "function") {
                return window.cep_node.require;
            }
            if (typeof require === "function") return require;
        } catch (e) {
            /* ignore */
        }
        return null;
    }

    /** 静默拉起服务：经 pythonw 启动器，全链路不产生任何窗口 */
    function spawnSilently() {
        var req = nodeRequire();
        if (!req) return false;
        try {
            var fs = req("fs");
            var cp = req("child_process");
            if (!fs.existsSync(PYTHONW) || !fs.existsSync(LAUNCHER)) return false;

            var child = cp.spawn(PYTHONW, [LAUNCHER], {
                cwd: ROOT,
                detached: true,
                stdio: "ignore",
                windowsHide: true
            });
            child.unref();
            return true;
        } catch (e) {
            return false;
        }
    }

    /** 把启动环境写到文件，便于远程诊断（CEP Node 不可用时写不出来，本身也是信息） */
    function writeDiag(extra) {
        var req = nodeRequire();
        if (!req) return;
        try {
            var fs = req("fs");
            var info = {
                at: new Date().toISOString(),
                cepNode: true,
                cepBridge: !!window.__adobe_cep__,
                pythonwExists: fs.existsSync(PYTHONW),
                launcherExists: fs.existsSync(LAUNCHER),
                spawned: !!extra.spawned,
                reachable: !!extra.reachable,
                hostVersion: window.__adobe_cep__ ? String(window.__adobe_cep__.getHostEnvironment()) : null
            };
            fs.writeFileSync(ROOT + "\\data\\boot-diag.json", JSON.stringify(info, null, 2));
        } catch (e) {
            /* ignore */
        }
    }

    function poll() {
        health().then(function (ok) {
            if (ok) {
                writeDiag({ spawned: spawned, reachable: true });
                showFrame();
                return;
            }
            if (Date.now() > deadline) {
                writeDiag({ spawned: spawned, reachable: false });
                showError("字体服务没能自动启动。点重试再试一次，或者用下面的备用方式。");
                return;
            }
            setMsg(
                spawned
                    ? "正在启动字体库…（首次约 5 秒）"
                    : "正在连接字体服务…"
            );
            setTimeout(poll, 700);
        });
    }

    function begin() {
        health().then(function (ok) {
            if (ok) {
                showFrame();
                return;
            }
            /*
             * 只走静默通道。
             * 以前这里还有一条"自动调用 start-service.cmd"的兜底，
             * 但那条路会在任务栏留一个黑窗口（窗口就是服务本体，不会自己退），
             * 所以改成出错时由用户自己决定要不要用备用方式。
             */
            spawned = spawnSilently();
            writeDiag({ spawned: spawned, reachable: false });
            deadline = Date.now() + 30000;
            setTimeout(poll, 900);
        });
    }

    /*
     * 自愈：服务万一中途退出（崩溃、被清理、或用户关掉了控制台窗口），
     * 面板每分钟看一眼，没了就悄悄拉起来，再把界面刷新一次。
     * 有次数上限，避免服务本身坏掉时无限重启。
     */
    var restarts = 0;
    function watch() {
        setInterval(function () {
            if (restarts >= 5) return;
            health().then(function (ok) {
                if (ok) return;
                restarts++;
                spawnSilently();
                setTimeout(function () {
                    health().then(function (back) {
                        if (back) {
                            restarts = 0;
                            frame.src = BASE + "/?t=" + Date.now();
                        }
                    });
                }, 2500);
            });
        }, 60 * 1000);
    }

    begin();
    watch();
})();
