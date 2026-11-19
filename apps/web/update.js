/*
 * FontDeck 更新检查。
 *
 * 只做「发现新版本 → 提醒」，不擅自下载和替换任何文件。原因：
 * 面板壳在 %APPDATA%\Adobe\CEP\extensions 里，替换后必须重开 Illustrator
 * 才生效，这种事必须由用户自己决定什么时候做（他手上可能正开着稿子）。
 *
 * 探测放在前端而不是服务端：CEP 的 Chromium 走系统代理，Node 不走。
 * 国内机器上「浏览器能开 GitHub、Node 直连超时」是常态，所以这一步
 * 留在浏览器侧成功率更高。服务端只提供版本号和仓库地址
 * （见 main.ts 的 /api/update/info）。
 */
(function () {
  "use strict";

  var CHECK_INTERVAL = 6 * 60 * 60 * 1000;  /* 6 小时 */
  var FIRST_DELAY = 8000;                   /* 启动后 8 秒：等首屏扫描先跑完 */
  var TIMEOUT = 8000;
  var K_CHECKED = "fontdeck.update.checkedAt";
  var K_SKIP = "fontdeck.update.skip";

  var card = null;
  var running = false;

  /* ---------------------------------------------------------------- 版本比较 */

  function parseVer(s) {
    return String(s || "")
      .replace(/^v/i, "")
      .split(/[.+-]/)
      .slice(0, 3)
      .map(function (x) {
        return parseInt(x, 10) || 0;
      });
  }

  /** >0 表示 a 比 b 新 */
  function cmpVer(a, b) {
    var x = parseVer(a);
    var y = parseVer(b);
    for (var i = 0; i < 3; i++) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    }
    return 0;
  }

  /* ---------------------------------------------------------------- 存储 */

  function ls(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      if (val === null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(val));
    } catch (e) {
      /* CEP 里 localStorage 被策略关掉时不该影响主流程 */
    }
    return null;
  }

  /* ---------------------------------------------------------------- 弹窗 */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /** Release 说明里塞满 markdown 标记，直接显示很难看；只留文字和换行 */
  function plainNotes(body) {
    return String(body || "")
      .replace(/^#{1,6}\s*/gm, "")
      .replace(/\*\*|__|`/g, "")
      .replace(/^\s*[-*+]\s+/gm, "· ")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\r/g, "")
      .trim();
  }

  function close() {
    if (!card) return;
    card.className = "upd-card";
    var el = card;
    card = null;
    setTimeout(function () {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }, 220);
  }

  function show(info) {
    if (card) return;
    var notes = plainNotes(info.body);
    if (notes.length > 320) notes = notes.slice(0, 320).trim() + "…";

    var el = document.createElement("div");
    el.className = "upd-card";
    el.innerHTML =
      '<div class="upd-head">' +
      '<span class="upd-badge">更新</span>' +
      '<span class="upd-title">新版本 ' + esc(info.latest) + "</span>" +
      '<button class="upd-x" type="button" aria-label="稍后">×</button>' +
      "</div>" +
      (info.date ? '<div class="upd-date">发布于 ' + esc(info.date) + "</div>" : "") +
      (notes ? '<p class="upd-notes">' + esc(notes) + "</p>" : "") +
      '<div class="upd-actions">' +
      '<button class="btn upd-later" type="button">稍后</button>' +
      '<button class="btn primary upd-go" type="button">去下载</button>' +
      "</div>" +
      '<button class="upd-skip" type="button">跳过这个版本</button>';

    document.body.appendChild(el);
    card = el;

    /* 下一帧再加 is-on，否则 transition 不会触发（元素刚插入时没有初始态） */
    requestAnimationFrame(function () {
      if (card) card.className = "upd-card is-on";
    });

    el.querySelector(".upd-x").addEventListener("click", close);
    el.querySelector(".upd-later").addEventListener("click", close);
    el.querySelector(".upd-skip").addEventListener("click", function () {
      ls(K_SKIP, info.latest);
      close();
    });
    el.querySelector(".upd-go").addEventListener("click", function () {
      openDownload(info);
    });
  }

  /**
   * 打开下载。
   *
   * CEP 里 window.open 会被拦，必须走 CEP 的宿主接口。但面板 UI 在 iframe 里，
   * 宿主接口只在顶层页绑得对，所以要把请求转给顶层。
   *
   * 关键：转过去之后**要等一个回执**。用户如果还没重开 Illustrator，
   * 装着的还是旧桥接脚本，它会把这个消息当未知类型直接丢掉 ——
   * 表现就是「点了没反应」，这是最糟的失败方式。收不到回执就降级成
   * 把地址摆出来让用户复制。
   */
  var urlAck = null;
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d.tag === "__fontdeck_bridge__" && d.type === "openUrlDone") {
      if (urlAck) urlAck();
    }
  });

  function openDownload(info) {
    var url = info.downloadUrl || info.pageUrl;
    if (!url) return;

    var handled = false;

    /* 顶层页：桥就在本窗口，直接调 */
    if (window.parent === window) {
      try {
        if (window.__adobe_cep__ && typeof window.__adobe_cep__.openURLInDefaultBrowser === "function") {
          window.__adobe_cep__.openURLInDefaultBrowser(url);
          handled = true;
        }
      } catch (e) { /* 落到下面 */ }
      if (!handled) {
        try {
          handled = !!window.open(url, "_blank");
        } catch (e2) { /* ignore */ }
      }
      if (!handled) showLinkFallback(url);
      return;
    }

    /* iframe：转给顶层执行，等回执 */
    var done = false;
    var timer = null;

    urlAck = function () {
      done = true;
      if (timer) clearTimeout(timer);
    };

    try {
      window.parent.postMessage({ tag: "__fontdeck_bridge__", type: "openUrl", url: url }, "*");
    } catch (e3) {
      showLinkFallback(url);
      return;
    }

    timer = setTimeout(function () {
      if (done) return;
      /* 回执没来：要么桥接是旧版，要么根本不在 CEP 里。
         先试普通浏览器的新标签，再不行就把地址亮出来。 */
      var opened = false;
      try {
        opened = !!window.open(url, "_blank");
      } catch (e4) { /* ignore */ }
      if (!opened) showLinkFallback(url);
    }, 500);
  }

  function showLinkFallback(url) {
    if (!card) {
      /* 卡片已经关掉了：至少不能什么都不发生，用原生提示让用户知道去哪拿 */
      try {
        window.prompt("浏览器没能自动打开，复制这个地址手动下载：", url);
      } catch (e) { /* ignore */ }
      return;
    }
    var old = card.querySelector(".upd-fallback");
    if (old) old.parentNode.removeChild(old);
    var box = document.createElement("div");
    box.className = "upd-fallback";
    box.innerHTML =
      '<p>浏览器没能自动打开，复制这个地址手动下载：</p>' +
      '<input readonly value="' + esc(url) + '">';
    card.appendChild(box);
    var input = box.querySelector("input");
    input.focus();
    input.select();
  }

  /* ---------------------------------------------------------------- 检查 */

  function fetchJson(url, headers) {
    return new Promise(function (resolve, reject) {
      var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (ctrl) ctrl.abort();
        reject(new Error("timeout"));
      }, TIMEOUT);

      fetch(url, {
        headers: headers || {},
        cache: "no-store",
        signal: ctrl ? ctrl.signal : undefined,
      })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (d) {
          clearTimeout(timer);
          resolve(d);
        })
        .catch(function (e) {
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  function pickDownload(release) {
    var assets = Array.isArray(release.assets) ? release.assets : [];
    /* 优先给安装包，其次给任意 zip，最后退回 release 页面 */
    var order = [/setup.*\.exe$/i, /\.zip$/i, /\.exe$/i];
    for (var i = 0; i < order.length; i++) {
      for (var j = 0; j < assets.length; j++) {
        var name = String(assets[j].name || "");
        if (order[i].test(name) && assets[j].browser_download_url) {
          return assets[j].browser_download_url;
        }
      }
    }
    return "";
  }

  function check(force) {
    if (running) return Promise.resolve(null);

    if (!force) {
      var last = Number(ls(K_CHECKED) || 0);
      if (last && Date.now() - last < CHECK_INTERVAL) return Promise.resolve(null);
    }

    running = true;

    return fetch("/api/update/info")
      .then(function (r) { return r.json(); })
      .then(function (info) {
        if (!info || !info.ok || info.check === false) return null;
        if (!info.repo && !info.api) {
          /* 没配仓库就是「还没接入更新」，静默跳过，不打扰用户 */
          return null;
        }

        var url = info.api || ("https://api.github.com/repos/" + info.repo + "/releases/latest");
        return fetchJson(url, {
          Accept: "application/vnd.github+json",
        }).then(function (rel) {
          ls(K_CHECKED, Date.now());
          if (!rel || !rel.tag_name) return null;

          var latest = String(rel.tag_name).replace(/^v/i, "");
          if (cmpVer(latest, info.current) <= 0) return null;
          if (ls(K_SKIP) === latest) return null;

          show({
            latest: latest,
            current: info.current,
            date: String(rel.published_at || "").slice(0, 10),
            body: rel.body || "",
            pageUrl: rel.html_url || "",
            downloadUrl: pickDownload(rel),
          });
          return latest;
        });
      })
      .catch(function (e) {
        /* 网络不通是最常见的失败，绝不能因此弹错误窗 ——
           用户根本没点任何按钮，不该被打扰。只在控制台留痕。 */
        try {
          console.log("[update] 检查失败：", e && e.message ? e.message : e);
        } catch (e2) { /* ignore */ }
        return null;
      })
      .then(function (r) {
        running = false;
        return r;
      });
  }

  /* 控制台手动触发，方便调试：__fdCheckUpdate(true) */
  window.__fdCheckUpdate = check;

  setTimeout(function () { check(false); }, FIRST_DELAY);
  setInterval(function () { check(false); }, CHECK_INTERVAL);
})();
