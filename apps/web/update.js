/*
 * FontDeck 更新检查与安装。
 *
 * 一种入口：弹卡片 → 点「立即更新」→ 面板自己下载、自己装 → 提示重开 Illustrator。
 * 不再往浏览器扔链接，因为那等于把「下载 → 解压 → 放对位置 → 改指针」
 * 整套活儿丢给用户，其中任何一步做错都会得到一个"更新了但没生效"的面板。
 *
 * 分工是刻意的：
 *   下载在前端 —— CEP 的 Chromium 走系统代理，而本地 Node 不走。
 *                 国内「浏览器能开 GitHub、Node 直连超时」是常态。
 *   保存在服务端 —— 解压、校验、写指针都要碰文件系统，浏览器做不到。
 * 两者之间是本机回环，几十 MB 秒级。
 */
(function () {
  "use strict";

  var CHECK_INTERVAL = 6 * 60 * 60 * 1000;  /* 6 小时 */
  var FIRST_DELAY = 8000;                   /* 启动后 8 秒：等首屏扫描先跑完 */
  var TIMEOUT = 8000;                       /* 只用于查版本，下载另算 */
  var DOWNLOAD_TIMEOUT = 10 * 60 * 1000;
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

  /* ---------------------------------------------------------------- 工具 */

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

  function mb(n) {
    return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
  }

  /* ---------------------------------------------------------------- 卡片 */

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
    if (notes.length > 260) notes = notes.slice(0, 260).trim() + "…";

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
      '<button class="btn primary upd-go" type="button">立即更新</button>' +
      "</div>" +
      '<div class="upd-prog" hidden>' +
      '<div class="upd-bar"><i></i></div>' +
      '<div class="upd-pct">准备中…</div>' +
      "</div>" +
      '<div class="upd-done" hidden></div>' +
      '<div class="upd-fallback" hidden></div>' +
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
      startUpdate(info);
    });
  }

  /** 拒绝进行中的操作把卡片关掉：装到一半被关，用户以为没事，其实什么都没装 */
  function lockCard() {
    if (!card) return;
    var btn = card.querySelector(".upd-x");
    if (btn) btn.disabled = true;
    var later = card.querySelector(".upd-later");
    if (later) later.disabled = true;
    var skip = card.querySelector(".upd-skip");
    if (skip) skip.hidden = true;
  }

  function setProgress(pct, text) {
    if (!card) return;
    var box = card.querySelector(".upd-prog");
    if (box) box.hidden = false;
    var bar = card.querySelector(".upd-bar i");
    if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
    var pctEl = card.querySelector(".upd-pct");
    if (pctEl) pctEl.textContent = text;
  }

  function showDone(html) {
    if (!card) return;
    var actions = card.querySelector(".upd-actions");
    if (actions) actions.hidden = true;
    var prog = card.querySelector(".upd-prog");
    if (prog) prog.hidden = true;
    var box = card.querySelector(".upd-done");
    if (!box) return;
    box.hidden = false;
    box.innerHTML = html;
  }

  /* ---------------------------------------------------------------- 下载与安装 */

  /** 优先取增量包（只有 app + panel，十几 MB），没有再退完整包 */
  function pickAsset(release) {
    var assets = Array.isArray(release.assets) ? release.assets : [];
    var i;
    for (i = 0; i < assets.length; i++) {
      if (/-update\.zip$/i.test(String(assets[i].name || "")) && assets[i].browser_download_url) {
        return { url: assets[i].browser_download_url, size: Number(assets[i].size || 0), name: assets[i].name };
      }
    }
    for (i = 0; i < assets.length; i++) {
      if (/\.zip$/i.test(String(assets[i].name || "")) && assets[i].browser_download_url) {
        return { url: assets[i].browser_download_url, size: Number(assets[i].size || 0), name: assets[i].name };
      }
    }
    return null;
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function postJson(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: "服务端返回了无法解析的内容（HTTP " + r.status + "）" };
      });
    });
  }

  /**
   * 发起更新并轮询进度。
   *
   * 下载交给本地服务做，不是在面板里 fetch —— GitHub 的资产域名不带 CORS，
   * 浏览器里直接下会被拦。服务端下还有一个好处：几十 MB 落盘而不是在
   * 渲染进程里堆一个大 ArrayBuffer。
   */
  function startUpdate(info) {
    if (!card) return;

    if (info.autoUpdate === false) {
      showFailed(
        "当前是从源码目录运行的开发模式，自动更新会覆盖开发目录，所以被禁用了。",
        info,
        false
      );
      return;
    }

    if (!info.asset) {
      showFailed("这个版本没有提供可下载的安装包。", info, false);
      return;
    }

    lockCard();

    var actions = card.querySelector(".upd-actions");
    if (actions) actions.hidden = true;

    setProgress(0, "正在准备…");

    postJson("/api/update/install", { version: info.latest, url: info.asset.url })
      .then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || "无法开始更新");
        return poll(info);
      })
      .catch(function (e) {
        showFailed((e && e.message) || "更新失败", info, true);
      });
  }

  function poll(info) {
    if (!card) return Promise.resolve();

    return fetch("/api/update/status")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var s = (d && d.state) || {};

        if (s.phase === "downloading") {
          var pct = s.total ? Math.round((s.received / s.total) * 100) : 0;
          var text = s.total
            ? "正在下载 " + pct + "%  ·  " + mb(s.received) + " / " + mb(s.total)
            : "正在下载 " + mb(s.received || 0);
          /* 走了代理就把来源标出来，出问题时一眼能看出是不是代理没找对 */
          if (s.via) text += "  ·  " + s.via;
          setProgress(pct, text);
          return sleep(600).then(function () { return poll(info); });
        }

        if (s.phase === "installing") {
          setProgress(100, "下载完成，正在安装…");
          return sleep(500).then(function () { return poll(info); });
        }

        if (s.phase === "done") {
          showSuccess(s, info);
          return Promise.resolve();
        }

        if (s.phase === "error") {
          throw new Error(s.error || "更新失败");
        }

        /* idle（被别的请求抢了）或者还没开始 */
        setProgress(0, "等待安装…");
        return sleep(600).then(function () { return poll(info); });
      })
      .catch(function (e) {
        /* 服务端在安装过程中会退出，轮询最后一次可能连不上 —— 
           这种情况下状态大概率已经是 done，别把它报成失败 */
        fetch("/api/update/status")
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.state && d.state.phase === "done") {
              showSuccess(d.state, info);
            } else {
              showFailed((e && e.message) || "更新失败", info, true);
            }
          })
          .catch(function () {
            showFailed((e && e.message) || "更新失败", info, true);
          });
      });
  }

  function showSuccess(s, info) {
    if (!card) return;

    var extra = s.panelUpdated === false
      ? '<p class="upd-warn">面板外壳没能更新（' + esc(s.panelError || "文件被 Illustrator 占用") +
        "）。功能已经生效，只是外壳还是旧的，下次装完整包会一起修好。</p>"
      : "";

    showDone(
      '<div class="upd-ok-title">已装好 ' + esc(s.version || info.latest) + "</div>" +
      '<p class="upd-ok-body">现在<strong>完全退出 Illustrator</strong>（不是只关面板窗口），' +
      "再重新打开，新版本才会加载。</p>" +
      extra +
      '<button class="btn primary upd-restart-ok" type="button">知道了，我去重启</button>'
    );

    var ok = card.querySelector(".upd-restart-ok");
    if (ok) {
      ok.addEventListener("click", function () {
        close();
        /* 让老服务自己退出，否则端口一直被占着，重开 AI 也拉不起新版本 */
        postJson("/api/update/restart", {}).catch(function () { /* 服务已经退了也算成功 */ });
      });
    }
  }

  function showFailed(msg, info, retryable) {
    if (!card) return;

    var actions = card.querySelector(".upd-actions");
    if (actions) actions.hidden = true;

    var prog = card.querySelector(".upd-prog");
    if (prog) prog.hidden = true;

    var box = card.querySelector(".upd-fallback");
    if (!box) return;
    box.hidden = false;
    box.innerHTML =
      '<div class="upd-err-title">更新没有完成</div>' +
      '<p class="upd-err-body">' + esc(msg) + "</p>";

    var row = document.createElement("div");
    row.className = "upd-actions";

    if (retryable) {
      var again = document.createElement("button");
      again.className = "btn primary";
      again.type = "button";
      again.textContent = "重试";
      again.addEventListener("click", function () {
        box.hidden = true;
        box.innerHTML = "";
        startUpdate(info);
      });
      row.appendChild(again);
    }

    if (info.pageUrl) {
      var manual = document.createElement("button");
      manual.className = "btn";
      manual.type = "button";
      manual.textContent = "手动下载";
      manual.addEventListener("click", function () {
        /* 只在自动更新失败时作为兜底出现，不是第二条常规路径 */
        openUrl(info.pageUrl);
      });
      row.appendChild(manual);
    }

    box.appendChild(row);

    var x = card.querySelector(".upd-x");
    if (x) x.disabled = false;
    var later = card.querySelector(".upd-later");
    if (later) {
      later.disabled = false;
      later.hidden = false;
    }
  }

  /* ---------------------------------------------------------------- 打开网页（仅兜底） */

  var urlAck = null;
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d.tag === "__fontdeck_bridge__" && d.type === "openUrlDone") {
      if (urlAck) urlAck();
    }
  });

  function openUrl(url) {
    if (!url) return;
    var handled = false;

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
      if (!handled) window.prompt("浏览器没能自动打开，复制这个地址：", url);
      return;
    }

    var done = false;
    urlAck = function () {
      done = true;
    };
    try {
      window.parent.postMessage({ tag: "__fontdeck_bridge__", type: "openUrl", url: url }, "*");
    } catch (e3) {
      window.prompt("复制这个地址手动下载：", url);
      return;
    }
    setTimeout(function () {
      if (done) return;
      try {
        if (!window.open(url, "_blank")) window.prompt("复制这个地址手动下载：", url);
      } catch (e4) {
        window.prompt("复制这个地址手动下载：", url);
      }
    }, 500);
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

          var asset = pickAsset(rel);
          if (!asset) return null;  /* 没资产的 release 不提示，点了也没用 */

          show({
            latest: latest,
            current: info.current,
            date: String(rel.published_at || "").slice(0, 10),
            body: rel.body || "",
            pageUrl: rel.html_url || "",
            asset: asset,
            autoUpdate: info.autoUpdate !== false,
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
