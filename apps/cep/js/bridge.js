/*
 * FontDeck 桥接：把 iframe 里的 ExtendScript 请求转给顶层页执行。
 *
 * 为什么必须有这一层：
 * 面板 UI 跑在 iframe 里（页面由本地服务 http://127.0.0.1:47615 提供，
 * 这样改界面不用重装扩展）。但 CEP 的 window.__adobe_cep__ 只在**顶层扩展页**
 * 真正绑定到 Host —— 在跨源 iframe 里它对象存在、调用也不抛错，
 * 回调却永远不回来。表现就是面板点了按钮干等，最后超时。
 *
 * 所以：iframe 用 postMessage 把 JSX 代码发上来，这里执行，结果再发回去。
 */
(function () {
    "use strict";

    var TAG = "__fontdeck_bridge__";

    function post(win, payload) {
        try {
            win.postMessage(payload, "*");
        } catch (e) {
            /* 窗口已经没了，忽略 */
        }
    }

    window.addEventListener("message", function (e) {
        var d = e.data;

        /* 只认自家协议，别把别的消息当命令执行 */
        if (!d || d.tag !== TAG) return;

        /*
         * 来源校验不用 origin 而用 window 引用：
         * CEP 的 CEF 在 file:// 顶层页面下，postMessage 的 event.origin
         * 有时是 "file://" 有时是空串，按 origin 过滤会把自己的消息挡掉。
         * e.source === 自家 frame 的 contentWindow，这个判断更准也更严 ——
         * 只有我们加载的那个页面能往这里发命令。
         */
        var frameEl = document.getElementById("frame");
        if (!frameEl || e.source !== frameEl.contentWindow) return;

        /* iframe 加载完问一句「桥在不在」，好让它立刻知道结果，不用等超时 */
        if (d.type === "hello") {
            post(e.source, { tag: TAG, type: "ready" });
            return;
        }

        /*
         * 打开外部链接。
         *
         * CEP 的 window.open 会被拦（面板里点了没反应），必须走宿主接口。
         * 只放行 http/https —— 这个通道能把任意字符串交给系统默认浏览器，
         * 不限制协议等于给了一个 file:// 或自定义协议的入口。
         */
        if (d.type === "openUrl") {
            var target = String(d.url || "");
            if (!/^https?:\/\//i.test(target)) return;
            try {
                if (window.__adobe_cep__ && typeof window.__adobe_cep__.openURLInDefaultBrowser === "function") {
                    window.__adobe_cep__.openURLInDefaultBrowser(target);
                }
            } catch (err) { /* 宿主不支持就算了，前端有复制地址的兜底 */ }
            /* 回执：前端靠它判断「到底是打开了，还是这条消息被丢了」。
               旧版桥接没有这个分支，前端会超时降级成显示地址。 */
            post(e.source, { tag: TAG, type: "openUrlDone", url: target });
            return;
        }

        if (d.type !== "jsx") return;

        var src = e.source;
        var id = d.id;

        if (!window.__adobe_cep__ || typeof window.__adobe_cep__.evalScript !== "function") {
            post(src, { tag: TAG, type: "jsxResult", id: id, error: "顶层页面没有 CEP 桥" });
            return;
        }

        try {
            window.__adobe_cep__.evalScript(String(d.code || ""), function (raw) {
                post(src, {
                    tag: TAG,
                    type: "jsxResult",
                    id: id,
                    value: String(raw == null ? "" : raw)
                });
            });
        } catch (err) {
            post(src, { tag: TAG, type: "jsxResult", id: id, error: String(err) });
        }
    });
})();
