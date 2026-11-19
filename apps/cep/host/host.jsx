/*
 * FontDeck host.jsx —— Illustrator 侧 ExtendScript
 * 只能用 ES3：var / function，无 let、const、箭头函数、模板字符串。
 * 这里只放"AI 才能做的事"，业务逻辑全在本地服务。
 *
 * 注意：不要在这里写 #target illustrator。
 * 那是 ExtendScript Toolkit 的预处理指令，CEP 加载 ScriptPath 时不需要，
 * 写上去反而可能让脚本初始化失败、导致 CEP 的 API 注入不了。
 *
 * 所有函数都定义在顶层（不用 IIFE 包裹），因为 CEP 的 evalScript
 * 是在全局作用域执行的，只有全局函数才调得到。
 */

/* ---------- 内部工具 ---------- */

function fdJsonEscape(s) {
    s = "" + s;
    var out = "";
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '"') out += '\\"';
        else if (c === '\\') out += '\\\\';
        else if (c === '\n') out += '\\n';
        else if (c === '\r') out += '\\r';
        else if (c === '\t') out += '\\t';
        else out += c;
    }
    return out;
}

function fdArr(arr) {
    var parts = [];
    for (var i = 0; i < arr.length; i++) {
        parts.push('"' + fdJsonEscape(arr[i]) + '"');
    }
    return "[" + parts.join(",") + "]";
}

/* ---------- 探活与字体 ---------- */

/**
 * 把「我们库里的字体名」解析成 AI 的 TextFont 对象。
 *
 * 多路 getByName 尝试（PostScript 名 → 中文/家族名 → 「家族+字重」），
 * 用**字体名字符串**挑最像的那个返回；名字对不上时由调用方提示「被替换」。
 *
 * 两条血泪铁律（都是 2026-11-17 拿崩溃换来的）：
 *   1) **绝不遍历 app.textFonts**：遍历 800+ face 并把 TextFont 原生对象
 *      存进 JS 对象长期持有，点「恢复」必崩（ucrtbase 0xc0000409 / BEX64）。
 *   2) **绝不读 TextFont.family**：旧代码只读过 .name，一直很稳；加了
 *      `hit.family` 家族校验之后，恢复第一条就崩在前一行 trace 之后。
 *      ExtendScript 的属性 getter 是原生绑定，某些字体上会直接 fail-fast，
 *      纯 JS 的 try/catch 根本拦不住。判断家族改用 .name 的字符串比较。
 */
var _fdLastFontName = "";
var _fdLastFontScore = 0;

/** 把字体名归一成「家族键」：去掉字重/斜体词，只留字母数字 */
function fdNameKey(n) {
    var s = String(n || "").toLowerCase();
    s = s.replace(
        /-?(thin|extralight|ultralight|light|semilight|regular|book|roman|normal|medium|semibold|demibold|bold|extrabold|black|heavy|italic|oblique)\b/g,
        ""
    );
    return s.replace(/[^0-9a-z\u4e00-\u9fff]/g, "");
}

/** 3=同名 2=同家族 1=不像（用于提示「被替换」，不用于拦截） */
function fdNameScore(req, got) {
    if (!req || !got) return 1;
    if (String(req).toLowerCase() === String(got).toLowerCase()) return 3;
    var a = fdNameKey(req);
    var b = fdNameKey(got);
    if (!a || !b) return 1;
    if (a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 2;
    return 1;
}

function fdResolveFont(ps, alt, full) {
    var tries = [ps, alt, full];
    var best = null;
    var bestScore = 0;
    var bestName = "";
    for (var i = 0; i < tries.length; i++) {
        var nm = tries[i];
        if (!nm) continue;
        try {
            var hit = app.textFonts.getByName(nm);
            if (!hit) continue;
            var got = "";
            try {
                got = String(hit.name || "");
            } catch (e0) {}
            var sc = fdNameScore(nm, got);
            if (!best || sc > bestScore) {
                best = hit;
                bestScore = sc;
                bestName = got;
            }
            if (sc >= 3) break;
        } catch (e) {}
    }
    _fdLastFontName = bestName;
    _fdLastFontScore = bestScore;
    return best;
}

/** 探活：返回 AI 版本与字体总数 */
function fdPing() {
    try {
        var v = app.version;
        var n = app.textFonts.length;
        return '{"ok":true,"appVersion":"' + fdJsonEscape(v) + '","fontCount":' + n + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + fdJsonEscape(e.message) + '"}';
    }
}

/**
 * 轻量探活：只读版本号，绝不碰 app.textFonts。
 *
 * 必须单独有一个，因为 app.textFonts.length 在字体多的机器上极慢 ——
 * 它会为每个已安装字体实例化对象。本机 1104 个 face，实测能吃掉好几秒，
 * 面板拿它当探活就会误报「AI 没有响应」，把一个慢操作当成桥断了。
 *
 * 顺带回传 hasGeom，用来确认面板加载的是新版脚本 —— 脚本没更新时
 * 这里会明确说「重开 Illustrator」，而不是让用户对着超时猜。
 */
function fdPingLite() {
    try {
        var hasGeom = 0;
        try {
            hasGeom = typeof fdRecoverGeometry === "function" ? 1 : 0;
        } catch (e0) {}
        return (
            '{"ok":true' +
            ',"appVersion":"' + fdJsonEscape(app.version) + '"' +
            ',"docs":' + app.documents.length +
            ',"hasGeom":' + hasGeom +
            "}"
        );
    } catch (e) {
        return '{"ok":false,"error":"' + fdJsonEscape(e.message) + '"}';
    }
}

/** 导出全部字体名（PostScript 名），给前端做匹配 */
function fdListFontNames() {
    try {
        var names = [];
        var fonts = app.textFonts;
        for (var i = 0; i < fonts.length; i++) {
            names.push(fonts[i].name);
        }
        return '{"ok":true,"count":' + names.length + ',"names":' + fdArr(names) + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + fdJsonEscape(e.message) + '"}';
    }
}

/** 给当前选中的文本换字体 */
function fdApplyFont(psName) {
    try {
        var font = app.textFonts.getByName(psName);
        if (!font) {
            return '{"ok":false,"error":"AI 里没有这个字体","psName":"' + fdJsonEscape(psName) + '"}';
        }
        if (app.selection.length === 0) {
            return '{"ok":false,"error":"没有选中任何对象"}';
        }
        var changed = 0;
        for (var i = 0; i < app.selection.length; i++) {
            var item = app.selection[i];
            if (item.typename === "TextFrame") {
                item.textRange.characterAttributes.textFont = font;
                changed++;
            } else if (item.typename === "GroupItem") {
                changed += fdApplyToGroup(item, font);
            }
        }
        if (changed === 0) {
            return '{"ok":false,"error":"选中的不是文本对象"}';
        }
        return '{"ok":true,"changed":' + changed + ',"applied":"' + fdJsonEscape(psName) + '"}';
    } catch (e) {
        return '{"ok":false,"error":"' + fdJsonEscape(e.message) + '"}';
    }
}

function fdApplyToGroup(group, font) {
    var n = 0;
    for (var i = 0; i < group.textFrames.length; i++) {
        group.textFrames[i].textRange.characterAttributes.textFont = font;
        n++;
    }
    for (var j = 0; j < group.groupItems.length; j++) {
        n += fdApplyToGroup(group.groupItems[j], font);
    }
    return n;
}

/** 列出当前文档用到的字体 */
function fdDocFonts() {
    try {
        if (app.documents.length === 0) {
            return '{"ok":false,"error":"没有打开文档"}';
        }
        var dt = app.documents[0].textFonts;
        var names = [];
        for (var i = 0; i < dt.length; i++) {
            names.push(dt[i].name);
        }
        return '{"ok":true,"count":' + names.length + ',"names":' + fdArr(names) + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + fdJsonEscape(e.message) + '"}';
    }
}

/** 选中文本当前用的字体 */
function fdSelectionFonts() {
    try {
        var names = [];
        if (app.selection.length === 0) {
            return '{"ok":true,"count":0,"names":[]}';
        }
        for (var i = 0; i < app.selection.length; i++) {
            var item = app.selection[i];
            if (item.typename === "TextFrame") {
                names.push(item.textRange.characterAttributes.textFont.name);
            }
        }
        return '{"ok":true,"count":' + names.length + ',"names":' + fdArr(names) + '}';
    } catch (e) {
        return '{"ok":false,"error":"' + fdJsonEscape(e.message) + '"}';
    }
}

/*
 * 说明：ExtendScript 的 File.execute() 不能给程序传参数，
 * 所以没法从这里调用 pythonw launcher.pyw。
 * 启动服务由面板的 js/boot.js 直接完成（CEP 自带 Node），全链路无窗口。
 * 面板拿不到 Node 时，唯一的办法是完全退出 Illustrator 再重开。
 */
function fdStartService() {
    return '{"ok":false,"error":"请完全退出 Illustrator 后重新打开"}';
}

/* ================================================================== */
/* 转曲恢复                                                            */
/* ================================================================== */

/*
 * 思路和字醒不同。
 *
 * 字醒：整块转曲区域先 OCR 一遍（带检测框），再拿识别结果去对齐位置。
 * 问题：PaddleOCR 的检测器面对「单行、无上下文、字距均匀」的图会过度分割，
 * 实测拼出来会重复字符（「永和九年」+「L年岁在癸丑」→「永和九年九年岁在癸丑」），
 * 调 unclip_ratio 只会更糟。
 *
 * 这里：转曲后每个字本来就是独立矢量轮廓，位置是精确真值，根本不需要检测。
 *   读每个轮廓的包围盒 → 服务端聚类成字 → 每字单独识别 → 位置直接用真值
 * 好处：认错一个字不连累旁边，能单独重试；位置不需要"估算对齐"。
 */

/*
 * 调试图的落地目录。
 *
 * 以前这里写死了某个用户名的绝对路径 —— 装到别人机器上就直接指向一个
 * 不存在的目录，转曲识别会在写图上静默失败。改成运行时取：
 * 先问环境变量（ExtendScript 的 $.getenv 可用），拿不到再从 Folder.userData
 * 推一层（Roaming → Local，Windows 固定结构）。
 */
var FD_RECOVER_DIR = (function () {
    var base = "";
    try {
        var env = $.getenv("LOCALAPPDATA");
        if (env) base = String(env).replace(/\\/g, "/");
    } catch (e) { /* 老版本 ExtendScript 可能没有 getenv */ }
    if (!base) {
        try {
            base = String(Folder.userData.fsName).replace(/\\/g, "/").replace(/\/Roaming$/i, "/Local");
        } catch (e2) { /* ignore */ }
    }
    if (!base) base = "C:/Users/Public/AppData/Local";
    return base + "/FontDeck/recover";
})();

/*
 * 合并时记住每行原始左下角，供「按行拆分」精确还原。
 * 用纯 JS 全局变量，不碰 PageItem.note 之类的宿主属性：
 * 17:39 那次 Illustrator 崩在 ExtendScript.dll（0xc0000005），
 * 原生层崩时 JS 的 try/catch 完全无效，宿主属性越少越安全。
 * CEP 的 evalScript 在同一 ExtendScript 引擎执行，同会话内变量保持；
 * 即使丢了也只是退化到行距推算，不会出错。
 */
var fdMergeRowPositions = null;
var fdMergeFrameRef = null;

/*
 * 布局脚本版本。前端点「按行拆分」前先探一次：
 * 旧脚本（v1）会让 Illustrator 原生闪退，必须拦住用户再点一次。
 * 纯字符串返回，不碰任何宿主对象。
 */
function fdLayoutVersion() {
    return '{"ok":true,"v":2}';
}

/*
 * ExtendScript.dll 原生崩溃不留 JS 堆栈，只能靠同步落盘的步进日志定位。
 * 每步都 open/write/close，保证崩之前写下的行不会丢。
 */
function fdSplitTrace(msg) {
    try {
        var f = new File(FD_RECOVER_DIR + "/split-trace.log");
        f.open("a");
        f.writeln(String(new Date().getTime()) + " " + msg);
        f.close();
    } catch (e) {}
}

/** 转曲恢复的逐步 trace（和按行拆分分开写，互不覆盖） */
function fdApplyTrace(msg) {
    try {
        var f = new File(FD_RECOVER_DIR + "/apply-trace.log");
        f.open("a");
        f.writeln(String(new Date().getTime()) + " " + msg);
        f.close();
    } catch (e) {}
}

/** 有限数校验：NaN / Infinity 一旦塞进 AI 的原生属性会直接让进程 fail-fast */
function fdFinite(v) {
    return typeof v === "number" && isFinite(v);
}

function fdRecoverDir() {
    var f = new Folder(FD_RECOVER_DIR);
    if (!f.exists) f.create();
    return f;
}

/** 递归收集选区里的所有形状，out 每项 { box: [left, top, right, bottom] } */
function fdCollectShapes(item, out, depth) {
    if (!item || depth > 12) return;
    var t = item.typename;

    if (t === "PathItem" || t === "CompoundPathItem") {
        try {
            var b = item.visibleBounds;
            /* 零面积路径（锚点、参考线）没有识别价值 */
            if (b[2] - b[0] > 0.01 && b[1] - b[3] > 0.01) {
                out.push({ box: [b[0], b[1], b[2], b[3]] });
            }
        } catch (e) {}
        return;
    }

    if (t === "GroupItem") {
        var i;
        try {
            for (i = 0; i < item.pathItems.length; i++) {
                fdCollectShapes(item.pathItems[i], out, depth + 1);
            }
        } catch (e) {}
        try {
            for (i = 0; i < item.compoundPathItems.length; i++) {
                fdCollectShapes(item.compoundPathItems[i], out, depth + 1);
            }
        } catch (e) {}
        try {
            for (i = 0; i < item.groupItems.length; i++) {
                fdCollectShapes(item.groupItems[i], out, depth + 1);
            }
        } catch (e) {}
    }
}

/** 多个包围盒求并集，返回 [left, top, right, bottom] */
function fdUnionBox(boxes) {
    var l = 1e12, t = -1e12, r = -1e12, b = 1e12;
    for (var i = 0; i < boxes.length; i++) {
        var x = boxes[i];
        if (x[0] < l) l = x[0];
        if (x[1] > t) t = x[1];
        if (x[2] > r) r = x[2];
        if (x[3] < b) b = x[3];
    }
    return [l, t, r, b];
}

/**
 * 临时加一个画板框住内容，导出整块 PNG，再删掉画板。
 *
 * 为什么加画板而不是复制到临时文档：duplicate 到新文档会带坐标偏移，
 * 还得反推变换，容易出错。加删画板不动文档内容（可撤销）。
 *
 * 为什么放大 4 倍：OCR 识别器的输入高度固定 48px，而原稿字号常只有 9-12pt，
 * 1:1 导出后字高十来像素，识别率会明显下降。放大 4 倍落在训练尺度里。
 */
function fdExportPng(doc, box, scale, pngPath) {
    var pad = 1.0;
    /* artboardRect 是 [left, top, right, bottom]，y 轴向上所以 top > bottom */
    var rect = [box[0] - pad, box[1] + pad, box[2] + pad, box[3] - pad];

    doc.artboards.add(rect);
    var addedIndex = doc.artboards.length - 1;
    var prevActive = doc.artboards.getActiveArtboardIndex();

    try {
        doc.artboards.setActiveArtboardIndex(addedIndex);

        var opts = new ExportOptionsPNG24();
        opts.artBoardClipping = true;
        opts.horizontalScale = scale * 100;
        opts.verticalScale = scale * 100;
        opts.antiAliasing = true;
        opts.transparency = false;
        opts.matte = true;
        /* 白底：OCR 要白底深字。原稿若是深底白字，服务端会反相 */
        var white = new RGBColor();
        white.red = 255;
        white.green = 255;
        white.blue = 255;
        opts.matteColor = white;

        doc.exportFile(new File(pngPath), ExportType.PNG24, opts);
    } finally {
        try {
            doc.artboards.setActiveArtboardIndex(prevActive);
        } catch (e) {}
        try {
            doc.artboards.remove(addedIndex);
        } catch (e) {}
    }

    return rect;
}

/**
 * 扫描选中的转曲内容，导出位图并回传几何。
 *
 * 【已弃用】保留作为兜底排查手段，前端不再默认调用。
 * 弃用原因：doc.exportFile 配临时画板在真实文档上会卡死 ——
 * 导出期间 UI 线程被占住，evalScript 的回调永不返回，
 * 面板表现就是停在「正在读取选区、导出图片…」。
 * 现在主通道是下面的 fdRecoverGeometry：只回传路径坐标，服务端自己画图。
 *
 * 返回字段：
 *   png        导出的图片绝对路径
 *   pngW/pngH  图片像素尺寸
 *   scale      放大倍数
 *   originX/Y  图片左上角对应的 AI 点坐标
 *   shapes     每个轮廓的包围盒（相对图片左上角、已换算成像素）
 *   textFrames 选区内仍存在的文本框数量（>0 说明没转干净）
 */
function fdRecoverScan(scale) {
    try {
        if (app.documents.length === 0) {
            return '{"ok":false,"error":"没有打开文档"}';
        }
        if (app.selection.length === 0) {
            return '{"ok":false,"error":"请先选中转曲后的文字"}';
        }

        var sel = app.selection;
        var shapes = [];
        var textFrames = 0;

        for (var i = 0; i < sel.length; i++) {
            if (sel[i].typename === "TextFrame") textFrames++;
            fdCollectShapes(sel[i], shapes, 0);
        }

        if (shapes.length === 0) {
            return '{"ok":false,"error":"选中的对象里没有可识别的形状，可能不是转曲文字"}';
        }

        var boxes = [];
        for (var j = 0; j < shapes.length; j++) boxes.push(shapes[j].box);
        var box = fdUnionBox(boxes);

        var sc = scale && scale > 0 ? scale : 4;
        var d = fdRecoverDir();
        var pngPath = d.fsName + "/scan-" + new Date().getTime() + ".png";

        var rect = fdExportPng(app.activeDocument, box, sc, pngPath);

        var f = new File(pngPath);
        if (!f.exists) {
            return '{"ok":false,"error":"导出图片失败，文件没有生成"}';
        }

        /* 把每个轮廓换算成图片像素坐标：x 向右、y 向下 */
        var parts = [];
        for (var k = 0; k < boxes.length; k++) {
            var b = boxes[k];
            parts.push(
                "[" +
                    Math.round((b[0] - rect[0]) * sc) + "," +
                    Math.round((rect[1] - b[1]) * sc) + "," +
                    Math.round((b[2] - rect[0]) * sc) + "," +
                    Math.round((rect[1] - b[3]) * sc) +
                "]"
            );
        }

        return (
            '{"ok":true' +
            ',"png":"' + fdJsonEscape(pngPath) + '"' +
            ',"pngW":' + Math.round((rect[2] - rect[0]) * sc) +
            ',"pngH":' + Math.round((rect[1] - rect[3]) * sc) +
            ',"scale":' + sc +
            ',"originX":' + rect[0].toFixed(3) +
            ',"originY":' + rect[3].toFixed(3) +
            ',"ptsW":' + (rect[2] - rect[0]).toFixed(3) +
            ',"ptsH":' + (rect[1] - rect[3]).toFixed(3) +
            ',"textFrames":' + textFrames +
            ',"shapeCount":' + shapes.length +
            ',"shapes":[' + parts.join(",") + "]" +
            "}"
        );
    } catch (e) {
        return '{"ok":false,"error":"' + fdJsonEscape(e.message) + '"}';
    }
}

/**
 * 把一个路径的锚点与控制柄摊平成扁平数字数组。
 * 每点 6 个数：锚点 x,y + leftDirection x,y + rightDirection x,y（文档坐标）。
 * 相机式的「in/out 控制点」是 Illustrator 的存储方式，服务端按三次贝塞尔还原。
 */
function fdGeomPoints(pathItem) {
    var pts = pathItem.pathPoints;
    var arr = [];
    for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        var a = p.anchor;
        var li = p.leftDirection;
        var ri = p.rightDirection;
        arr.push(a[0], a[1], li[0], li[1], ri[0], ri[1]);
    }
    return arr;
}

/** 递归收集选区里的填充路径。out 里每项 { c: 闭合, p: [子路径扁平数组], b: 包围盒 } */
function fdGeomWalk(item, out, depth, stat) {
    if (!item || depth > 12) return;
    var t = item.typename;

    if (t === "PathItem") {
        if (!item.filled) {
            if (item.stroked) stat.stroke++;
            return;
        }
        var b = null;
        try {
            b = item.visibleBounds;
        } catch (e) {
            return;
        }
        if (!b) return;
        var flat = fdGeomPoints(item);
        if (flat.length < 12) return;
        out.push({ c: item.closed ? 1 : 0, p: [flat], b: [b[0], b[1], b[2], b[3]] });
        stat.paths++;
        return;
    }

    if (t === "CompoundPathItem") {
        /*
         * 复合路径必须整体当一个 shape：它的多个子路径共享同一次填充，
         * 「口」「日」「回」这类字的内部空洞就是靠奇偶规则挖出来的。
         * 拆开单独处理会把空洞填实。
         */
        var subs = [];
        try {
            for (var i = 0; i < item.pathItems.length; i++) {
                var sp = item.pathItems[i];
                if (!sp.filled) continue;
                var f2 = fdGeomPoints(sp);
                if (f2.length >= 12) subs.push(f2);
            }
        } catch (e2) {}
        if (subs.length === 0) return;
        var b2 = null;
        try {
            b2 = item.visibleBounds;
        } catch (e3) {
            return;
        }
        if (!b2) return;
        out.push({ c: 1, p: subs, b: [b2[0], b2[1], b2[2], b2[3]] });
        stat.paths++;
        return;
    }

    if (t === "GroupItem") {
        try {
            for (var a = 0; a < item.pathItems.length; a++) {
                fdGeomWalk(item.pathItems[a], out, depth + 1, stat);
            }
        } catch (e4) {}
        try {
            for (var c2 = 0; c2 < item.compoundPathItems.length; c2++) {
                fdGeomWalk(item.compoundPathItems[c2], out, depth + 1, stat);
            }
        } catch (e5) {}
        try {
            for (var g = 0; g < item.groupItems.length; g++) {
                fdGeomWalk(item.groupItems[g], out, depth + 1, stat);
            }
        } catch (e6) {}
        return;
    }

    if (t === "TextFrame") stat.text++;
    else if (t === "RasterItem") stat.raster++;
}

/**
 * 转曲恢复主通道：只回传路径几何，不导出图片。
 *
 * 为什么改成这样：
 *   doc.exportFile 配临时画板在真实文档上会卡住 UI 线程，
 *   CEP 的 evalScript 回调永远不返回（面板停在「正在读取选区」）。
 *   而且增删画板会动用户文档、还要处理导出设置与白底。
 *   把坐标交给服务端自己画，这几个问题同时消失，位置精度也更高
 *   （包围盒不再靠导出图反推，而是由矢量直接算）。
 *
 * 返回：画布宽高、坐标原点、每个轮廓的子路径点串。
 * 点的单位是「像素」，已按 scale 放大、并把 y 翻成向下，
 * 服务端拿到就能直接画，不需要再做坐标变换。
 */
function fdRecoverGeometry(scale) {
    try {
        if (app.documents.length === 0) {
            return '{"ok":false,"error":"没有打开文档"}';
        }
        if (app.selection.length === 0) {
            return '{"ok":false,"error":"请先选中转曲后的文字"}';
        }

        var sel = app.selection;
        var shapes = [];
        var stat = { paths: 0, text: 0, raster: 0, stroke: 0 };

        for (var i = 0; i < sel.length; i++) {
            fdGeomWalk(sel[i], shapes, 0, stat);
        }

        if (shapes.length === 0) {
            if (stat.raster > 0) {
                return '{"ok":false,"error":"选中的是位图，不是转曲矢量，没法还原成文字"}';
            }
            if (stat.stroke > 0) {
                return '{"ok":false,"error":"选中路径只有描边没有填充，暂不支持这种转曲方式"}';
            }
            return '{"ok":false,"error":"选中的对象里没有可识别的形状，可能不是转曲文字"}';
        }

        /* 所有轮廓的并集，再外扩 2pt 留白，避免笔画贴边被裁 */
        var minL = 1e12, maxT = -1e12, maxR = -1e12, minB = 1e12;
        for (var j = 0; j < shapes.length; j++) {
            var b = shapes[j].b;
            if (b[0] < minL) minL = b[0];
            if (b[1] > maxT) maxT = b[1];
            if (b[2] > maxR) maxR = b[2];
            if (b[3] < minB) minB = b[3];
        }

        var pad = 2.0;
        var ox = minL - pad;
        var topY = maxT + pad;
        var pw = maxR - minL + pad * 2;
        var ph = maxT - minB + pad * 2;
        if (pw <= 0 || ph <= 0) {
            return '{"ok":false,"error":"选区尺寸为零"}';
        }

        var sc = scale && scale > 0 ? scale : 4;

        /*
         * 超大选区自动降倍。整版 A0 海报 4 倍会到上万像素，
         * OCR 那边按框裁剪会慢到不可用，内存也顶不住。
         * 降到 1 倍仍超过的话就按 1 倍封底，宁可精度低也不卡死。
         */
        var maxPx = 4000;
        if (pw * sc > maxPx || ph * sc > maxPx) {
            sc = Math.min(maxPx / pw, maxPx / ph);
            if (sc < 1) sc = 1;
        }

        var W = Math.round(pw * sc);
        var H = Math.round(ph * sc);

        /* 换算成像素坐标并拼 JSON。整数就够，1 像素在 4 倍下等于 0.25pt */
        var parts = [];
        for (var k = 0; k < shapes.length; k++) {
            var sh = shapes[k];
            var subs = [];
            for (var s = 0; s < sh.p.length; s++) {
                var flat = sh.p[s];
                var px = [];
                for (var q = 0; q < flat.length; q += 2) {
                    px.push(Math.round((flat[q] - ox) * sc));
                    px.push(Math.round((topY - flat[q + 1]) * sc));
                }
                subs.push("[" + px.join(",") + "]");
            }
            parts.push('{"c":' + sh.c + ',"p":[' + subs.join(",") + "]}");
        }

        return (
            '{"ok":true' +
            ',"w":' + W +
            ',"h":' + H +
            ',"scale":' + Math.round(sc * 1000) / 1000 +
            ',"originX":' + ox.toFixed(3) +
            ',"originY":' + (topY - ph).toFixed(3) +
            ',"ptsW":' + pw.toFixed(3) +
            ',"ptsH":' + ph.toFixed(3) +
            ',"textFrames":' + stat.text +
            ',"shapeCount":' + shapes.length +
            ',"shapes":[' + parts.join(",") + "]" +
            "}"
        );
    } catch (e) {
        return '{"ok":false,"error":"' + fdJsonEscape(e.message) + '"}';
    }
}

/**
 * 按识别结果建可编辑文字。
 *
 * items 是 JSON 数组字符串，每项：
 *   ch      文字内容
 *   x, y    墨迹左下角（AI 点坐标）
 *   w, h    墨迹宽高
 *   font    PostScript 名，可为空
 *   color   [r,g,b]
 *
 * 两处校准，都是一次收敛（线性的，不用迭代）：
 *   字号  —— 先建 12pt，量实际墨迹高度，按比例修
 *   字距  —— 整行宽度与原行宽的差值摊到每个字上，换算成 tracking
 *
 * 为什么按「整行」建而不是每字一个文本框：
 * 逐字建虽然位置最准，但拿到的是一堆单字，没法当句子编辑、也不能整体换字体。
 * 用户要的是「还原成一句可编辑的文字」，所以默认按行合并，
 * 用 tracking 把整行拉回原始行宽。位置以行首字为准，误差不会累积到行外。
 */
function fdRecoverApply(json) {
    try {
        if (app.documents.length === 0) {
            return '{"ok":false,"error":"没有打开文档"}';
        }

        /* 逐行落盘：万一又崩，最后一行就是崩溃点（AI 不会留任何堆栈） */
        try {
            var tf0 = new File(FD_RECOVER_DIR + "/apply-trace.log");
            tf0.open("w");
            tf0.writeln("=== apply start " + new Date().toString() + " ===");
            tf0.close();
        } catch (et) {}
        fdApplyTrace("enter items=" + json.length + "B");

        /* ExtendScript 没有可靠的 JSON.parse，eval 是这里唯一稳的写法。
           数据来自本机服务，不是外部输入。 */
        var items = eval("(" + json + ")");
        if (!items || !items.length) {
            return '{"ok":false,"error":"没有要恢复的内容"}';
        }
        fdApplyTrace("parsed n=" + items.length);

        var doc = app.activeDocument;
        var layer = doc.layers.add();
        layer.name = "FontDeck · 可编辑文本";
        fdApplyTrace("layer added");

        var created = 0;
        var errors = [];
        var appliedFont = "";
        var lastCalib = null;

        /* ---------- 1. 按行分组 ---------- */
        var hs = [];
        for (var i = 0; i < items.length; i++) {
            if (items[i].h > 0) hs.push(items[i].h);
        }
        hs.sort(function (a, b) {
            return a - b;
        });
        var medH = hs.length > 0 ? hs[Math.floor(hs.length / 2)] : 10;
        if (!(medH > 0)) medH = 10;

        /* 行容差取 0.6 倍字高：上下两行字的中线间距至少是一个字高 */
        var rowTol = medH * 0.6;

        var rows = [];
        for (var j = 0; j < items.length; j++) {
            var it = items[j];
            if (!it.ch) continue;

            /* 整行识别来的数据自带行号，直接用，不再靠 y 容差猜 */
            if (typeof it.row === "number" && it.row >= 0) {
                while (rows.length <= it.row) {
                    rows.push({ y: 0, list: [] });
                }
                rows[it.row].list.push(it);
                continue;
            }

            var target = null;
            for (var k = 0; k < rows.length; k++) {
                if (Math.abs(rows[k].y - it.y) <= rowTol) {
                    target = rows[k];
                    break;
                }
            }
            if (!target) {
                target = { y: it.y, list: [] };
                rows.push(target);
            }
            target.list.push(it);
        }

        if (rows.length === 0) {
            return '{"ok":false,"error":"没有可用的文字内容"}';
        }

        /*
         * ---------- 1.5 字体预检（建任何文本框之前） ----------
         *
         * 只做 getByName + 读 .name，不碰文本框、不读 .family。
         * 目的有两个：
         *   1) 把「字体解析」和「建框排版」两类原生调用在 trace 里分开，
         *      下次崩了能一眼看出是哪一类；
         *   2) 解析不出名字的行提前拿到结论，不至于建了框再报错。
         * 只存字符串（名字/分数），绝不把 TextFont 对象存起来。
         */
        for (var pr = 0; pr < rows.length; pr++) {
            var pfirst = rows[pr].list[0];
            if (!pfirst || !pfirst.font) continue;
            fdApplyTrace("preflight row " + pr + " req=" + pfirst.font);
            fdResolveFont(pfirst.font, pfirst.fontAlt, pfirst.fontFull);
            fdApplyTrace(
                "preflight row " + pr + " got=" + (_fdLastFontName || "-") +
                " score=" + _fdLastFontScore
            );
        }
        fdApplyTrace("preflight done");

        /* ---------- 2. 每行建一个文本框 ---------- */
        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            row.list.sort(function (a, b) {
                return a.x - b.x;
            });

            var text = "";
            for (var t = 0; t < row.list.length; t++) {
                text += row.list[t].ch;
            }
            if (!text) continue;

            var first = row.list[0];
            fdApplyTrace(
                "row " + r + " items=" + row.list.length +
                " x=" + first.x + " y=" + first.y
            );

            /* 坐标必须是有限数：NaN/Infinity 塞进 translate 或 size 会让
               AI 原生层直接 fail-fast（0xc0000409），崩得没有任何提示 */
            if (!fdFinite(first.x) || !fdFinite(first.y)) {
                errors.push("第" + (r + 1) + "行坐标非法，已跳过");
                fdApplyTrace("row " + r + " bad xy -> skip");
                continue;
            }

            try {
                var tf = layer.textFrames.add();
                fdApplyTrace("r" + r + " add");
                tf.kind = TextType.POINTTEXT;
                fdApplyTrace("r" + r + " kind");
                tf.contents = text;
                fdApplyTrace("r" + r + " contents " + text.length + "ch");

                var attr = tf.textRange.characterAttributes;
                attr.size = 12;
                fdApplyTrace("r" + r + " attr size=12");

                if (first.font) {
                    fdApplyTrace("r" + r + " font begin " + first.font);
                    var fObj = fdResolveFont(
                        first.font,
                        first.fontAlt,
                        first.fontFull
                    );
                    fdApplyTrace(
                        "r" + r + " font resolved=" + (_fdLastFontName || "-") +
                        " score=" + _fdLastFontScore
                    );
                    /* 中文字体在 AI 里的显示名偶尔和 PostScript 名不同，
                       静默失败会悄悄退回默认字体，表现就是「字形/粗细全不对」 */
                    if (fObj) {
                        attr.textFont = fObj;
                        fdApplyTrace("r" + r + " font assigned");
                        /*
                         * 不读 TextFont.family（读它会让 AI 崩），只拿
                         * getByName 返回的名字做比较：名字对不上就是 AI 在做
                         * 缺失字体替换（实测请求 Gabriola 拿到 Candara-Italic），
                         * 必须让用户看见，否则就是「恢复出来跟面板显示不一样」。
                         */
                        if (_fdLastFontName && _fdLastFontScore <= 1) {
                            errors.push(
                                "字体被替换:" + first.font + " → " + _fdLastFontName
                            );
                        }
                        appliedFont = _fdLastFontName || String(first.font);
                    } else {
                        errors.push("字体不可用:" + first.font);
                    }
                }

                if (first.color && first.color.length === 3) {
                    try {
                        var col = new RGBColor();
                        col.red = first.color[0];
                        col.green = first.color[1];
                        col.blue = first.color[2];
                        attr.fillColor = col;
                    } catch (ec) {}
                }

                var n = row.list.length;
                var lastIt = row.list[n - 1];

                /* 原文这一行的墨迹并集宽度 —— 来自真实轮廓，是精确真值 */
                var ws = [];
                for (var wi = 0; wi < n; wi++) {
                    if (row.list[wi].w > 0) ws.push(row.list[wi].w);
                }
                ws.sort(function (a, b) { return a - b; });
                var medW = ws.length > 0 ? ws[Math.floor(ws.length / 2)] : medH;
                if (!(medW > 0)) medW = medH;
                var targetW = lastIt.x + (lastIt.w > 0 ? lastIt.w : medW) - first.x;
                if (!(targetW > 0)) targetW = n * medW;

                /*
                 * 字号：用「整行宽度」闭环，不用墨迹高。
                 *
                 * 旧写法拿墨迹高去除 AI 的 visibleBounds 高度 —— 后者是行框，
                 * 含 ascender/descender 留白，两个量根本不对等，字号必然系统性
                 * 偏小（实测只有原稿的 78%）；接着 tracking 又要把整行硬拉回
                 * 原宽，字距就被撑松了。用户看到的就是「又小又松、笔画显细」。
                 *
                 * 现在让 AI 自己渲染一次，量出可见宽度，按比例把字号缩放到
                 * 目标行宽。不依赖任何字体的经验系数，宽度对了字号就对了。
                 */
                attr.size = 12;
                attr.tracking = 0;
                fdApplyTrace("r" + r + " mark-12");
                var b1 = tf.visibleBounds;
                fdApplyTrace("r" + r + " bounds1");
                var w1 = b1[2] - b1[0];
                if (w1 > 0.01 && fdFinite(targetW)) {
                    var sz = 12 * (targetW / w1);
                    if (fdFinite(sz) && sz > 0.1 && sz < 2000) attr.size = sz;
                }
                fdApplyTrace("row " + r + " w1=" + w1 + " targetW=" + targetW + " size=" + attr.size);

                /*
                 * 高度保险：行墨迹高来自真实轮廓，是精确真值，字号不该比它
                 * 大太多。旧写法用 medW/0.75 当上限，整行模式下 medW 就是
                 * 整行宽（两百多 pt），等于没有约束 —— 一旦行宽取错或字体差
                 * 得远，宽度闭环会把字号拉飞（实测 7.9pt 的稿子算出 15.99pt）。
                 * 西文墨迹高约等于字号（Arial 实测 0.92），放宽到 1.4 倍。
                 */
                var maxSize = medH > 0 ? medH * 1.4 : attr.size * 1.3;
                if (maxSize > 0 && attr.size > maxSize) attr.size = maxSize;
                if (!fdFinite(attr.size) || attr.size <= 0) {
                    errors.push("第" + (r + 1) + "行字号非法，已跳过");
                    fdApplyTrace("row " + r + " bad size -> skip");
                    continue;
                }

                /* 二次残差才用 tracking 补，正常情况下这个值接近 0 */
                var b2 = tf.visibleBounds;
                var w2 = b2[2] - b2[0];
                var tr = 0;
                if (n > 1 && w2 > 0.01) {
                    tr = ((targetW - w2) / ((n - 1) * attr.size)) * 1000;
                    if (fdFinite(tr) && tr > -300 && tr < 2000) attr.tracking = tr;
                    else tr = 0;
                }

                /*
                 * 位置：对齐到行首字的墨迹左下角。
                 *
                 * 两个坑叠在一起：
                 * 1) visibleBounds 的下边未必是字形墨迹底。若是行框底
                 *    （= 基线 − descent×字号），直接对位会让整行按 descender 上移。
                 *    lift = descent + inkBottom 由服务端按该字体渲染实测，
                 *    随 item 带过来；拿不到就是 0，退回原地对上。
                 * 2) AI 在改完 size 之后，visibleBounds 偶尔还滞后一帧。
                 *    于是第一刀总会差一点点，而且差值随字形变化 —— 表现就是
                 *    「换一个字体，偏移量就不一样」。所以移动完再读一次，
                 *    把残差补掉（只补位置，不动字形，收敛即停）。
                 */
                var b3 = tf.visibleBounds;
                fdApplyTrace("r" + r + " bounds3");
                var lift = fdFinite(first.lift) ? first.lift : 0;
                var targetBottom = first.y - lift * attr.size;
                var dx = first.x - b3[0];
                var dy = targetBottom - b3[3];
                if (fdFinite(dx) && fdFinite(dy)) {
                    tf.translate(dx, dy);
                    var b4 = tf.visibleBounds;
                    var ex = first.x - b4[0];
                    var ey = targetBottom - b4[3];
                    var fixed = 0;
                    if (
                        fdFinite(ex) &&
                        fdFinite(ey) &&
                        (Math.abs(ex) > 0.02 || Math.abs(ey) > 0.02)
                    ) {
                        tf.translate(ex, ey);
                        fixed = 1;
                    }
                    fdApplyTrace(
                        "r" + r + " lift=" + lift +
                        " dy=" + Math.round(dy * 100) / 100 +
                        " resid=" + Math.round(ey * 100) / 100 +
                        " fixed=" + fixed +
                        " boxH/size=" +
                        Math.round(((b4[1] - b4[3]) / (attr.size || 1)) * 100) / 100
                    );
                } else {
                    errors.push("第" + (r + 1) + "行位置非法，已跳过定位");
                }

                lastCalib = {
                    size: Math.round(attr.size * 100) / 100,
                    tracking: Math.round(tr),
                    targetW: Math.round(targetW * 10) / 10,
                    actualW: Math.round((b3[2] - b3[0]) * 10) / 10
                };

                created++;
                fdApplyTrace("r" + r + " ok");
            } catch (e2) {
                errors.push("第" + (r + 1) + "行:" + e2.message);
            }
        }

        fdApplyTrace("done created=" + created + " errors=" + errors.length);
        return (
            '{"ok":true' +
            ',"created":' + created +
            ',"rows":' + rows.length +
            ',"layer":"' + fdJsonEscape(layer.name) + '"' +
            ',"font":"' + fdJsonEscape(appliedFont) + '"' +
            ',"calib":' + (lastCalib
                ? '{"size":' + lastCalib.size +
                  ',"tracking":' + lastCalib.tracking +
                  ',"targetW":' + lastCalib.targetW +
                  ',"actualW":' + lastCalib.actualW + '}'
                : 'null') +
            ',"errors":' + fdArr(errors) +
            "}"
        );
    } catch (e) {
        return '{"ok":false,"error":"' + fdJsonEscape(e.message) + '"}';
    }
}

/** 删掉恢复过程产生的临时图片 */
function fdRecoverClean() {
    try {
        var d = fdRecoverDir();
        var files = d.getFiles("*.png");
        var n = 0;
        for (var i = 0; i < files.length; i++) {
            try {
                files[i].remove();
                n++;
            } catch (e) {}
        }
        return '{"ok":true,"removed":' + n + "}";
    } catch (e) {
        return '{"ok":false,"error":"' + fdJsonEscape(e.message) + '"}';
    }
}

/* ================================================================== */
/* 合并 / 拆分                                                          */
/* ================================================================== */

/**
 * 合并选中的多个文本框。
 *
 * 关键：**必须区分「同一行的几个字」和「多行」**。
 * 之前是把每个框的内容都用 \r 连起来 —— 一行 7 个字就变成 7 段，
 * 点文本每段从同一起点开始，于是横排的字被排成了一竖列。
 * 正确做法是先按 y 分组，行内直接拼接，只在行与行之间用 \r。
 *
 * 原文本框隐藏保留（不删），随时能找回。
 */
function fdMergeTexts() {
    try {
        if (app.selection.length < 2) {
            return '{"ok":false,"error":"至少要选中两个文本框"}';
        }

        var frames = [];
        for (var i = 0; i < app.selection.length; i++) {
            var it = app.selection[i];
            if (it.typename === "TextFrame") frames.push(it);
        }
        if (frames.length < 2) {
            return '{"ok":false,"error":"选中的对象里文本框不足两个"}';
        }

        /* ---------- 1. 按行分组（以文本框顶部 y 为准，容差半个字高） ---------- */
        var rows = [];
        for (var j = 0; j < frames.length; j++) {
            var f = frames[j];
            var b = f.visibleBounds;
            var h = b[1] - b[3];
            var tol = Math.max(h * 0.6, 1);

            var target = null;
            for (var k = 0; k < rows.length; k++) {
                if (Math.abs(rows[k].top - b[1]) <= Math.max(tol, rows[k].tol)) {
                    target = rows[k];
                    break;
                }
            }
            if (!target) {
                target = { top: b[1], tol: tol, list: [] };
                rows.push(target);
            }
            target.list.push({ frame: f, x: b[0] });
        }

        /* 行从上到下；行内从左到右 */
        rows.sort(function (a, b2) {
            return b2.top - a.top;
        });

        var lines = [];
        var posLines = [];
        var minX = 1e12, maxY = -1e12, maxRight = -1e12, minBottom = 1e12;

        for (var r = 0; r < rows.length; r++) {
            var line = rows[r];
            line.list.sort(function (a, b3) {
                return a.x - b3.x;
            });

            var s = "";
            for (var m = 0; m < line.list.length; m++) {
                s += line.list[m].frame.contents;
            }
            lines.push(s);

            /* 纯数值快照，不调用任何宿主写入 */
            var lb = line.list[0].frame.visibleBounds;
            posLines.push([lb[0], lb[3]]);
        }

        for (var n = 0; n < frames.length; n++) {
            var fb = frames[n].visibleBounds;
            if (fb[0] < minX) minX = fb[0];
            if (fb[1] > maxY) maxY = fb[1];
            if (fb[2] > maxRight) maxRight = fb[2];
            if (fb[3] < minBottom) minBottom = fb[3];
        }

        var base = frames[0];
        var merged = base.duplicate();
        merged.contents = lines.join("\r");
        fdMergeRowPositions = posLines;
        fdMergeFrameRef = merged;

        /* 位置对齐到原区域左上角 */
        var mb = merged.visibleBounds;
        merged.translate(minX - mb[0], maxY - mb[1]);

        for (var q = 0; q < frames.length; q++) {
            frames[q].hidden = true;
        }
        app.selection = null;
        merged.selected = true;

        return (
            '{"ok":true' +
            ',"merged":' + frames.length +
            ',"rows":' + rows.length +
            ',"lines":' + lines.length +
            "}"
        );
    } catch (e) {
        return '{"ok":false,"error":"' + fdJsonEscape(e.message) + '"}';
    }
}

/**
 * 按行拆分选中的文本框。逐行新建 pointText，原框隐藏保留。
 *
 * 2026-11-10 17:39 用户实测：点这个按钮 Illustrator 直接闪退。
 * Windows 事件日志：Illustrator.exe 崩在 ExtendScript.dll 4.5.6.1，
 * 异常码 0xc0000005（原生内存访问违例）—— JS 的 try/catch 完全挡不住，
 * 也不会留下任何 JS 堆栈。上一版里「从没在真实 AI 执行过」的宿主调用有：
 *   - a2[keys[k]] = a1[keys[k]]（宿主对象动态属性名赋值，首要嫌疑）
 *   - src.note / merged.note（PageItem 宿主属性）
 *   - src.textRange.paragraphAttributes、src.lines[q].contents
 * 全部移除。现在只保留在真实 AI 里反复验证过的调用：
 *   textFrames.add / kind / contents / characterAttributes.size /
 *   textFont = app.textFonts.getByName(...) / visibleBounds / translate / hidden
 * 字体也改成「读名字 → 重新按名字查」，不跨文本框传递宿主对象引用。
 * 每步同步写 split-trace.log，万一再崩，最后一行就是崩溃点。
 */
function fdSplitTextLines() {
    try {
        var f0 = new File(FD_RECOVER_DIR + "/split-trace.log");
        f0.open("w");
        f0.writeln("=== split start " + new Date().toString() + " ===");
        f0.close();
    } catch (e0) {}
    fdSplitTrace("enter");

    try {
        var frames = [];
        for (var i = 0; i < app.selection.length; i++) {
            if (app.selection[i].typename === "TextFrame") frames.push(app.selection[i]);
        }
        fdSplitTrace("selection textFrames=" + frames.length);
        if (frames.length === 0) {
            return '{"ok":false,"error":"请先选中文本框"}';
        }

        var layer = app.activeDocument.layers.add();
        layer.name = "FontDeck · 拆分结果";
        fdSplitTrace("layer added");

        var total = 0;
        var errors = [];
        var mode = "按行距推算";

        for (var f = 0; f < frames.length; f++) {
            var src = frames[f];
            try {
                fdSplitTrace("frame " + f + " read contents");
                var full = "" + src.contents;
                var parts = full.replace(/\r\n/g, "\r").replace(/\n/g, "\r").split("\r");
                fdSplitTrace("frame " + f + " parts=" + parts.length);

                if (parts.length > 200) {
                    errors.push("行数超过 200，只处理前 200 行");
                    parts = parts.slice(0, 200);
                }

                var sb = src.visibleBounds;
                var size = 12;
                var fontObj = null;
                try {
                    var a1 = src.textRange.characterAttributes;
                    var s0 = a1.size;
                    if (isFinite(s0) && s0 > 0) size = s0;
                    var fontName = "" + a1.textFont.name;
                    if (fontName) {
                        try {
                            fontObj = app.textFonts.getByName(fontName);
                        } catch (eFn) {}
                    }
                } catch (eA) {
                    fdSplitTrace("frame " + f + " read attrs failed (ignored)");
                }
                var leading = size * 1.2;
                if (!isFinite(leading) || leading <= 0) leading = 14.4;
                fdSplitTrace("frame " + f + " size=" + size + " leading=" + leading);

                var saved = null;
                try {
                    /* 必须正是上次合并的产物，且行数一致：
                       否则另一个「恰好也是 3 行」的文本框会套用上次的坐标 */
                    if (fdMergeFrameRef === src && fdMergeRowPositions &&
                        fdMergeRowPositions.length === parts.length) {
                        saved = fdMergeRowPositions;
                        mode = "合并前的原始位置";
                    }
                } catch (eS) {}
                fdSplitTrace("frame " + f + " saved=" + (saved ? saved.length : 0));

                for (var li = 0; li < parts.length; li++) {
                    var txt = parts[li];
                    if (txt === "") continue;

                    fdSplitTrace("frame " + f + " line " + li + " add");
                    var tf = layer.textFrames.add();
                    tf.kind = TextType.POINTTEXT;
                    tf.contents = txt;
                    fdSplitTrace("frame " + f + " line " + li + " contents ok");

                    /* 显式赋值，绝不用动态属性名 */
                    try {
                        tf.textRange.characterAttributes.size = size;
                    } catch (eSize) {}
                    fdSplitTrace("frame " + f + " line " + li + " size ok");
                    if (fontObj) {
                        try {
                            tf.textRange.characterAttributes.textFont = fontObj;
                        } catch (eFont) {}
                    }
                    fdSplitTrace("frame " + f + " line " + li + " font ok");

                    var tx = sb[0];
                    var ty = sb[3] + (parts.length - 1 - li) * leading;
                    if (saved && saved[li] && isFinite(saved[li][0]) && isFinite(saved[li][1])) {
                        tx = saved[li][0];
                        ty = saved[li][1];
                    }

                    var nb = tf.visibleBounds;
                    fdSplitTrace("frame " + f + " line " + li + " bounds ok");
                    if (isFinite(tx) && isFinite(ty) && isFinite(nb[0]) && isFinite(nb[3])) {
                        tf.translate(tx - nb[0], ty - nb[3]);
                    }
                    fdSplitTrace("frame " + f + " line " + li + " translated");
                    total++;
                }

                src.hidden = true;
                fdSplitTrace("frame " + f + " hidden");
            } catch (e3) {
                errors.push("文本框" + (f + 1) + ":" + e3.message);
                fdSplitTrace("frame " + f + " JS error " + e3.message);
            }
        }

        fdSplitTrace("done total=" + total);
        if (total === 0) {
            return (
                '{"ok":false,"error":"没有拆出任何行"' +
                ',"errors":' + fdArr(errors) +
                "}"
            );
        }

        /* 精确坐标只消费一次，别让它污染下一次拆分 */
        fdMergeRowPositions = null;
        fdMergeFrameRef = null;

        return (
            '{"ok":true' +
            ',"created":' + total +
            ',"mode":"' + fdJsonEscape(mode) + '"' +
            ',"layer":"' + fdJsonEscape(layer.name) + '"' +
            ',"errors":' + fdArr(errors) +
            "}"
        );
    } catch (e) {
        fdSplitTrace("outer JS error " + e.message);
        return '{"ok":false,"error":"' + fdJsonEscape(e.message) + '"}';
    }
}
