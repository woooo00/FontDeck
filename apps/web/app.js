/* FontDeck 字体库前端
 * 无框架、无构建。兼容 CEP 的 Chromium 99。
 * 列表按「家族」呈现：一个家族一张卡，卡上标字重数量。
 */
(function () {
  "use strict";

  var API = "";
  var PAGE = 48;

  var state = {
    q: "",
    cat: "",
    lang: "",
    scope: "",
    health: "",
    dup: "",
    offset: 0,
    total: 0,
    loading: false,
    done: false,
  };

  var grid = document.getElementById("grid");
  var statusEl = document.getElementById("status");
  var countEl = document.getElementById("count");
  var searchEl = document.getElementById("search");
  var sentinel = document.getElementById("sentinel");
  var drawer = document.getElementById("drawer");
  var drawerBody = document.getElementById("drawerBody");
  var mask = document.getElementById("drawerMask");

  var isCEP = typeof window.__adobe_cep__ !== "undefined";

  var CAT_LABEL = {
    serif: "衬线",
    "sans-serif": "无衬线",
    monospace: "等宽",
    script: "手写",
    display: "装饰",
    symbol: "符号",
    unknown: "未分类",
  };

  /* ---------------- 工具 ---------------- */

  function qs() {
    var p = [];
    if (state.q) p.push("q=" + encodeURIComponent(state.q));
    if (state.cat) p.push("cat=" + encodeURIComponent(state.cat));
    if (state.lang) p.push("lang=" + encodeURIComponent(state.lang));
    if (state.scope) p.push("scope=" + encodeURIComponent(state.scope));
    if (state.health) p.push("health=" + encodeURIComponent(state.health));
    if (state.dup) p.push("dup=1");
    p.push("offset=" + state.offset);
    p.push("limit=" + PAGE);
    return p.join("&");
  }

  function previewUrl(id, text, size, width, color) {
    var u =
      API +
      "/api/fonts/" +
      id +
      "/preview.svg?text=" +
      encodeURIComponent(text) +
      "&size=" +
      size +
      "&w=" +
      width;
    if (color) u += "&color=" + encodeURIComponent(color);
    return u;
  }

  function fmtSize(bytes) {
    if (!bytes) return "—";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------------- 预览图（SVG 走 img，原生懒加载） ---------------- */

  function makeImg(url, fallbackText, fallbackClass) {
    var wrap = document.createElement("div");
    wrap.style.width = "100%";
    wrap.style.height = "100%";
    wrap.style.display = "flex";
    wrap.style.alignItems = "center";
    wrap.style.overflow = "hidden";

    var img = document.createElement("img");
    // 不用 loading="lazy"：在 CEP 面板的 iframe 里它经常不触发，卡片会一直空着。
    // 列表本身是分页的（每次 48 个家族），请求量可控。
    img.decoding = "async";
    img.alt = "";
    img.src = url;
    img.style.maxWidth = "100%";
    img.style.height = "auto";

    var fb = document.createElement("span");
    fb.className = fallbackClass;
    fb.textContent = fallbackText;
    fb.style.display = "none";

    img.onerror = function () {
      img.style.display = "none";
      fb.style.display = "block";
    };

    wrap.appendChild(img);
    wrap.appendChild(fb);
    return wrap;
  }

  /* ---------------- 卡片（单行列表 + 悬停预览） ---------------- */
  /*
   * 一行一个字体：上排「字体名 + 字重/分类/字重数」，下排「样张 + 徽标」。
   * 鼠标停 100ms 后原地向下长高，露出放大字样和 PostScript / 格式 / 体积。
   *
   * 展开不闪的两个前提：
   *   1) 卡片绝对定位在固定高度的 .slot 占位里，只改自己的 height，
   *      相邻行纹丝不动，不会连锁重排；
   *   2) 高度一律走 px 过渡 —— CSS 的 100% 与 px 之间不插值，直接换会跳，
   *      所以先写起点 px、强制回流，下一帧再写终点。
   */
  var OPEN_H = 126;
  var openCard = null;

  /*
   * 常用区的托盘高度是内容撑出来的，但卡片是绝对定位的 —— 展开时它只长自己
   * 的高度，占位格（.slot）纹丝不动，所以托盘背景不会跟着变，预览会「悬」
   * 在托盘外面。这里给 .fav-grid 补一段等高的下内边距，托盘自然被撑高。
   *
   * 只有「最后一张可见卡」才撑：中间的卡展开时，下半截本来就压着下面那张卡，
   * 托盘底部不会露出空档，跟着撑高只会让托盘凭空变长（用户指出这是错的）。
   */
  function setFavRoom(extra) {
    var g = document.getElementById("favGrid");
    if (!g) return;
    /* 12 是 .fav-grid 原本的 padding-bottom，改 CSS 时要一起改 */
    g.style.paddingBottom = extra > 0 ? 12 + Math.round(extra) + "px" : "";
  }

  /* 常用区里当前「可见的最后一张卡」。折叠时多出来的卡挂在 .is-extra
     （display:none）上，offsetParent 为 null，据此跳过。 */
  function isLastFavCard(card) {
    var g = document.getElementById("favGrid");
    if (!g || !g.contains(card)) return false;
    var kids = g.querySelectorAll(".card");
    var last = null;
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].offsetParent) last = kids[i];
    }
    return last === card;
  }

  function expandCard(card) {
    if (!card || card.classList.contains("is-big")) return;
    if (openCard && openCard !== card) collapseCard(openCard);
    openCard = card;

    var r = card.getBoundingClientRect();
    /* 下面放不下就改成向上长，保证整张预览留在视口里 */
    var top = 0;
    if (r.top + OPEN_H > window.innerHeight - 8) {
      var up = r.height - OPEN_H;
      if (r.top + up > 64) top = up;
    }

    /* 撑托盘要同时满足三条：向下展开、在常用区里、而且是最后一张可见卡。
       向上展开该补的是顶部空间（padding-top），不是底部。 */
    var needRoom = isLastFavCard(card);

    var tk = (card.__tk | 0) + 1;
    card.__tk = tk;

    card.style.transition = "none";
    card.style.height = r.height + "px";
    card.style.top = "0px";
    void card.offsetHeight;
    card.style.transition = "";

    requestAnimationFrame(function () {
      if (card.__tk !== tk) return;
      card.style.height = OPEN_H + "px";
      card.style.top = top + "px";
      card.classList.add("is-big");
      /* 不满足条件时也主动清空：从「最后一张」切到「中间一张」时，
         上一张留下的 padding 必须收回，否则托盘还是长的 */
      setFavRoom(top >= 0 && needRoom ? OPEN_H - r.height : 0);
    });
  }

  function collapseCard(card) {
    if (!card || !card.classList.contains("is-big")) return;
    if (openCard === card) openCard = null;
    var slotH = card.parentNode.getBoundingClientRect().height;

    var tk = (card.__tk | 0) + 1;
    card.__tk = tk;
    card.classList.remove("is-big");
    card.style.height = slotH + "px";
    card.style.top = "0px";
    setFavRoom(0);

    /* 动画结束后清掉内联尺寸，让卡片重新跟着占位走；版本号防止
       「刚收起又马上展开」时把正在进行的展开清掉 */
    setTimeout(function () {
      if (card.__tk !== tk) return;
      if (card.classList.contains("is-big")) return;
      card.style.height = "";
      card.style.top = "";
    }, 260);
  }

  function bindCardHover(card) {
    var timer = null;
    card.addEventListener("mouseenter", function () {
      clearTimeout(timer);
      /* 多选态不展开：展开会盖住相邻行，勾不到 */
      if (favSel) return;
      timer = setTimeout(function () {
        expandCard(card);
      }, 100);
    });
    card.addEventListener("mouseleave", function () {
      clearTimeout(timer);
      collapseCard(card);
    });
  }

  function buildCard(g) {
    var slot = document.createElement("div");
    slot.className = "slot";

    var card = document.createElement("article");
    card.className = "card";
    card.setAttribute("data-id", g.id);
    card.setAttribute("data-key", g.key || "");

    /* ---------- 第一行：字体名 + 属性 ---------- */
    var main = document.createElement("div");
    main.className = "card-main";

    var nameBox = document.createElement("div");
    nameBox.className = "card-name";
    nameBox.appendChild(
      makeImg(previewUrl(g.id, g.name, 26, 420), g.name, "name-fallback")
    );

    var meta = document.createElement("div");
    meta.className = "card-meta";
    meta.textContent = [
      g.weightClass,
      CAT_LABEL[g.category] || g.category,
      g.faceCount > 1 ? g.faceCount + " 字重" : "",
      (g.format || "").toUpperCase(),
    ]
      .filter(Boolean)
      .join(" · ");

    main.appendChild(nameBox);
    main.appendChild(meta);

    /* ---------- 第二行：样张 + 徽标 ---------- */
    var sub = document.createElement("div");
    sub.className = "card-sub";

    var sampleText = g.hasCJK ? "永和九年 岁在癸丑" : "Aa Bb Cc 0123";
    var sampleBox = document.createElement("div");
    sampleBox.className = "card-sample";
    sampleBox.appendChild(
      makeImg(
        previewUrl(g.id, sampleText, 15, 420, "#6a6a76"),
        "预览不可用",
        "sample-fallback"
      )
    );

    var badges = [];
    if (g.isVariable) badges.push('<span class="badge var">可变</span>');
    if (g.health === "unregistered")
      badges.push('<span class="badge warn">未注册</span>');
    if (g.health === "suspicious")
      badges.push('<span class="badge warn">残片</span>');
    if (g.hasDuplicate) badges.push('<span class="badge dup">同名重复</span>');
    if (g.hasFileDup) badges.push('<span class="badge dup">内容重复</span>');
    if (g.scope === "system") badges.push('<span class="badge sys">系统</span>');
    /* 常用区的卡片带上使用次数，用户能看出为什么它排在这 */
    if (g.used > 0) badges.push('<span class="badge used">用 ' + g.used + " 次</span>");

    var badgeBox = document.createElement("div");
    badgeBox.className = "card-badges";
    badgeBox.innerHTML = badges.join("");

    sub.appendChild(sampleBox);
    sub.appendChild(badgeBox);

    /* ---------- 展开后才露出来的那块 ---------- */
    var more = document.createElement("div");
    more.className = "card-more";

    var bigSample = document.createElement("div");
    bigSample.className = "more-sample";
    bigSample.appendChild(
      makeImg(
        previewUrl(
          g.id,
          g.hasCJK ? "永和九年 岁在癸丑 惠风和畅" : "Aa Bb Cc Dd Ee Ff 0123",
          30,
          420,
          "#3a3a44"
        ),
        "预览不可用",
        "sample-fallback"
      )
    );

    var info = document.createElement("div");
    info.className = "more-info";
    info.textContent = [g.postScriptName, (g.format || "").toUpperCase(), fmtSize(g.fileSize)]
      .filter(Boolean)
      .join(" · ");

    more.appendChild(bigSample);
    more.appendChild(info);

    card.appendChild(main);
    card.appendChild(sub);
    card.appendChild(more);
    slot.appendChild(card);

    bindCardHover(card);

    card.addEventListener("click", function () {
      /* 常用区右键进入多选后，点卡片是「勾选」而不是「看详情」。 */
      if (card.classList.contains("is-pick")) {
        toggleFavPick(g.key);
        return;
      }
      /* 注意：这里不再打点。常用只收录「真正用过」的字体 ——
         浏览详情不算，只有应用到选区 / 转曲恢复里采用才记数。 */
      openDetail(g.id);
    });

    return slot;
  }

  /* ---------------- 常用字体 ---------------- */

  /*
   * 「常用」不是收藏夹，是**真的用过**的字体：只有「应用到选区」(+3) 和
   * 「转曲恢复里被采用」(+2) 才记数，光打开详情不算 —— 否则翻一圈列表
   * 就把常用塞满了，失去意义。
   * 计数存服务端 data/usage.json，按家族聚合；前 1 个常显，其余收进托盘。
   * （原来常显 3 个，2026-11-18 按用户要求收到 1 个 —— 常用区在下滑
   *   之前不该占掉半屏，"其余 N 个"点开再看。）
   */
  var FAV_SHOW = 1;
  var favEl = document.getElementById("fav");
  var favGrid = document.getElementById("favGrid");
  var favToggle = document.getElementById("favToggle");
  var favEmptyEl = document.getElementById("favEmpty");
  var favBar = document.getElementById("favBar");
  var favBarCount = document.getElementById("favBarCount");
  var favBarDel = document.getElementById("favBarDel");
  var favBarCancel = document.getElementById("favBarCancel");
  var favUndo = document.getElementById("favUndo");
  var favUndoText = document.getElementById("favUndoText");
  var favUndoBtn = document.getElementById("favUndoBtn");
  var favOpen = false;
  var favItems = [];
  /** null = 普通模式；对象 = 多选模式（家族 key → true） */
  var favSel = null;
  var favUndoData = null;
  var favUndoTimer = null;

  /** 有筛选或搜索词时不显示常用：混在结果里会分不清哪些是筛出来的 */
  function hasFilter() {
    return !!(
      state.q ||
      state.cat ||
      state.lang ||
      state.scope ||
      state.health ||
      state.dup
    );
  }

  /** 打点：失败静默，绝不能因为记数打断用户操作 */
  function hitUsage(ps, weight) {
    if (!ps) return;
    try {
      fetch(API + "/api/usage/hit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ps: ps, weight: weight || 1 }),
      }).catch(function () {});
    } catch (e) {}
  }

  function paintFav() {
    favGrid.innerHTML = "";
    /* 重绘会丢掉旧节点，展开引用一起清掉 */
    openCard = null;
    /* 全部移除后列表是空的，得让「用过的字体会自动收在这里」顶上来 */
    if (favEmptyEl) favEmptyEl.hidden = favItems.length > 0;
    for (var i = 0; i < favItems.length; i++) {
      var it = favItems[i];
      var wrap = buildCard(it); /* .slot 占位 */
      var card = wrap.firstChild; /* .card 本体 */
      if (i >= FAV_SHOW) wrap.className += " is-extra";
      /* 右键任一卡片即可进入多选，不必先找按钮 */
      card.addEventListener("contextmenu", function (e) {
        e.preventDefault();
        var k = this.getAttribute("data-key");
        if (!favSel) enterFavSel(k);
        else toggleFavPick(k);
      });
      if (favSel) {
        card.classList.add("is-pick");
        if (favSel[it.key]) card.classList.add("is-on");
      }
      favGrid.appendChild(wrap);
    }

    var extra = favItems.length - FAV_SHOW;
    if (favSel) {
      /* 多选时强制展开：否则收在托盘里的那几张根本勾不到 */
      favGrid.classList.add("is-pick", "is-open");
      favToggle.hidden = true;
    } else if (extra > 0) {
      favGrid.classList.remove("is-pick");
      favToggle.hidden = false;
      favToggle.textContent = favOpen ? "收起" : "其余 " + extra + " 个";
      favToggle.setAttribute("aria-expanded", favOpen ? "true" : "false");
      if (favOpen) favGrid.classList.add("is-open");
      else favGrid.classList.remove("is-open");
    } else {
      favGrid.classList.remove("is-pick");
      favToggle.hidden = true;
      favGrid.classList.remove("is-open");
    }
    refreshFavBar();
  }

  /* ---------------- 常用：多选移除 ---------------- */

  function refreshFavBar() {
    var n = favSel ? Object.keys(favSel).length : 0;
    if (favBarCount) {
      favBarCount.textContent = n ? "已选 " + n + " 个" : "点卡片选择";
    }
    if (favBarDel) favBarDel.disabled = n === 0;
  }

  function enterFavSel(key) {
    if (!favSel) favSel = {};
    favOpen = true;
    if (key) favSel[key] = true;
    /* 多选时不该有卡片处于展开态，否则会挡住相邻行 */
    if (openCard) collapseCard(openCard);
    if (favBar) favBar.hidden = false;
    if (favUndo) favUndo.hidden = true;
    paintFav();
  }

  /** 只切类名、不重绘：否则每点一下 16 张卡的字体图都要重新加载 */
  function toggleFavPick(key) {
    if (!favSel) return;
    if (favSel[key]) delete favSel[key];
    else favSel[key] = true;
    var cards = favGrid.querySelectorAll(".card");
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute("data-key") === key) {
        if (favSel[key]) cards[i].classList.add("is-on");
        else cards[i].classList.remove("is-on");
      }
    }
    refreshFavBar();
  }

  function exitFavSel() {
    favSel = null;
    if (favBar) favBar.hidden = true;
    if (favItems.length <= FAV_SHOW) favOpen = false;
    paintFav();
  }

  /**
   * 移除选中的家族。
   *
   * 必须整族一起删（psList）：只删用得最多的那个 face，同族别的字重还留着
   * 计数，卡片下一轮又会冒出来，用户会以为没删掉。
   */
  function removeFavPicked() {
    if (!favSel) return;
    var keys = Object.keys(favSel);
    if (!keys.length) return;

    var ps = [];
    for (var i = 0; i < keys.length; i++) {
      for (var j = 0; j < favItems.length; j++) {
        if (favItems[j].key !== keys[i]) continue;
        var list = favItems[j].psList;
        if (!list || !list.length) list = [favItems[j].postScriptName];
        for (var k = 0; k < list.length; k++) if (list[k]) ps.push(list[k]);
        break;
      }
    }

    if (favBarDel) favBarDel.disabled = true;
    fetch(API + "/api/usage/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ps: ps }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.ok) throw new Error((d && d.error) || "移除失败");
        var keep = [];
        for (var i = 0; i < favItems.length; i++) {
          if (!favSel[favItems[i].key]) keep.push(favItems[i]);
        }
        var n = keys.length;
        favItems = keep;
        favSel = null;
        if (favBar) favBar.hidden = true;
        if (favItems.length <= FAV_SHOW) favOpen = false;
        paintFav();
        showFavUndo(n, d.removed || {});
        /* 托盘之外可能还有家族，重拉一次保证顺序与总数都对 */
        loadFav();
      })
      .catch(function (e) {
        if (favBarDel) favBarDel.disabled = false;
        toast(e.message || "移除失败", true);
      });
  }

  function showFavUndo(n, removed) {
    favUndoData = removed;
    if (favUndoText) favUndoText.textContent = "已移除 " + n + " 个常用";
    if (favUndo) favUndo.hidden = false;
    clearTimeout(favUndoTimer);
    favUndoTimer = setTimeout(function () {
      if (favUndo) favUndo.hidden = true;
      favUndoData = null;
    }, 8000);
  }

  function undoFavRemove() {
    if (!favUndoData) return;
    var entries = favUndoData;
    favUndoData = null;
    if (favUndo) favUndo.hidden = true;
    clearTimeout(favUndoTimer);
    fetch(API + "/api/usage/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: entries }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.ok) throw new Error("撤销失败");
        loadFav();
        toast("已恢复 " + (d.restored || 0) + " 条计数");
      })
      .catch(function () {
        toast("撤销失败", true);
      });
  }

  function loadFav() {
    if (hasFilter()) {
      favEl.hidden = true;
      /* 筛选时不显示常用，多选状态也一并清掉，免得回到「全部」时还挂着上次的勾 */
      favSel = null;
      if (favBar) favBar.hidden = true;
      return;
    }
    fetch(API + "/api/usage/top?limit=16")
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        favItems = (d && d.items) || [];
        if (!favItems.length) {
          /* 空态也留个位置：否则新用户看不出这个功能存在，一个小字提示就够 */
          favEl.hidden = false;
          favGrid.innerHTML = "";
          favToggle.hidden = true;
          favSel = null;
          favOpen = false;
          if (favBar) favBar.hidden = true;
          if (favEmptyEl) favEmptyEl.hidden = false;
          return;
        }
        favEl.hidden = false;
        if (favEmptyEl) favEmptyEl.hidden = true;
        paintFav();
      })
      .catch(function () {
        favEl.hidden = true;
      });
  }

  if (favToggle) {
    favToggle.addEventListener("click", function () {
      favOpen = !favOpen;
      paintFav();
    });
  }
  if (favBarDel) favBarDel.addEventListener("click", removeFavPicked);
  if (favBarCancel) favBarCancel.addEventListener("click", exitFavSel);
  if (favUndoBtn) favUndoBtn.addEventListener("click", undoFavRemove);

  /* 一滚动就把展开的预览收回去：否则它会浮在滚动的列表上方，看着像 bug */
  window.addEventListener(
    "scroll",
    function () {
      if (openCard) collapseCard(openCard);
    },
    { passive: true }
  );

  /* ---------------- 列表 ---------------- */

  function render(list) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < list.length; i++) {
      frag.appendChild(buildCard(list[i]));
    }
    grid.appendChild(frag);
  }

  function setStatus(html) {
    statusEl.innerHTML = html;
  }

  function load(reset) {
    if (state.loading) return;
    if (reset) {
      state.offset = 0;
      state.done = false;
      grid.innerHTML = "";
      window.scrollTo(0, 0);
      loadFav();
    }
    if (state.done) return;

    state.loading = true;
    setStatus("加载中…");

    fetch(API + "/api/families?" + qs())
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        state.total = data.total;
        state.offset += data.items.length;

        if (data.items.length === 0 && state.offset === 0) {
          grid.innerHTML =
            '<div class="empty">没有匹配的字体。换个关键词，或清掉筛选。</div>';
          setStatus("");
          state.done = true;
          countEl.textContent = "0";
          return;
        }

        render(data.items);
        countEl.textContent =
          window.innerWidth < 720
            ? data.total + " 个"
            : data.total + " 个家族 · " + data.faceTotal + " 个字体";

        if (state.offset >= data.total) {
          state.done = true;
          setStatus("已全部加载 · " + data.total + " 个家族");
        } else {
          setStatus("继续向下滚动加载");
        }
      })
      .catch(function (e) {
        setStatus(
          '<span style="color:#ff6b6b">加载失败：' +
            esc(e && e.message ? e.message : e) +
            "</span>"
        );
      })
      .then(function () {
        state.loading = false;
      });
  }

  /* ---------------- 筛选 ---------------- */

  var chips = document.querySelectorAll(".chip");
  var allChip = document.querySelector('.chip[data-key="all"]');

  Array.prototype.forEach.call(chips, function (chip) {
    chip.addEventListener("click", function () {
      var key = chip.getAttribute("data-key");
      var val = chip.getAttribute("data-val") || "";

      if (key === "all") {
        state.cat = "";
        state.lang = "";
        state.scope = "";
        state.health = "";
        state.dup = "";
        Array.prototype.forEach.call(chips, function (c) {
          c.classList.remove("is-active");
        });
        chip.classList.add("is-active");
        load(true);
        return;
      }

      var wasActive = chip.classList.contains("is-active");

      Array.prototype.forEach.call(chips, function (c) {
        if (c.getAttribute("data-key") === key) c.classList.remove("is-active");
      });
      if (allChip) allChip.classList.remove("is-active");

      if (wasActive) {
        state[key] = "";
      } else {
        chip.classList.add("is-active");
        state[key] = val;
      }

      var any =
        state.cat || state.lang || state.scope || state.health || state.dup;
      if (!any && allChip) allChip.classList.add("is-active");

      load(true);
    });
  });

  /* ---------------- 搜索 ---------------- */

  var timer = null;
  searchEl.addEventListener("input", function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      state.q = searchEl.value.trim();
      load(true);
    }, 220);
  });

  /* ---------------- 无限滚动 ---------------- */

  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(
      function (entries) {
        if (entries[0].isIntersecting && !state.done && !state.loading) {
          load(false);
        }
      },
      { rootMargin: "600px" }
    );
    io.observe(sentinel);
  } else {
    window.addEventListener("scroll", function () {
      if (state.done || state.loading) return;
      if (
        window.innerHeight + window.scrollY >
        document.body.offsetHeight - 600
      ) {
        load(false);
      }
    });
  }

  /* ---------------- 详情 ---------------- */

  function closeDrawer() {
    drawer.classList.remove("is-open");
    mask.classList.remove("is-open");
    /* 看过一个字体就刷新常用区：关掉抽屉马上能看到它排上来，
       否则用户用了几次都以为这个功能没生效 */
    loadFav();
    /* 清掉深链，但用 replaceState 免得每开一次详情就往历史里塞一条 */
    if (history.replaceState && /#font=/.test(location.hash)) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  }

  document.getElementById("drawerClose").addEventListener("click", closeDrawer);
  mask.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeDrawer();
  });

  function row(k, v, mono) {
    return (
      '<div class="detail-row"><span class="k">' +
      esc(k) +
      '</span><span class="v' +
      (mono ? " mono" : "") +
      '">' +
      (typeof v === "string" ? esc(v) : v) +
      "</span></div>"
    );
  }

  function openDetail(id) {
    drawerBody.innerHTML = '<div style="color:#8b8b96;padding:20px 0">加载中…</div>';
    drawer.classList.add("is-open");
    mask.classList.add("is-open");

    /* 记到地址栏，刷新或分享链接能回到同一个字体 */
    if (history.replaceState) {
      var want = "#font=" + id;
      if (location.hash !== want) {
        history.replaceState(null, "", location.pathname + location.search + want);
      }
    }

    fetch(API + "/api/fonts/" + id)
      .then(function (r) {
        return r.json();
      })
      .then(function (f) {
        var displayName = f.familyZh || f.family || "";
        var html = "";

        html += '<div class="detail-title">' + esc(displayName) + "</div>";
        html += '<div class="detail-sub">' + esc(f.postScriptName) + "</div>";

        html +=
          '<div class="detail-preview"><img src="' +
          previewUrl(f.id, f.hasCJK ? "永和九年 岁在癸丑" : "Aa Bb Cc", 44, 360) +
          '" alt=""></div>';

        /* 文件内容完全相同的另一份：这种重复装两份纯属占空间 */
        var fileDupes = f.fileDupes || [];
        if (fileDupes.length) {
          var waste = (f.fileSize || 0) * fileDupes.length;
          html += '<div class="dup-note">';
          html +=
            "<b>磁盘上有 " +
            (fileDupes.length + 1) +
            " 份一模一样的文件</b><br>";
          html +=
            "逐字节相同，只是路径或文件名不同，多装几份不会让字体更好用" +
            (waste > 0 ? "，去掉多余的可省 " + fmtSize(waste) : "") +
            "。<br>";
          for (var d = 0; d < fileDupes.length; d++) {
            var df = fileDupes[d];
            html +=
              '<span class="dup-item" data-id="' +
              df.id +
              '" title="' +
              esc(df.filePath || "") +
              '">' +
              esc((df.fileName || df.postScriptName) + "  ·  " + (df.scope === "user" ? "用户级" : "系统级")) +
              "</span>";
          }
          html += "</div>";
        }

        /* 同家族字重 */
        var sibs = f.siblings || [];
        if (sibs.length > 1) {
          html +=
            '<div class="sib-title">该家族共 ' + sibs.length + " 个字重</div>";
          html += '<div class="sib-list">';
          for (var i = 0; i < sibs.length; i++) {
            var s = sibs[i];
            var active = s.id === f.id ? " is-active" : "";
            var marks = "";
            /* 两种重复要分清：名字撞车 vs 磁盘上有好几份相同文件 */
            if (s.duplicateOf) marks += '<span class="badge dup">同名</span>';
            if (s.hasFileDup) marks += '<span class="badge dup">双份</span>';
            if (s.health === "unregistered")
              marks += '<span class="badge warn">未注册</span>';
            if (s.health === "suspicious")
              marks += '<span class="badge warn">残片</span>';
            html +=
              '<button class="sib' +
              active +
              '" data-id="' +
              s.id +
              '">' +
              '<span class="sib-name">' +
              esc(s.label || s.subfamily || s.postScriptName) +
              "</span>" +
              marks +
              '<span class="sib-w">' +
              s.weightClass +
              "</span></button>";
          }
          html += "</div>";
        }

        /* 操作按钮紧跟字重选择，不用滚到抽屉最底部 */
        var actions = "";
        if (isCEP) {
          actions +=
            '<button class="btn primary" id="btnApply">应用到选中的文字</button>';
        }
        if (f.installedRecordId) {
          actions +=
            '<button class="btn danger" id="btnUninstall">卸载这个字体</button>';
        }
        if (actions) {
          html += '<div class="detail-actions">' + actions + "</div>";
        }

        html += row("家族名（英）", f.family);
        if (f.familyZh && f.familyZh !== f.family)
          html += row("本地名称", f.familyZh);
        html += row("字重", f.subfamily);
        html += row("分类", CAT_LABEL[f.category] || f.category);
        html += row("字重值", String(f.weightClass));
        html += row(
          "变量字体",
          f.isVariable
            ? "是" +
                ((f.variationAxes || [])
                  .map(function (a) {
                    return " " + a.tag;
                  })
                  .join("") || "")
            : "否"
        );
        html += row("字形数", (f.glyphCount || 0).toLocaleString());
        html += row("含中文字形", f.hasCJK ? "是" : "否");
        html += row("等宽", f.isFixedPitch ? "是" : "否");
        html += row("来源", f.scope === "user" ? "用户级" : "系统级");
        html += row(
          "状态",
          f.health === "ok"
            ? "正常"
            : f.health === "unregistered"
              ? "未注册（文件在，系统不认）"
              : f.health === "suspicious"
                ? "疑似残片"
                : "文件丢失"
        );
        html += row(
          "格式 / 大小",
          (f.format || "").toUpperCase() + " · " + fmtSize(f.fileSize)
        );
        if (f.collectionIndex > 0)
          html += row("集合索引", "TTC 第 " + f.collectionIndex + " 个");
        html += row("文件", f.filePath, true);

        /* 相似字体：字形轮廓算出来的，不是靠名字猜的 */
        var sim = f.similar || [];
        if (sim.length) {
          html += '<div class="sib-title">看起来相近的字体</div>';
          html += '<div class="sib-list">';
          for (var k = 0; k < sim.length; k++) {
            var sn = sim[k];
            var glyphText = sn.hasCJK ? "永" : "Aa";
            html +=
              '<button class="sim" data-id="' + sn.id + '">' +
              '<span class="sim-glyph"><img src="' +
              previewUrl(sn.id, glyphText, 30, 34) +
              '" alt=""></span>' +
              '<span class="sim-main">' +
              '<span class="sim-name">' +
              esc(sn.familyZh || sn.family || sn.postScriptName) +
              "</span>" +
              '<span class="sim-bar"><i style="width:' +
              Math.round(sn.score * 100) +
              '%"></i></span></span>' +
              '<span class="sim-score">' +
              Math.round(sn.score * 100) +
              "%</span></button>";
          }
          html += "</div>";
        }

        drawerBody.innerHTML = html;

        /* 字重切换 */
        var sibBtns = drawerBody.querySelectorAll(".sib");
        Array.prototype.forEach.call(sibBtns, function (b) {
          b.addEventListener("click", function () {
            openDetail(b.getAttribute("data-id"));
          });
        });

        /* 相似字体、重复副本：点一下直接跳过去 */
        var jumpBtns = drawerBody.querySelectorAll(".sim, .dup-item");
        Array.prototype.forEach.call(jumpBtns, function (b) {
          b.addEventListener("click", function () {
            openDetail(b.getAttribute("data-id"));
          });
        });

        var btn = document.getElementById("btnApply");
        if (btn && isCEP) {
          btn.addEventListener("click", function () {
            applyToSelection(f.postScriptName, btn);
          });
        }

        var unBtn = document.getElementById("btnUninstall");
        if (unBtn && f.installedRecordId) {
          unBtn.addEventListener("click", function () {
            uninstallRecord(f.installedRecordId, unBtn);
          });
        }
      })
      .catch(function (e) {
        drawerBody.innerHTML =
          '<div style="color:#ff6b6b">加载失败：' + esc(e.message) + "</div>";
      });
  }

  /* ---------------- AI 交互 ---------------- */

  function applyToSelection(psName, btn) {
    btn.disabled = true;
    btn.textContent = "应用中…";
    var safe = String(psName).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    /* 走 evalJsx 而不是直接碰 __adobe_cep__：iframe 里直调回调回不来 */
    evalJsx('fdApplyFont("' + safe + '")', 30000)
      .then(function (o) {
        btn.textContent = o && o.ok ? "已应用到 " + o.changed + " 处" : (o && o.error) || "失败";
        /* 真正把字体应用到画布上 —— 这是「常用」里最重的一票 */
        if (o && o.ok) hitUsage(psName, 3);
      })
      .catch(function (e) {
        btn.textContent = "失败：" + (e.message || e);
      })
      .then(function () {
        btn.disabled = false;
        setTimeout(function () {
          btn.textContent = "应用到选中的文字";
        }, 2200);
      });
  }

  /* ---------------- 安装 / 卸载 ---------------- */

  var toastEl = document.getElementById("toast");
  var toastTimer = null;

  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.className = "toast is-on" + (isErr ? " err" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.className = "toast";
    }, 3800);
  }

  function afterInstall(d) {
    if (d && d.ok) {
      var names = (d.record && d.record.faces ? d.record.faces : [])
        .map(function (f) {
          return f.family;
        })
        .filter(function (v, i, a) {
          return a.indexOf(v) === i;
        })
        .join(" / ");
      toast("已安装：" + (names || d.record.fileName));
      state.q = "";
      searchEl.value = "";
      load(true);
    } else {
      toast((d && d.error) || "安装失败", true);
    }
  }

  function installByPath(p) {
    toast("正在安装…");
    fetch(API + "/api/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(afterInstall)
      .catch(function (e) {
        toast("安装失败：" + e.message, true);
      });
  }

  function installByFile(file) {
    toast("正在上传 " + file.name + "…");
    fetch(API + "/api/install-raw", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": encodeURIComponent(file.name),
      },
      body: file,
    })
      .then(function (r) {
        return r.json();
      })
      .then(afterInstall)
      .catch(function (e) {
        toast("安装失败：" + e.message, true);
      });
  }

  function pickFonts() {
    /* CEP 面板里能直接调 Adobe 的文件对话框，拿到真实本地路径 */
    if (
      window.cep &&
      window.cep.fs &&
      typeof window.cep.fs.showOpenDialog === "function"
    ) {
      var r = window.cep.fs.showOpenDialog(
        false,
        false,
        "选择要安装的字体",
        "",
        ["ttf", "otf", "ttc", "otc"]
      );
      if (r && r.err === 0 && r.data && r.data.length) {
        installByPath(r.data[0]);
      }
      return;
    }

    /* 浏览器里用 file input + 二进制上传 */
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".ttf,.otf,.ttc,.otc";
    input.multiple = true;
    input.onchange = function () {
      var files = input.files;
      if (!files || !files.length) return;
      var i = 0;
      (function next() {
        if (i >= files.length) return;
        installByFile(files[i++]);
        setTimeout(next, 1500);
      })();
    };
    input.click();
  }

  document.getElementById("btnInstall").addEventListener("click", pickFonts);

  /* 拖拽安装 */
  var dropHint = document.getElementById("dropHint");
  var dragDepth = 0;

  document.addEventListener("dragenter", function (e) {
    e.preventDefault();
    dragDepth++;
    if (dropHint) dropHint.classList.add("is-on");
  });

  document.addEventListener("dragover", function (e) {
    e.preventDefault();
  });

  document.addEventListener("dragleave", function (e) {
    e.preventDefault();
    dragDepth--;
    if (dragDepth <= 0) {
      dragDepth = 0;
      if (dropHint) dropHint.classList.remove("is-on");
    }
  });

  document.addEventListener("drop", function (e) {
    e.preventDefault();
    dragDepth = 0;
    if (dropHint) dropHint.classList.remove("is-on");

    var files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;

    var list = [];
    for (var i = 0; i < files.length; i++) {
      if (/\.(ttf|otf|ttc|otc)$/i.test(files[i].name)) list.push(files[i]);
    }
    if (!list.length) {
      toast("拖进来的不是字体文件（支持 ttf / otf / ttc / otc）", true);
      return;
    }

    var j = 0;
    (function next() {
      if (j >= list.length) return;
      installByFile(list[j++]);
      setTimeout(next, 1500);
    })();
  });

  function uninstallRecord(recordId, btn) {
    if (!btn.getAttribute("data-confirm")) {
      btn.setAttribute("data-confirm", "1");
      btn.textContent = "再点一次确认卸载";
      setTimeout(function () {
        if (btn.getAttribute("data-confirm")) {
          btn.removeAttribute("data-confirm");
          btn.textContent = "卸载这个字体";
        }
      }, 4500);
      return;
    }

    btn.disabled = true;
    btn.textContent = "卸载中…";
    fetch(API + "/api/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: recordId }),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (d.ok) {
          toast("已卸载，文件已移到备份目录，可还原");
          closeDrawer();
          load(true);
        } else {
          btn.disabled = false;
          btn.removeAttribute("data-confirm");
          btn.textContent = "卸载这个字体";
          toast(d.error || "卸载失败", true);
        }
      })
      .catch(function (e) {
        btn.disabled = false;
        btn.textContent = "卸载这个字体";
        toast("卸载失败：" + e.message, true);
      });
  }

  /* ---------------- 功能区切换 ---------------- */

  var tabs = document.querySelectorAll(".tab");

  function switchPane(pane) {
    Array.prototype.forEach.call(tabs, function (x) {
      x.classList.toggle("is-active", x.getAttribute("data-pane") === pane);
    });
    /* 给 body 打页签标记：CSS 靠它决定 tabs 要不要收下圆角
       （恢复页下方没有筛选条，tabs 就是那块的收口） */
    document.body.setAttribute("data-pane", pane);
    document.getElementById("pane-library").hidden = pane !== "library";
    document.getElementById("pane-recover").hidden = pane !== "recover";
    /* 切回字体库时刷一次常用：刚在恢复里用过的字体应该已经排上来了 */
    if (pane === "library") loadFav();
    /* 切到恢复页时顺手探一次桥，晚一点跑，避开面板刚打开时的忙 */
    if (pane === "recover") setTimeout(bridgeSelfCheck, 700);
  }

  Array.prototype.forEach.call(tabs, function (t) {
    t.addEventListener("click", function () {
      switchPane(t.getAttribute("data-pane"));
    });
  });

  /* #recover 直接打开恢复面板，方便收藏和分享 */
  if (location.hash === "#recover") switchPane("recover");
  else document.body.setAttribute("data-pane", "library");

  /* 吸顶偏移不能写死。实测顶栏高 87.5px，而 tabs 的 top 写的是 92px ——
     中间 4.5px 的缝在滚动时会让下面的卡片整条透出来（用户圈的那条）。
     filters 同理，写 131 比真实值多 6.5px。这里按实测高度回写 CSS 变量，
     以后改顶栏内边距、或字号变化导致换行，都不用再手动同步这几个数。 */
  var lastSticky = "";
  function syncStickyTops() {
    var tb = document.querySelector(".topbar");
    var tabBox = document.getElementById("tabs");
    if (!tb || !tabBox) return;
    /* 用 rect.height 不用 offsetHeight：前者保留小数（顶栏实测 87.5），
       后者取整成 88，会留下 0.5px 的缝 —— 在 2x 屏上正好是一整条物理像素。 */
    var h1 = tb.getBoundingClientRect().height;
    var h2 = tabBox.getBoundingClientRect().height;
    /* 字体到位前后 tab 行高会变（实测 39.5 → 37），所以只在真的变了才写，
       避免 ResizeObserver 回调里写变量 → 再触发布局 → 再回调的死循环 */
    var key = h1 + "/" + h2;
    if (key === lastSticky) return;
    lastSticky = key;
    var root = document.documentElement.style;
    root.setProperty("--topbar-h", h1 + "px");
    root.setProperty("--tabs-h", h2 + "px");
  }
  syncStickyTops();
  window.addEventListener("resize", function () {
    lastSticky = "";   /* 尺寸可能变，强制重测 */
    syncStickyTops();
  });
  if (window.ResizeObserver) {
    var ro = new ResizeObserver(function () {
      syncStickyTops();
    });
    var tbEl = document.querySelector(".topbar");
    var tabEl = document.getElementById("tabs");
    if (tbEl) ro.observe(tbEl);
    if (tabEl) ro.observe(tabEl);
  }
  /* 字体到位后行高可能变，补测一次 */
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      syncStickyTops();
    });
  }

  /* 早先这里挂了滚动监听，滚动时把吸顶块的下圆角收成直角来避免漏内容。
     现在改由 CSS 的 ::after 给板块间隙垫实底（连圆角被裁掉的三角一起盖住），
     圆角可以常驻，这段逻辑已不需要。 */

  /* ---------------- 恢复转曲 ---------------- */

  var recScanBtn = document.getElementById("recScanBtn");
  var recStatusEl = document.getElementById("recStatus");
  var recResultEl = document.getElementById("recResult");
  var recProgressEl = document.getElementById("recProgress");
  var recProgressBar = document.getElementById("recProgressBar");
  var recProgressText = document.getElementById("recProgressText");
  var recProgressPct = document.getElementById("recProgressPct");
  var recProgressTimer = null;
  var recWaitTimer = null;
  var recWaitStart = 0;
  /** AI 侧扫描结果（图片路径 + 轮廓框） */
  var recScan = null;
  /** 服务端识别结果 */
  var recChars = null;
  var recLines = null;
  /**
   * 行内分段结果。null = 不分段（走原来的整行恢复）。
   * 每项：{ box, doc, text, score, font, fontAlt, candidates }
   */
  var recSegments = null;
  /** 分段是「整行分数低、服务端自动拆的」还是用户手动点的（只影响提示文案） */
  var recSegAuto = false;
  /**
   * ps 名 → 垂直补偿量 lift（em）。
   *
   * AI 的文本框 visibleBounds 下边是「行框底」（基线 − descent×字号），
   * 不是字形墨迹底。恢复时直接拿它对位，整行会按该字体的 descender 上移，
   * 而且换字体偏移量就变。lift = descent + inkBottom（服务端按字体实测），
   * 恢复时用它把行框底补回墨迹位置。
   */
  var recLifts = {};

  function rememberLifts(list) {
    for (var i = 0; list && i < list.length; i++) {
      var c = list[i];
      if (!c || !c.postScriptName) continue;
      if (typeof c.descent !== "number" || typeof c.inkBottom !== "number") continue;
      recLifts[c.postScriptName] =
        Math.round((c.descent + c.inkBottom) * 1000) / 1000;
    }
  }
  /* 最近一次识别的完整上下文，生成诊断日志时用 */
  var reportCtx = { geom: {}, recognize: {}, font: {}, apply: {}, ui: {} };

  function recStatus(msg, isErr) {
    recStatusEl.textContent = msg || "";
    recStatusEl.className = "rec-status" + (isErr ? " is-err" : "");
  }

  /**
   * 识别进度条。阶段是离散里程碑，不是真实耗时百分比；条上的流动光带
   * 负责表达「当前这一阶段还在跑」——服务端渲染识别可能要 10 秒以上，
   * 只给一个静止的数字会让人以为卡死。pct 传 null 表示收起。
   */
  function recProgress(pct, label) {
    if (recProgressTimer) clearTimeout(recProgressTimer);
    recProgressTimer = null;

    if (pct === null) {
      recProgressEl.hidden = true;
      recProgressBar.style.width = "0%";
      return;
    }

    var n = Math.max(0, Math.min(100, Math.round(pct)));
    recProgressEl.hidden = false;
    recProgressBar.style.width = n + "%";
    recProgressText.textContent = label || "处理中";
    recProgressPct.textContent = n + "%";

    if (n >= 100) {
      recProgressTimer = setTimeout(function () {
        recProgressEl.hidden = true;
        recProgressTimer = null;
      }, 700);
    }
  }

  /**
   * 服务端「渲染 + 识别」是一次长请求，中间没有任何回传：18 行俄语长文
   * 实测约 57 秒。只把进度条钉在 62% 会让人以为面板卡死，所以等待期间
   * 按耗时渐近推进数字，并把已用时写进文案；到 92% 后就停在那儿等结果。
   * 这是「还活着」的心跳，不是真实完成度，真完成仍以 100% 为准。
   */
  function recWaitBegin() {
    recWaitStop();
    recWaitStart = Date.now();
    recWaitTimer = setInterval(function () {
      var sec = Math.round((Date.now() - recWaitStart) / 1000);
      var n = 62 + 30 * (1 - Math.exp(-sec / 22));
      var label = "渲染与识别 · 已用时 " + sec + "s";
      if (sec >= 15) label += "（长文较慢）";
      recProgress(n, label);
    }, 1200);
  }

  function recWaitStop() {
    if (recWaitTimer) clearInterval(recWaitTimer);
    recWaitTimer = null;
  }

  /**
   * 调 ExtendScript 并等结果。
   *
   * 关键：这段代码跑在 iframe 里（UI 由本地服务提供），而 CEP 的
   * __adobe_cep__.evalScript 只在顶层扩展页真正绑定到 Host。
   * 在跨源 iframe 里那个对象存在、调用也不抛错，**回调却永远不回来** ——
   * 这就是之前「点了按钮干等、最后超时」的真正原因，跟 JSX 快慢无关。
   *
   * 所以这里分两条路：顶层直接调；iframe 用 postMessage 交给顶层执行。
   *
   * 超时是必须的：桥断或 Host 忙的时候，没有回调可用，只能靠它收场。
   */
  var BRIDGE_TAG = "__fontdeck_bridge__";
  var jsxSeq = 0;
  var jsxPending = {};

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.tag !== BRIDGE_TAG || d.type !== "jsxResult") return;

    var p = jsxPending[d.id];
    if (!p) return;
    delete jsxPending[d.id];

    if (d.error) p.fail(new Error(String(d.error)));
    else p.parse(String(d.value == null ? "" : d.value));
  });

  function evalJsx(code, timeoutMs) {
    var timeout = timeoutMs || 8000;

    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;

      function done(fn, val) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        fn(val);
      }

      function fail(msg) {
        done(reject, msg instanceof Error ? msg : new Error(msg));
      }

      function parse(text) {
        /* CEP 在脚本抛异常或函数不存在时回这个固定字符串 */
        if (text.indexOf("EvalScript error") >= 0) {
          fail("AI 侧脚本没加载，请完全退出 Illustrator 后重开");
          return;
        }
        try {
          done(resolve, JSON.parse(text));
        } catch (e) {
          fail("AI 返回无法解析" + (text ? "：" + text.slice(0, 100) : "（空）"));
        }
      }

      timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            "Illustrator " +
              Math.round(timeout / 1000) +
              " 秒没回话。先看 Illustrator 里有没有没关的对话框；" +
              "都没有的话，把面板关掉再打开一次"
          )
        );
      }, timeout);

      /* --- 顶层页面：桥就在本窗口，直接调 --- */
      if (window.parent === window) {
        if (!window.__adobe_cep__ || typeof window.__adobe_cep__.evalScript !== "function") {
          fail("这个功能只能在 Illustrator 面板里用");
          return;
        }
        try {
          window.__adobe_cep__.evalScript(code, function (raw) {
            parse(String(raw == null ? "" : raw));
          });
        } catch (e) {
          fail(e);
        }
        return;
      }

      /* --- iframe：转交顶层执行 --- */
      if (!isCEP) {
        fail("这个功能只能在 Illustrator 面板里用");
        return;
      }

      var id = "jx" + ++jsxSeq;
      jsxPending[id] = { parse: parse, fail: fail };

      try {
        window.parent.postMessage(
          { tag: BRIDGE_TAG, type: "jsx", id: id, code: code },
          "*"
        );
      } catch (e) {
        delete jsxPending[id];
        fail(e);
      }
    });
  }

  /**
   * 识别选中的转曲文字。
   *
   * 走两步：先 fdPing 确认 AI 侧脚本活着（失败能立刻说清是脚本没加载），
   * 再 fdRecoverGeometry 只取路径坐标。
   *
   * 为什么不取图片：让 AI 导出 PNG 会卡死 UI 线程，回调永不返回。
   * 坐标交给服务端自己画，快且不会动用户文档。
   */
  function doRecoverScan() {
    recScanBtn.disabled = true;
    recResultEl.innerHTML = "";
    recStatus("");
    recProgress(8, "连接 Illustrator");
    reportCtx = { geom: {}, recognize: {}, font: {}, apply: {}, ui: {} };

    /*
     * 探活用 fdPingLite 而不是 fdPing：后者要读 app.textFonts.length，
     * 本机 1104 个 face 光枚举就要好几秒，用它当探活会把「慢」误报成「卡死」。
     * fdPingLite 只读 app.version，毫秒级。
     */
    evalJsx("fdPingLite()", 15000)
      .then(function (p) {
        if (!p || !p.ok) throw new Error((p && p.error) || "Illustrator 侧没准备好");
        if (!p.hasGeom) {
          throw new Error(
            "面板脚本是旧版，需要完全退出 Illustrator 再重新打开（不是关文档）"
          );
        }
        if (p.docs === 0) throw new Error("Illustrator 里没有打开的文档");
        reportCtx.appVersion = p.appVersion || "";
        recProgress(32, "读取路径坐标");
        return evalJsx("fdRecoverGeometry(4)", 45000);
      })
      .then(function (geom) {
        if (!geom || !geom.ok) throw new Error((geom && geom.error) || "读取选区失败");
        if (!geom.shapes || geom.shapes.length === 0) {
          throw new Error("选中的对象里没有填充路径");
        }

        recProgress(62, "渲染与识别");
        recWaitBegin();
        reportCtx.geom = geom;

        return fetch(API + "/api/recover/geometry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(geom),
        });
      })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.ok) throw new Error((d && d.error) || "识别失败");
        recChars = d.chars;
        recLines = d.lines || [];
        recScan = d;
        /* 新一轮识别：上一轮的分段（尤其自动拆的）必须清掉，否则会拿旧段落点恢复 */
        recSegments = null;
        recSegAuto = false;
        reportCtx.recognize = d;
        renderRecoverResult(d, d);
        recWaitStop();
        recProgress(100, "识别完成");
        /* 字体匹配单独异步跑：它要 2 秒左右，不该卡住「先看到字」 */
        doMatchFont(d);
      })
      .catch(function (e) {
        var msg = e.message || String(e);
        reportCtx.ui.lastError = msg;
        recWaitStop();
        recProgress(null);
        recStatus(msg, true);
        recChars = null;
        recLines = null;
        recSegments = null;
        recSegAuto = false;
        /* 彻底失败时也得留一个报日志的入口，否则最需要反馈的时候反而没按钮 */
        if (!recResultEl.querySelector("#recReportBtn")) {
          renderRecoverResult({ chars: [], lines: [], stats: {} }, null);
        }
      })
      .then(function () {
        recScanBtn.disabled = false;
      });
  }

  function renderRecoverResult(d, scan) {
    var s = d.stats || {};
    var html = "";

    html += '<div class="rec-summary">';
    html += "<span>识别 <b>" + (s.chars || 0) + "</b> 个单元</span>";
    html += "<span>行 <b>" + (s.rows || 0) + "</b></span>";
    if (s.emptyCount) html += "<span>空白 <b>" + s.emptyCount + "</b></span>";
    html += "<span>耗时 <b>" + (s.durationMs || 0) + "ms</b></span>";
    html += "</div>";

    /*
     * 整块文字被旋转 180° 时 OCR 会彻底崩（实测平均 0.176，读成
     * "areeaase"），字体比对、字号闭环、位置全被这串乱码带偏，用户会
     * 一次报「少字 / 认错 / 字体不对 / 字号不对 / 位置不对」五个问题。
     *
     * 按用户决定：旋转识别保持冻结，**不自动摆正**。这里只给结论 +
     * 翻正后读到的原文，让用户在 AI 里把稿子转正再识别 —— 这样恢复
     * 出来的文字方向和位置才与原稿一致，比自动翻正更干净。
     */
    var flipText = String(d.flipText || "");
    if (d.likelyFlipped180) {
      html += '<div class="rec-flipped">';
      html += "<b>整块文字倒置 180°</b>";
      html +=
        '<div class="rec-flipped-sub">当前结果不可用 —— 转正后点「重新识别」。</div>';
      if (flipText) {
        html +=
          '<div class="rec-flipped-text"><span>翻正后读到的原文</span><code>' +
          esc(flipText).replace(/\n/g, "<br>") +
          "</code></div>";
        html +=
          '<button type="button" id="recFlipFillBtn" class="rec-flip-btn">把这段原文填入</button>';
        html +=
          '<div class="rec-flipped-note">只填文字，字体仍需转正后重新识别。</div>';
      }
      html += "</div>";
    }

    /*
     * 整行识别结果放主位。
     * 西文逐字切框必然错（字母不等宽、空格无轮廓），只有整行识别能拿到
     * 带空格的完整句子；中文整行识别的置信度（0.82~0.93）也高于逐字（0.4~0.5）。
     */
    var lines = d.lines || [];
    var lineText = lines
      .map(function (l) {
        return l.text || "";
      })
      .join("\n");
    if (lineText.replace(/\s/g, "")) {
      var topScore = 0;
      for (var li = 0; li < lines.length; li++) {
        topScore = Math.max(topScore, lines[li].score || 0);
      }
      /*
       * 置信度低时主动提醒粘原文。
       *
       * 字体比对是拿「识别出的整句话」去逐个渲染候选字体比对的，
       * 错一个字母，整行宽度和字形就全变，排名跟着歪；字号又靠整行
       * 宽度闭环，字体一错字号/位置看着也偏。实测一份 0.84 的英文稿，
       * 把 Weltop/Intlligent 改回 Welltop/Intelligent 后，
       * Top1 从 Aptos 变成 DM Sans，原第一名直接掉出前八。
       * 所以这个提示不是"建议"，是唯一的可靠解法。
       */
      var lowConf = topScore > 0 && topScore < 0.9;
      html += '<div class="rec-line">';
      if (lowConf) {
        html +=
          '<div class="rec-lowconf">置信度 ' +
          Math.round(topScore * 100) +
          "%，可能有错字，粘原文重算。</div>";
      }
      html +=
        '<div class="rec-line-label">整行识别结果 <span' +
        (lowConf ? ' class="is-low"' : "") +
        ">置信度 " +
        Math.round(topScore * 100) +
        "%</span></div>";
      html +=
        '<textarea id="recLineText" class="rec-line-input" rows="' +
        Math.min(4, Math.max(2, lines.length)) +
        '" spellcheck="false">' +
        esc(lineText) +
        "</textarea>";
      html +=
        '<div class="rec-line-hint">恢复时直接用这里的内容（空格、标点都在）。' +
        "英文必须用这个；要逐格改字再展开下面。</div>";
      /*
       * 行内分段：同一行里字号/字体不一样时要分开恢复。
       * 只支持单行（多行请先用「按行拆分」），控件只在单行时出现。
       */
      if (lines.length === 1) {
        html += '<div class="rec-splitbar">';
        html +=
          '<span class="rec-split-tip">字号或字体不一样？按空隙拆开</span>';
        html += '<button type="button" class="rec-split-btn" data-n="2">2 段</button>';
        html += '<button type="button" class="rec-split-btn" data-n="3">3 段</button>';
        html += "</div>";
        html += '<div id="recSegBox" class="rec-segs"></div>';
      }
      html += "</div>";
    }

    /* 字体推荐的容器，稍后由 doMatchFont 异步填 */
    html += '<div id="recFontBox" class="rec-font"></div>';

    /* 逐字框降级为可折叠的校对区 */
    html +=
      '<details class="rec-raw"><summary>逐字校对（' +
      d.chars.length +
      " 格，英文不适用）</summary>";
    html += '<div class="rec-chars">';
    for (var i = 0; i < d.chars.length; i++) {
      var c = d.chars[i];
      var cls = "rec-char";
      if (!c.ch) cls += " is-empty";
      else if (String(c.ch).length > 1) cls += " is-low";
      else if (c.score < 0.32) cls += " is-low";
      var q = c.error ? "!" : Math.round((c.score || 0) * 100);
      html +=
        '<div class="' +
        cls +
        '" title="' +
        esc(c.error || "置信度 " + ((c.score || 0) * 100).toFixed(0) + "%") +
        '">' +
        '<input data-i="' +
        i +
        '" value="' +
        esc(c.ch) +
        '" maxlength="6" spellcheck="false">' +
        '<span class="q">' +
        q +
        "</span></div>";
    }
    html += "</div></details>";

    /* 整句回填：粘贴原文比逐格改快得多。
       有整行结果时直接覆盖整行输入框，否则按顺序填进逐字格。 */
    html += '<div class="rec-paste' + (lowConf ? " is-alert" : "") + '">';
    html +=
      '<input id="recPasteInput" class="rec-paste-input" spellcheck="false" ' +
      'placeholder="知道原文？粘贴整句，一键填回（含标点）">';
    html += '<button class="btn" id="recPasteBtn">填入</button>';
    html += "</div>";
    html += '<div id="recPasteHint" class="rec-note" hidden></div>';

    html += '<div class="rec-actions">';
    html += '<button class="btn primary" id="recApplyBtn">恢复为可编辑文字</button>';
    html += '<button class="btn" id="recRescanBtn">重新识别</button>';
    html += "</div>";

    if (scan && scan.textFrames > 0) {
      html +=
        '<div class="rec-note">选区里还留着 ' +
        scan.textFrames +
        " 个真实文本框，它们不会被改动，只处理已转曲的部分。</div>";
    }
    html +=
      '<div class="rec-note">数字化表示置信度，低于 32 的会标黄、空白的标红；' +
      "一格出现多个字也标黄（多半是切框把两字并在一起），用上面的粘贴框最快。" +
      "改完字再点恢复；恢复出来的文字放在新图层，原转曲对象保持不动。</div>";

    /* 一键诊断日志：勾问题 → 生成 → 自动复制，直接粘给开发者 */
    html += '<div class="rec-feedback">';
    html +=
      '<button class="rec-feedback-toggle" id="recFeedbackToggle">这次识别有问题？生成诊断日志</button>';
    html += '<div id="recFeedbackBody" class="rec-feedback-body" hidden>';
    html += '<div class="rec-line-label">选一下出了什么问题（可多选）</div>';
    var issueList = [
      "识别不出 / 卡住没反应",
      "少字或多字",
      "文字认错",
      "字体不对",
      "字号或字距不对",
      "恢复后位置不对",
      "其他",
    ];
    html += '<div class="rec-issues">';
    for (var z = 0; z < issueList.length; z++) {
      html +=
        '<label><input type="checkbox" value="' +
        esc(issueList[z]) +
        '"><span>' +
        esc(issueList[z]) +
        "</span></label>";
    }
    html += "</div>";
    html +=
      '<input id="recFeedbackNote" class="rec-paste-input" placeholder="补充一句（可选），比如原文实际是什么">';
    html +=
      '<div class="rec-feedback-row"><button class="btn primary" id="recReportBtn">生成并复制日志</button></div>';
    html +=
      '<textarea id="recReportText" class="rec-report-text" rows="9" readonly hidden></textarea>';
    html += '<div id="recReportHint" class="rec-line-hint"></div>';
    html += "</div></div>";

    recResultEl.innerHTML = html;

    /* 倒转稿：一键把翻正识别到的原文填进整行框（跟「粘贴整句」同一条路） */
    var flipBtn = document.getElementById("recFlipFillBtn");
    if (flipBtn && flipText) {
      flipBtn.addEventListener("click", function () {
        var lineEl = document.getElementById("recLineText");
        if (!lineEl) return;
        lineEl.value = flipText;
        var hint = document.getElementById("recPasteHint");
        if (hint) {
          hint.hidden = false;
          hint.textContent = "已填入原文；字体仍需转正后重新识别。";
        }
        doMatchFont({ chars: [] });
      });
    }

    /* 行内分段按钮：单行才有，点一下按空隙拆开 */
    var splitBtns = recResultEl.querySelectorAll(".rec-split-btn");
    for (var sb = 0; sb < splitBtns.length; sb++) {
      splitBtns[sb].addEventListener("click", function () {
        doSplitLine(Number(this.getAttribute("data-n")), this);
      });
    }

    var fbToggle = document.getElementById("recFeedbackToggle");
    if (fbToggle) {
      fbToggle.addEventListener("click", function () {
        var b = document.getElementById("recFeedbackBody");
        if (b) b.hidden = !b.hidden;
      });
    }
    var repBtn = document.getElementById("recReportBtn");
    if (repBtn) repBtn.addEventListener("click", doReport);

    document
      .getElementById("recApplyBtn")
      .addEventListener("click", doRecoverApply);
    document
      .getElementById("recRescanBtn")
      .addEventListener("click", doRecoverScan);
    document
      .getElementById("recPasteBtn")
      .addEventListener("click", fillFromPastedText);
    var lineTextEl = document.getElementById("recLineText");
    if (lineTextEl) {
      lineTextEl.addEventListener("change", function () {
        doMatchFont({ chars: [] });
      });
    }
    document
      .getElementById("recPasteInput")
      .addEventListener("keydown", function (e) {
        if (e.key === "Enter") fillFromPastedText();
      });
  }

  /**
   * 生成诊断日志并自动复制。
   * CEP 的 Chromium 里 navigator.clipboard 未必可用，execCommand("copy") 更稳；
   * 万一都失败，日志文本框会显示出来让用户手动全选复制。
   */
  function doReport() {
    var btn = document.getElementById("recReportBtn");
    var hint = document.getElementById("recReportHint");
    var ta = document.getElementById("recReportText");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "正在生成…";
    }
    if (hint) hint.textContent = "";

    var issues = [];
    var checked = recResultEl.querySelectorAll(".rec-issues input:checked");
    for (var i = 0; i < checked.length; i++) issues.push(checked[i].value);

    var noteEl = document.getElementById("recFeedbackNote");
    var lineEl = document.getElementById("recLineText");
    var fontSel = document.getElementById("recFontSel");
    var scriptEl = document.querySelector('script[src*="app.js"]');
    var uiVer = scriptEl
      ? (String(scriptEl.src).match(/v=(\d+)/) || [null, "?"])[1]
      : "?";

    var payload = {
      issues: issues,
      note: noteEl ? noteEl.value : "",
      appVersion: reportCtx.appVersion || "",
      uiVersion: "v" + uiVer,
      serviceGeneratedAt: "",
      context: {
        geom: reportCtx.geom || {},
        recognize: reportCtx.recognize || {},
        font: reportCtx.font || {},
        apply: reportCtx.apply || {},
        ui: {
          lineText: lineEl ? lineEl.value : "",
          fontName: fontSel ? fontSel.value : "",
          /* 手动指定框会覆盖下拉，但是两个不同的元素 —— 不记下来就查不出
             「面板显示 A、恢复用了 B」到底是谁给的 B */
          fontManual: (function () {
            var m = document.getElementById("recFontManual");
            return m ? m.value : "";
          })(),
          requestedFont: (reportCtx.ui && reportCtx.ui.requestedFont) || "",
          autoSegment: !!(reportCtx.ui && reportCtx.ui.autoSegment),
          lastError: (reportCtx.ui && reportCtx.ui.lastError) || "",
        },
      },
    };

    fetch(API + "/api/health")
      .then(function (r) {
        return r.json();
      })
      .then(function (h) {
        payload.serviceGeneratedAt = h.generatedAt || "";
        return payload;
      })
      .catch(function () {
        return payload;
      })
      .then(function (p) {
        return fetch(API + "/api/feedback/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(p),
        });
      })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        if (!d || !d.ok) throw new Error((d && d.error) || "生成失败");
        if (ta) {
          ta.hidden = false;
          ta.value = d.text;
        }
        var copied = false;
        try {
          if (ta) {
            ta.focus();
            ta.select();
            copied = document.execCommand("copy");
          }
        } catch (e) {}
        if (hint) {
          hint.textContent = copied
            ? "已复制到剪贴板 —— 直接粘贴给我就行（日志 " + d.id + "）"
            : "已生成，请全选下面的文本框复制（日志 " + d.id + "）";
        }
      })
      .catch(function (e) {
        if (hint) hint.textContent = "生成失败：" + (e.message || e);
      })
      .then(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "生成并复制日志";
        }
      });
  }

  /**
   * 把用户粘贴的正确原文按字填入识别框。
   *
   * 用 Array.from 而不是 split("")：中文标点、英文、以及个别生僻字
   * 可能是代理对，split 会把它拆成两个残缺码元。
   *
   * 字数和框数不一致时仍然按顺序填，但明确告知差多少 ——
   * 差得多半意味着聚类阶段把两个字并成了一个框，或者漏切了标点，
   * 这时候光靠粘贴补不回位置，得重新识别。
   */
  function fillFromPastedText() {
    var el = document.getElementById("recPasteInput");
    var hint = document.getElementById("recPasteHint");
    if (!el) return;

    /* 整行模式下直接替换整行文本（含空格），不再逐格拆字 */
    var lineEl = document.getElementById("recLineText");
    if (lineEl) {
      var pasted = String(el.value || "").replace(/\r\n/g, "\n").trim();
      if (!pasted) return;
      lineEl.value = pasted;
      if (hint) {
        hint.hidden = false;
        hint.textContent = "已替换为原文，字体和字号重算中。";
      }
      el.value = "";
      /* 整行文本变了，字体比对必须重跑（它现在是拿这句话去渲染比对的） */
      doMatchFont({ chars: [] });
      return;
    }

    var chars = Array.from(String(el.value || "").replace(/[\r\n\t]/g, ""));
    if (chars.length === 0) return;

    var inputs = recResultEl.querySelectorAll(".rec-char input");
    var n = Math.min(chars.length, inputs.length);
    for (var i = 0; i < n; i++) {
      inputs[i].value = chars[i];
      var box = inputs[i].parentNode;
      box.classList.remove("is-empty", "is-low");
    }

    for (var j = n; j < inputs.length; j++) {
      inputs[j].value = "";
      inputs[j].parentNode.classList.add("is-empty");
    }

    if (hint) {
      if (chars.length === inputs.length) {
        hint.hidden = true;
        hint.textContent = "";
      } else {
        hint.hidden = false;
        hint.textContent =
          "原文 " +
          chars.length +
          " 字，识别 " +
          inputs.length +
          " 位，差 " +
          Math.abs(chars.length - inputs.length) +
          " 个；已按序填入前 " +
          n +
          " 位。差得多就重新识别。";
      }
    }

    /* 字变了，字体比对的参比字也该更新 */
    var updated = { chars: [] };
    for (var k = 0; k < recChars.length; k++) {
      var c = recChars[k];
      var box2 = recResultEl.querySelector('.rec-char input[data-i="' + k + '"]');
      updated.chars.push({
        ch: box2 ? box2.value : c.ch,
        score: c.score,
        box: c.box,
      });
    }
    doMatchFont(updated);
  }

  /* ---------------- 行内分段（一行里多套样式） ---------------- */

  /** POST JSON 小工具：拆段与逐段比对要调多次，避免每处重复 fetch 样板 */
  function postJson(pathname, body) {
    return fetch(API + pathname, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json();
    });
  }

  /**
   * 把当前这一行按墨迹空隙拆成 n 段，每段独立识别、独立比对字体。
   *
   * 为什么不做「自动判断哪里换了样式」：实测这批转曲稿做不到 ——
   * 单一样式稿笔画只有 2px，字重差异 ±1px 与栅格噪声同量级；同一行
   * 字框高度被大小写/标点主导（波动可达 ±40%）；整行渲染比对又会因
   * 字距漂移整体对不齐。三条路都验证过且区分度不足，硬切必然误伤。
   * 所以改成「用户给段数，系统只在真实空白列下刀」：空白列一定存在
   * （词间、标点旁），每段必然是完整字形，不会切断笔画。
   */
  function doSplitLine(n, btn) {
    if (!recScan || !recScan.png) {
      toast("先识别一次再拆段", true);
      return;
    }
    if (!recLines || recLines.length !== 1) {
      toast("拆段只支持单行；多行请先用「按行拆分」", true);
      return;
    }
    var ln = recLines[0];
    if (!ln || !ln.box) return;
    var box = [ln.box.l, ln.box.t, ln.box.r, ln.box.b];

    /* 用户手动点的段数，提示文案就不再说是「自动拆的」 */
    recSegAuto = false;
    var host = document.getElementById("recSegBox");
    if (host) host.innerHTML = '<div class="rec-seg-loading">正在按空隙拆分…</div>';
    if (btn) {
      btn.disabled = true;
      btn.textContent = "拆分中…";
    }

    postJson("/api/recover/split-line", { png: recScan.png, box: box, n: n })
      .then(function (d) {
        if (!d || !d.ok) throw new Error((d && d.error) || "拆分失败");
        var segs = d.segments || [];
        if (segs.length < 2) throw new Error("没找到足够空隙，拆不开");
        var boxes = segs.map(function (s) {
          return [s.l, s.t, s.r, s.b];
        });
        return postJson("/api/recover/ocr-lines", {
          png: recScan.png,
          boxes: boxes,
        }).then(function (o) {
          var ocr = (o && o.lines) || [];
          var scale = Number(recScan.scale) || 1;
          recSegments = segs.map(function (s, i) {
            return {
              box: s,
              text: (ocr[i] && ocr[i].text) || "",
              score: (ocr[i] && ocr[i].score) || 0,
              font: "",
              fontAlt: "",
              candidates: [],
              /* 段框是像素坐标，按行的 doc 线性换算（y 向上，所以用 b 差） */
              doc: {
                x: ln.doc.x + (s.l - box[0]) / scale,
                y: ln.doc.y + (box[3] - s.b) / scale,
                w: (s.r - s.l) / scale,
                h: (s.b - s.t) / scale,
              },
            };
          });
          renderSegments();
          for (var k = 0; k < recSegments.length; k++) matchSegmentFont(k);
        });
      })
      .catch(function (e) {
        if (host) {
          host.innerHTML =
            '<div class="rec-seg-error">' + esc(e.message || String(e)) + "</div>";
        }
      })
      .then(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = n + " 段";
        }
      });
  }

  /**
   * 采用服务端探测出来的分段（整行分数不可信时自动拆的）。
   *
   * 和用户手动点「2 段」的区别：文本、候选字体都已经在服务端算好了，
   * 这里只做像素框 → 文档坐标的换算，然后直接渲染成可编辑的段列表。
   * 用户仍能改文本、换字体、点「取消分段」回到整行结果。
   */
  function adoptAutoSegments(segs) {
    if (!recScan || !recScan.png || !recLines || recLines.length !== 1) return false;
    var ln = recLines[0];
    if (!ln || !ln.box || !ln.doc) return false;
    var box = [ln.box.l, ln.box.t, ln.box.r, ln.box.b];
    var scale = Number(recScan.scale) || 1;

    recSegments = segs.map(function (s) {
      var cand = s.candidates || [];
      rememberLifts(cand);
      return {
        box: { l: s.box[0], t: s.box[1], r: s.box[2], b: s.box[3] },
        text: s.text || "",
        score: s.score || 0,
        font: cand[0] ? cand[0].postScriptName : "",
        fontAlt: cand[0] ? cand[0].familyZh || cand[0].family || "" : "",
        fontFamily: cand[0] ? cand[0].family || cand[0].familyZh || "" : "",
        fontFull: cand[0]
          ? ((cand[0].family || "") + " " + (cand[0].subfamily || "")).trim()
          : "",
        candidates: cand,
        doc: {
          x: ln.doc.x + (s.box[0] - box[0]) / scale,
          y: ln.doc.y + (box[3] - s.box[3]) / scale,
          w: (s.box[2] - s.box[0]) / scale,
          h: (s.box[3] - s.box[1]) / scale,
        },
      };
    });
    if (recSegments.length < 2) {
      recSegments = null;
      return false;
    }
    recSegAuto = true;
    renderSegments();
    return true;
  }

  function renderSegments() {
    var host = document.getElementById("recSegBox");
    if (!host) return;

    var fontBox = document.getElementById("recFontBox");
    if (fontBox) fontBox.hidden = !!(recSegments && recSegments.length);

    if (!recSegments || !recSegments.length) {
      host.innerHTML = "";
      return;
    }

    var html =
      '<div class="rec-seg-head">已拆成 ' +
      recSegments.length +
      (recSegAuto ? " 段（整行分数低，自动拆开）" : " 段，每段独立字体/字号") +
      '<button type="button" id="recSegReset" class="rec-seg-reset">取消分段</button></div>';

    for (var i = 0; i < recSegments.length; i++) {
      var s = recSegments[i];
      html += '<div class="rec-seg" data-i="' + i + '">';
      html +=
        '<div class="rec-seg-meta">段 ' +
        (i + 1) +
        (s.score ? " · 置信度 " + Math.round(s.score * 100) + "%" : "") +
        "</div>";
      html +=
        '<input class="rec-seg-text" data-i="' +
        i +
        '" value="' +
        esc(s.text) +
        '" spellcheck="false">';
      html += '<select class="rec-seg-font" data-i="' + i + '">';
      if (!s.candidates || !s.candidates.length) {
        html += '<option value="">（比对字体中…）</option>';
      } else {
        for (var k = 0; k < s.candidates.length; k++) {
          var c = s.candidates[k];
          var nm = ((c.familyZh || c.family) + " " + (c.subfamily || "")).trim();
          html +=
            '<option value="' +
            esc(c.postScriptName) +
            '" data-alt="' +
            esc(c.familyZh || c.family || "") +
            '" data-family="' +
            esc(c.family || c.familyZh || "") +
            '" data-full="' +
            esc(((c.family || "") + " " + (c.subfamily || "")).trim()) +
            '"' +
            (c.postScriptName === s.font ? " selected" : "") +
            ">" +
            esc(nm) +
            " · " +
            c.rel +
            "%</option>";
        }
      }
      html += "</select></div>";
    }
    host.innerHTML = html;

    var texts = host.querySelectorAll(".rec-seg-text");
    for (var t = 0; t < texts.length; t++) {
      texts[t].addEventListener("change", function () {
        var i = Number(this.getAttribute("data-i"));
        if (recSegments[i]) {
          recSegments[i].text = this.value;
          /* 文本变了，字体比对的前提就变了，必须重算 */
          matchSegmentFont(i);
        }
      });
    }

    var sels = host.querySelectorAll(".rec-seg-font");
    for (var q = 0; q < sels.length; q++) {
      sels[q].addEventListener("change", function () {
        var i = Number(this.getAttribute("data-i"));
        var opt = this.options[this.selectedIndex];
        if (recSegments[i]) {
          recSegments[i].font = this.value;
          recSegments[i].fontAlt = opt ? opt.getAttribute("data-alt") || "" : "";
          recSegments[i].fontFamily = opt ? opt.getAttribute("data-family") || "" : "";
          recSegments[i].fontFull = opt ? opt.getAttribute("data-full") || "" : "";
        }
      });
    }

    var reset = document.getElementById("recSegReset");
    if (reset) {
      reset.addEventListener("click", function () {
        recSegments = null;
        recSegAuto = false;
        renderSegments();
      });
    }
  }

  /** 单独比对某一段的字体（各段样式不同，不能共用整行结果） */
  function matchSegmentFont(i) {
    var s = recSegments && recSegments[i];
    if (!s || !s.text || !recScan || !recScan.png) return;
    postJson("/api/recover/match", {
      png: recScan.png,
      chars: [],
      lines: [
        { text: s.text, box: [s.box.l, s.box.t, s.box.r, s.box.b], weight: 1 },
      ],
    })
      .then(function (d) {
        if (!d || !d.ok || !d.candidates || !d.candidates.length) return;
        rememberLifts(d.candidates);
        s.candidates = d.candidates;
        if (!s.font) {
          s.font = d.candidates[0].postScriptName;
          s.fontAlt = d.candidates[0].familyZh || d.candidates[0].family || "";
          s.fontFamily = d.candidates[0].family || s.fontAlt;
          s.fontFull = (
            (d.candidates[0].family || "") +
            " " +
            (d.candidates[0].subfamily || "")
          ).trim();
        }
        renderSegments();
      })
      .catch(function () {
        /* 单段比对失败不影响其它段 */
      });
  }

  /**
   * POST 遇到网络层失败自动重试一次。
   *
   * 浏览器对 GET 会自动重连重发，**对 POST 不会** —— 连接恰好在发出或收回
   * 的瞬间断掉（机器满载、服务被看门狗重新拉起、休眠唤醒之后最常见），
   * fetch 就直接抛 TypeError: Failed to fetch，服务端日志里一行都没有。
   * 字体比对要跑 10~30 秒，撞上这个窗口的概率不低，所以在客户端补一次。
   *
   * 只在网络层失败时重试：服务端明确回了 4xx/5xx 说明它已经处理过，
   * 重发等于让它再算一遍。
   */
  function postRetry(url, body, triesLeft) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(function (e) {
      if (triesLeft <= 0) {
        var err = new Error("Failed to fetch");
        err.network = true;
        err.detail = (e && e.message) || String(e);
        throw err;
      }
      return new Promise(function (r) {
        setTimeout(r, 400);
      }).then(function () {
        return postRetry(url, body, triesLeft - 1);
      });
    });
  }

  /** 猜原稿字体。慢（2 秒级），所以独立异步跑，不挡识别结果 */
  function doMatchFont(rec) {
    var host = document.getElementById("recFontBox");
    if (!host) return;

    var payload = { png: recScan.png, chars: [] };

    /*
     * 逐行比对：每行带自己的真实墨迹框和文本，服务端按墨迹面积加权。
     * 只拿第一行时，一旦那行文字有小错（比如 OCR 在左侧空白补出 "..."），
     * 整行形状就整体错位，所有字体挤成噪声；多行之间能互相纠偏。
     * 文本以面板里可编辑的为准，用户改过就用改过的。
     */
    var lineEl = document.getElementById("recLineText");
    if (lineEl && recLines && recLines.length) {
      var uiTexts = String(lineEl.value || "").split(/\r?\n/);
      var lineRows = [];
      for (var li = 0; li < recLines.length; li++) {
        var ln = recLines[li];
        if (!ln || !ln.box) continue;
        var oneText = String(uiTexts[li] || ln.text || "").trim();
        if (!oneText) continue;
        var lb = ln.box;
        lineRows.push({
          text: oneText,
          box: [lb.l, lb.t, lb.r, lb.b],
          weight: (lb.r - lb.l) * (lb.b - lb.t),
        });
      }
      if (lineRows.length) {
        /* 字体比对是「每行 × 全部字体」渲染，18 行要 28 秒。
           按信息量取文字最长的 5 行，长行已带足字形与字宽特征。 */
        if (lineRows.length > 5) {
          lineRows.sort(function (a, b) {
            return b.text.length - a.text.length;
          });
          lineRows = lineRows.slice(0, 5);
        }
        payload.lines = lineRows;
      }
    }

    if (!payload.lines) {
      /* 没有整行结果时才退回逐字样本；空的不参与 */
      var samples = [];
      for (var i = 0; i < (rec.chars || []).length; i++) {
        var c = rec.chars[i];
        if (!c.ch || !c.box) continue;
        samples.push({ ch: c.ch, score: c.score, box: [c.box.l, c.box.t, c.box.r, c.box.b] });
      }
      if (samples.length === 0) {
        host.innerHTML = "";
        return;
      }
      payload.chars = samples;
    }

    var busyFrom = Date.now();
    host.innerHTML =
      '<div class="rec-font-label is-busy">正在比对本机字体…<span class="rec-dots"></span></div>';

    /*
     * 比对要 10~30 秒（本机 783 个 face × 4 行）。这段时间界面只有几个点，
     * 用户会以为卡死 —— 实测报告里就写着「卡住没反应」。把秒数显示出来，
     * 等待就从「没反应」变成「在进行」。
     */
    var busyTimer = setInterval(function () {
      var el = host.querySelector(".rec-font-label.is-busy");
      if (!el) {
        clearInterval(busyTimer);
        return;
      }
      var s = Math.round((Date.now() - busyFrom) / 1000);
      el.innerHTML = "正在比对本机字体… " + s + " 秒<span class=\"rec-dots\"></span>";
    }, 1000);

    postRetry(API + "/api/recover/match", payload, 1)
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        clearInterval(busyTimer);
        if (!d || !d.ok) throw new Error((d && d.error) || "字体匹配失败");
        /* 把这次比对实际用的句子也带进诊断日志：OCR 错字会污染排名，
           用户粘原文重跑后能一眼看出「推荐基于哪句话」。 */
        reportCtx.font = d;
        /* 候选里带回来每个字体的垂直补偿量，恢复时按选中字体取用 */
        rememberLifts(d.candidates);
        if (payload.lines && payload.lines.length) {
          reportCtx.font.lines = payload.lines.map(function (x) {
            return { text: x.text };
          });
        }

        var list = d.candidates || [];
        /* 服务端给 12 个候选：字体识别是相似度推荐，真身常在第 7~10 位 */
        var top = list.slice(0, 12);
        if (top.length === 0) {
          host.innerHTML = "";
          return;
        }

        /*
         * 整行分数不可信时，服务端已经试过「按空隙拆成两段」并各自比对了。
         * 一段里混着粗体标题 + 常规正文时，整行只按一个字重渲染，正确字体
         * 会被整片挤到十几名开外（实测 0.48 → 分段后 0.94 / 0.82），
         * 这时直接采用分段结果，别让用户在错的推荐里挑。
         * 注意不要提前 return：整行那份候选仍要渲染好，用户点「取消分段」
         * 还得有东西可看，否则只剩一个停在「正在比对」的空壳。
         */
        var autoSegOk = false;
        if (d.segments && d.segments.segments && !recSegments) {
          autoSegOk = adoptAutoSegments(d.segments.segments);
        }

        /*
         * 正常稿的最高相似度在 0.84~0.99。低于 0.6 说明整行比对根本没
         * 找到像的字体（常见于识别文本乱码 / 字形被翻转 / 装饰字），
         * 但相对百分比照样显示「100%」—— 必须明说这批推荐不可信。
         */
        var html = "";
        if ((top[0].score || 0) < 0.6) {
          html +=
            '<div class="rec-font-unreliable">最高相似度 ' +
            Math.round((top[0].score || 0) * 100) +
            "%，这批推荐不可信，别直接用。</div>";
        }
        html += '<select id="recFontSel" class="rec-font-sel">';
        for (var k = 0; k < top.length; k++) {
          var f = top[k];
          var label = (f.familyZh || f.family) + " " + (f.subfamily || "");
          /*
           * 除了相似度，再标出「字重 / 字宽」吻合度：推荐错的时候，
           * 这两项能一眼说明是「字族不对」还是「字重不对、字宽不对」
           * （细体稿被粗体顶掉最常见）。
           */
          var extra = "";
          if (typeof f.weightFit === "number") {
            extra = " · 字重 " + Math.round(f.weightFit * 100) + "%";
          }
          if (typeof f.widthFit === "number") {
            extra += " 字宽 " + Math.round(f.widthFit * 100) + "%";
          }
          html +=
            '<option value="' +
            esc(f.postScriptName) +
            '" data-alt="' +
            esc(f.familyZh || f.family || "") +
            '" data-family="' +
            esc(f.family || f.familyZh || "") +
            '" data-full="' +
            esc(((f.family || "") + " " + (f.subfamily || "")).trim()) +
            '">' +
            esc(label.trim()) +
            " · " +
            f.rel +
            "%" +
            extra +
            "</option>";
        }
        html += "</select>";
        /*
         * 推荐只是「最相似」，不是鉴定：真身常常排在第 7~10 位甚至更后
         * （实测一份细体英文稿的正确答案 Arial 排第 7）。所以必须给一个
         * 手动入口 —— 从本机 781 个 face 里直接搜名字，一秒解决。
         */
        html +=
          '<input id="recFontManual" class="rec-font-manual" ' +
          'placeholder="推荐不准？输入字体名手动指定" autocomplete="off" />';
        html += '<div id="recFontHits" class="rec-font-hits"></div>';
        /* 说明文字不再渲染（用户要求精简）；下拉本身已表达「可以换字体」 */
        host.innerHTML = html;

        var manual = document.getElementById("recFontManual");
        var hitsBox = document.getElementById("recFontHits");
        var hitTimer = null;
        if (manual && hitsBox) {
          manual.addEventListener("input", function () {
            if (hitTimer) clearTimeout(hitTimer);
            var q = manual.value.trim();
            if (!q) {
              hitsBox.innerHTML = "";
              return;
            }
            hitTimer = setTimeout(function () {
              /* 多取一些：去重之后仍要凑够 12 条可选 */
              fetch(API + "/api/fonts?q=" + encodeURIComponent(q) + "&limit=30")
                .then(function (r) {
                  return r.json();
                })
                .then(function (d) {
                  /*
                   * 同一款字体装两份时（本机用户目录 + 系统目录）会出现两条
                   * 一模一样的记录，列表里重复看着像系统装坏了。按 PostScript
                   * 名去重，只留一条。
                   */
                  var seen = {};
                  var items = [];
                  var all = d.items || [];
                  for (var i = 0; i < all.length; i++) {
                    var psKey = (all[i].postScriptName || "").toLowerCase();
                    if (psKey && seen[psKey]) continue;
                    if (psKey) seen[psKey] = 1;
                    items.push(all[i]);
                  }
                  if (!items.length) {
                    hitsBox.innerHTML =
                      '<div class="rec-font-hit is-empty">本机没找到这个字体</div>';
                    return;
                  }
                  var h = "";
                  for (var i = 0; i < items.length; i++) {
                    var it = items[i];
                    /*
                     * 存「显示名」而不是 PostScript 名：AI 侧是
                     * app.textFonts.getByName(显示名)，"ArialMT" 找不到，
                     * "Arial" / "Arial Bold" 才找得到。
                     */
                    var disp = it.familyZh || it.family || "";
                    if (it.subfamily && it.subfamily !== "Regular") {
                      disp += " " + it.subfamily;
                    }
                    var label = ((it.familyZh || it.family) + " " + (it.subfamily || "")).trim();
                    h +=
                      '<div class="rec-font-hit" data-ps="' +
                      esc(disp) +
                      '" data-alt="' +
                      esc(disp) +
                      '">' +
                      esc(label) +
                      "</div>";
                  }
                  hitsBox.innerHTML = h;
                })
                .catch(function () {
                  hitsBox.innerHTML = "";
                });
            }, 220);
          });
          hitsBox.addEventListener("click", function (e) {
            var t = e.target;
            if (!t || !t.classList || !t.classList.contains("rec-font-hit")) return;
            var ps = t.getAttribute("data-ps") || "";
            var alt = t.getAttribute("data-alt") || "";
            if (!ps) return;
            manual.value = ps;
            manual.setAttribute("data-alt", alt);
            hitsBox.innerHTML =
              '<div class="rec-font-hit is-picked">已指定：' + esc(alt) + "</div>";
          });
        }

        host.setAttribute("data-best", top[0].postScriptName);

        /* 整行 UI 已经渲染好（取消分段时要用），现在把分段结果重新摆到最前 */
        if (autoSegOk) renderSegments();
      })
      .catch(function (e) {
        clearInterval(busyTimer);
        /*
         * 这里以前只打一行「字体比对失败：Failed to fetch」，用户看到的是
         * 一句英文、也不知道能不能重来。实际这一类失败几乎都是连接层断了
         * （机器忙、服务刚被看门狗拉起），重试一次就好，跟字体无关。
         */
        var raw = (e && e.message) || String(e);
        reportCtx.ui.lastError = "字体比对：" + raw;
        var text = e && e.network
          ? "字体服务这次没连上（不是识别出错），点下面重试即可。"
          : raw;
        host.innerHTML =
          '<div class="rec-font-error">' + esc(text) + "</div>" +
          '<button class="rec-font-retry" type="button">重试比对</button>';
        var retryBtn = host.querySelector(".rec-font-retry");
        if (retryBtn) {
          retryBtn.addEventListener("click", function () {
            doMatchFont(rec);
          });
        }
      });
  }

  function doRecoverApply() {
    var btn = document.getElementById("recApplyBtn");
    if (!btn || !recChars) return;

    var inputs = recResultEl.querySelectorAll(".rec-char input");
    var items = [];

    /*
     * 分段模式优先：拆过的每一段都是一个独立 item，自带字体和落点。
     * 只要 items 非空，后面的整行/逐字分支就不会再往里加。
     */
    if (recSegments && recSegments.length) {
      for (var si = 0; si < recSegments.length; si++) {
        var sg = recSegments[si];
        if (!sg || !String(sg.text || "").trim() || !sg.doc) continue;
        items.push({
          ch: sg.text,
          /* 每段独占一行：不给 row，AI 侧会按 y 容差把两段并回同一个文本框，
             字体只剩第一段的，整行还会被 tracking 硬拉宽 */
          row: si,
          x: round2(sg.doc.x),
          y: round2(sg.doc.y),
          w: round2(sg.doc.w),
          h: round2(sg.doc.h),
          font: sg.font || "",
          fontAlt: sg.fontAlt || "",
          fontFamily: sg.fontFamily || sg.fontAlt || "",
          fontFull: sg.fontFull || "",
          lift: recLifts[sg.font] || 0,
        });
      }
      if (items.length === 0) {
        recStatus("分段还没有文本，先补上每段内容", true);
        return;
      }
    }

    /* 字体：手动指定的优先（推荐只是「最相似」，真身常不在前几名），
       否则用推荐下拉里选中的那个；都没选就走 AI 当前默认字体 */
    var sel = document.getElementById("recFontSel");
    var fontName = sel ? sel.value : "";
    var fontAlt = "";
    var fontFamily = "";
    var fontFull = "";
    var manual = document.getElementById("recFontManual");
    if (manual && manual.value.trim()) {
      fontName = manual.value.trim();
      fontAlt = manual.getAttribute("data-alt") || "";
      fontFamily = fontAlt;
    } else {
      /* AI 里有些字体的显示名与 PostScript 名不一致，带一个中文名做回退；
         family/full 是给 AI 侧做「回读校验」用的：AI 找不到字体会静默换成
         别的字体，只有家族名能可靠分辨「换族了」还是「只是别名不同」 */
      var opt = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex] : null;
      fontAlt = opt ? opt.getAttribute("data-alt") || "" : "";
      fontFamily = opt ? opt.getAttribute("data-family") || "" : "";
      fontFull = opt ? opt.getAttribute("data-full") || "" : "";
    }

    /*
     * 优先整行恢复：一行一个 item，空格和标点完整。
     * 这样 fdRecoverApply 里的 n=1，字号由整行墨迹宽闭环决定、
     * tracking 不参与，英文的字距完全交给字体本身，最贴近原稿。
     */
    var fromLine = items.length > 0;
    var lineEl = fromLine ? null : document.getElementById("recLineText");
    if (lineEl && recLines && recLines.length) {
      var texts = String(lineEl.value || "").split(/\r?\n/);
      for (var li = 0; li < texts.length; li++) {
        if (!texts[li]) continue;
        var ln = recLines[li] || recLines[0];
        if (!ln || !ln.doc) continue;
        items.push({
          ch: texts[li],
          row: li,
          x: round2(ln.doc.x),
          y: round2(ln.doc.y),
          w: round2(ln.doc.w),
          h: round2(ln.doc.h),
          font: fontName,
          fontAlt: fontAlt,
          fontFamily: fontFamily || fontAlt,
          fontFull: fontFull,
          /* 行框底 → 墨迹底的垂直补偿（em），见 recLifts 注释 */
          lift: recLifts[fontName] || 0,
        });
      }
      fromLine = items.length > 0;
    }

    if (!fromLine) {
      for (var i = 0; i < inputs.length; i++) {
        var idx = Number(inputs[i].getAttribute("data-i"));
        var ch = inputs[i].value;
        if (!ch) continue;
        var c = recChars[idx];
        if (!c || !c.doc) continue;
        items.push({
          ch: ch,
          x: round2(c.doc.x),
          y: round2(c.doc.y),
          w: round2(c.doc.w),
          h: round2(c.doc.h),
          font: fontName,
          fontAlt: fontAlt,
          fontFamily: fontFamily || fontAlt,
          fontFull: fontFull,
          lift: recLifts[fontName] || 0,
        });
      }
    }

    if (items.length === 0) {
      recStatus("没有可恢复的内容", true);
      return;
    }

    btn.disabled = true;
    btn.textContent = "正在创建文字…";
    recStatus("");

    /* 分段信息进诊断日志：以后「某一段字体不对」能直接看到当时拆了几段 */
    reportCtx.ui.requestedFont = fontName;
    reportCtx.ui.autoSegment = !!recSegAuto;
    if (recSegments && recSegments.length) {
      reportCtx.ui.segments = recSegments.map(function (s) {
        return {
          text: s.text,
          font: s.font,
          score: Math.round((s.score || 0) * 100) / 100,
        };
      });
    }

    /*
     * fdRecoverApply 收的是一个 JSON 数组字符串。
     * 外面再套一层 JSON.stringify，把字符串变成合法的 JS 字面量参数。
     */
    var arg = JSON.stringify(JSON.stringify(items));

    evalJsx("fdRecoverApply(" + arg + ")", 45000)
      .then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.error) || "恢复失败");
        reportCtx.apply = r;
        /* 恢复成功后给用到的字体记一票：分段时每段各算一次 */
        if (recSegments && recSegments.length) {
          for (var hi = 0; hi < recSegments.length; hi++) {
            hitUsage(recSegments[hi].font, 2);
          }
        } else {
          hitUsage(fontName, 2);
        }
        /* 一大段成功说明不再占版面（用户要求精简）。按钮短暂反馈即可，
           字体 / 字号 / 字距 / 行宽这些校准值仍完整写进诊断日志。 */
        recStatus("");
        if (r.errors && r.errors.length) {
          /* 字体问题单独说清楚：这是「恢复出来和面板显示不一样」的唯一原因，
             混在「有 N 处问题」里用户根本不知道该改什么 */
          var fontErr = "";
          for (var ei = 0; ei < r.errors.length; ei++) {
            if (String(r.errors[ei]).indexOf("字体") === 0) {
              fontErr = String(r.errors[ei]);
              break;
            }
          }
          recStatus(
            fontErr
              ? fontErr.replace("字体被替换:", "字体没应用上，实际用了 ") +
                  "（本机 AI 里没有这个字体，换一个再恢复）"
              : "有 " + r.errors.length + " 处问题：" + r.errors.slice(0, 2).join("；"),
            true
          );
        } else if (
          r.calib &&
          r.calib.targetW > 0 &&
          r.calib.actualW > 0 &&
          Math.abs(r.calib.actualW - r.calib.targetW) / r.calib.targetW > 0.1
        ) {
          /* 宽度闭环没收敛以前是静默的，用户只看到「又小又挤」却不知道为什么 */
          recStatus(
            "宽度没对上（" +
              r.calib.actualW +
              " → " +
              r.calib.targetW +
              "pt），文字会偏小或偏挤：多半是识别文本缺字、字体不对，或稿子需要转正",
            true
          );
        }
        btn.textContent = "已恢复";
        setTimeout(function () {
          btn.disabled = false;
          btn.textContent = "恢复为可编辑文字";
        }, 2400);
      })
      .catch(function (e) {
        recStatus(e.message || String(e), true);
        btn.disabled = false;
        btn.textContent = "恢复为可编辑文字";
      });
  }

  function round2(v) {
    return Math.round((Number(v) || 0) * 100) / 100;
  }

  /**
   * 打开恢复页时静默探一次桥。
   *
   * 目的很实际：前两次故障都表现为「点了按钮就没下文」，用户没法判断
   * 是脚本没更新、AI 忙、还是桥断了。这里提前把结论摆出来：
   *   - 脚本是旧版 → 直接说「要完全退出 AI 再打开」
   *   - 桥没响应 → 说「暂时没响应，点按钮可以再试」，不标红（刚启动时正常）
   * 探活本身用 fdPingLite，毫秒级，不会反过来把 AI 拖住。
   */
  var bridgeChecked = false;
  function bridgeSelfCheck() {
    if (!isCEP || bridgeChecked) return;
    bridgeChecked = true;
    evalJsx("fdPingLite()", 20000)
      .then(function (p) {
        if (!p || !p.ok) {
          recStatus("Illustrator 报了错：" + ((p && p.error) || "未知"), true);
          return;
        }
        if (p.hasGeom === 0) {
          recStatus("面板脚本还是旧版 —— 需要完全退出 Illustrator 再重新打开（不是关文档）", true);
          return;
        }
        /* 成功也给一句，不然用户不知道到底通没通 */
        recStatus("已连上 Illustrator " + p.appVersion + "，选中转曲文字就能识别");
        setTimeout(function () {
          if (recStatusEl.textContent.indexOf("已连上") === 0) recStatus("");
        }, 5000);
      })
      .catch(function (e) {
        /* 不标红：面板刚打开时 AI 可能正在忙，这个结论还不够确定 */
        recStatus("Illustrator 暂时没响应（" + (e.message || e) + "）。点按钮可以再试一次。");
        bridgeChecked = false;
      });
  }

  recScanBtn.addEventListener("click", doRecoverScan);

  /* ---------------- 合并 / 拆分 ---------------- */

  var recLayoutStatusEl = document.getElementById("recLayoutStatus");

  function layoutStatus(msg, isErr, isOk) {
    recLayoutStatusEl.textContent = msg || "";
    recLayoutStatusEl.className =
      "rec-status" + (isErr ? " is-err" : isOk ? " is-ok" : "");
  }

  function runLayout(fnCode, btn, okText, requireV) {
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "处理中…";
    layoutStatus("正在处理…");

    /* 拆分必须先确认 AI 里是新脚本：v1 的拆分会让 Illustrator 原生闪退 */
    var guard = requireV
      ? evalJsx("fdLayoutVersion()", 10000)
          .catch(function () {
            return null;
          })
          .then(function (v) {
            if (!v || !v.ok || Number(v.v || 0) < requireV) {
              throw new Error(
                "Illustrator 里还是旧脚本，请完全退出 AI 再重开（旧版按行拆分会让 AI 闪退）"
              );
            }
          })
      : Promise.resolve();

    guard
      /* 合并/拆分要逐行建文本框，几十行会明显慢，别用默认的 8 秒 */
      .then(function () {
        return evalJsx(fnCode, 30000);
      })
      .then(function (r) {
        if (!r || !r.ok) {
          var msg = (r && r.error) || "操作失败";
          /* AI 侧逐行失败的原因别吞掉，否则用户只看到一句笼统的失败 */
          if (r && r.errors && r.errors.length) {
            msg += "（" + r.errors.slice(0, 3).join("；") + "）";
          }
          throw new Error(msg);
        }
        layoutStatus(okText(r), false, true);
      })
      .catch(function (e) {
        layoutStatus(e.message || String(e), true);
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = label;
      });
  }

  var recMergeBtn = document.getElementById("recMergeBtn");
  var recSplitBtn = document.getElementById("recSplitBtn");

  recMergeBtn.addEventListener("click", function () {
    runLayout("fdMergeTexts()", recMergeBtn, function (r) {
      return (
        "已合并 " +
        r.merged +
        " 个文本框为 " +
        (r.lines || 1) +
        " 行（原框已隐藏保留）"
      );
    });
  });

  recSplitBtn.addEventListener("click", function () {
    runLayout("fdSplitTextLines()", recSplitBtn, function (r) {
      return (
        "已拆成 " +
        r.created +
        " 个文本框，位置按" +
        (r.mode || "行距推算") +
        "还原，在图层「" +
        r.layer +
        "」"
      );
    }, 2);
  });

  /* ---------------- 启动 ---------------- */

  /*
   * 心跳：服务空闲 30 分钟会自动退出，只要界面还开着就定期打一下，
   * 免得用户切出去干别的回来发现连不上了。
   */
  setInterval(function () {
    fetch(API + "/health").catch(function () {
      /* 服务真挂了也不弹提示，用户下次操作会自然报错 */
    });
  }, 3 * 60 * 1000);

  /* ---------------- 深链：#font=<id> 直接打开详情 ---------------- */

  function openFromHash() {
    var m = /#font=([0-9a-f]{12})/.exec(location.hash || "");
    if (m) openDetail(m[1]);
  }

  window.addEventListener("hashchange", openFromHash);

  load(true);
  openFromHash();
})();
