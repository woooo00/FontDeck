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
     * 安装根目录不再写死 —— 面板要装到别人的机器上去，写死路径等于只在这台机器能用。
     *
     * 解析顺序：
     *   1) %LOCALAPPDATA%\FontDeck\current 指针文件（安装脚本写的，内容为一个目录名或绝对路径）
     *   2) 旧版开发目录（本机回退，保证改造前后都能跑）
     *
     * 用指针文件而不是固定路径，是为了让「装新版本」变成改一行指针：
     * 新版本解压到 app\1.1.0，指针一改就切换，旧目录留着就能回滚。
     */
    var LEGACY_ROOT = "C:\\Users\\6\\WorkBuddy\\2026-11-09-14-23-57\\fontdeck";

    function localAppData() {
        try {
            if (typeof process !== "undefined" && process.env && process.env.LOCALAPPDATA) {
                return process.env.LOCALAPPDATA;
            }
        } catch (e) { /* 落到下面 */ }
        try {
            var req = nodeRequire();
            if (req) {
                return req("path").join(req("os").homedir(), "AppData", "Local");
            }
        } catch (e2) { /* ignore */ }
        return "";
    }

    function resolveRoot() {
        var req = nodeRequire();
        if (req) {
            try {
                var fs = req("fs");
                var path = req("path");
                var base = localAppData();
                if (base) {
                    var ptr = path.join(base, "FontDeck", "current");
                    if (fs.existsSync(ptr)) {
                        /* 指针是纯文本，可能被人手改过（正斜杠、多余分隔符、
                           行尾空格），先规整成 Windows 路径再判断 */
                        var raw = String(fs.readFileSync(ptr, "utf8") || "")
                            .replace(/^\s+|\s+$/g, "")
                            .replace(/\//g, "\\")
                            .replace(/\\{2,}/g, "\\")
                            .replace(/\\+$/, "");
                        if (raw) {
                            var full = path.isAbsolute(raw)
                                ? raw
                                : path.join(base, "FontDeck", "app", raw);
                            /* 指针有可能指向被手动删掉的目录，验一下再采用 */
                            if (fs.existsSync(path.join(full, "launcher.pyw"))) return full;
                        }
                    }
                }
            } catch (e) { /* 指针坏了就走回退 */ }
        }
        return LEGACY_ROOT;
    }

    var ROOT = resolveRoot();

    /*
     * 关键：启动器必须是 GUI 子系统程序（pythonw），不能直接 spawn node。
     * node.exe 是控制台程序，即使用 detached + windowsHide 拉起，
     * 在 Win11 上仍可能被 Windows Terminal 接管，留下一个不会自己关的窗口。
     * pythonw 本身没有控制台，它再用 CREATE_NO_WINDOW 拉起服务，全链路无窗口。
     *
     * 三种摆法都要认：安装版（<FontDeck>/runtime）、源码目录（<root>/runtime）、
     * 以及开发机上手工装的那套。
     */
    var PYTHONW = (function () {
        var req = nodeRequire();
        if (!req) return "C:\\Users\\6\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\pythonw.exe";
        try {
            var fs = req("fs");
            var path = req("path");
            var cands = [
                path.join(ROOT, "runtime", "python", "pythonw.exe"),
                path.join(ROOT, "..", "..", "runtime", "python", "pythonw.exe"),
                "C:\\Users\\6\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\pythonw.exe"
            ];
            for (var i = 0; i < cands.length; i++) {
                if (fs.existsSync(cands[i])) return cands[i];
            }
            return cands[0];
        } catch (e) {
            return "C:\\Users\\6\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\pythonw.exe";
        }
    })();
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
        /* 首次加载也带时间戳：CEP 的 Chromium 99 会缓存 iframe 的 "/" 响应，
           面板脚本升级后重启 AI 仍可能拿到旧副本（反复出现「改了没生效」）。
           时间戳 + 服务端 no-store 双保险，确保每次打开都是最新代码。 */
        frame.src = BASE + "/?t=" + Date.now();
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
