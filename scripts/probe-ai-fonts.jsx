/*
 * FontDeck P0-A 探针 / Probe
 * 用途：导出 Illustrator 当前识别到的全部字体，判断"用户级字体"是否可见。
 * 用法：Illustrator > 文件 > 脚本 > 其他脚本 -> 选中本文件
 * 输出：桌面 ai-fonts-<时间戳>.tsv
 *
 * 注意：ExtendScript 只支持 ES3，不要改成箭头函数 / let / const。
 */
#target illustrator

function fdPad2(n) {
    return n < 10 ? "0" + n : "" + n;
}

(function () {
    var d = new Date();
    var stamp = d.getFullYear() + fdPad2(d.getMonth() + 1) + fdPad2(d.getDate())
        + "-" + fdPad2(d.getHours()) + fdPad2(d.getMinutes()) + fdPad2(d.getSeconds());

    var rows = [];
    rows.push(["postScriptName", "family", "style", "type"].join("\t"));

    var fonts = app.textFonts;
    var n = 0;
    for (var i = 0; i < fonts.length; i++) {
        var f = fonts[i];
        var fam = "";
        var sty = "";
        var typ = "";
        try { fam = f.family; } catch (e) {}
        try { sty = f.style; } catch (e) {}
        try { typ = f.type; } catch (e) {}
        rows.push([f.name, fam, sty, typ].join("\t"));
        n++;
    }

    var out = Folder.desktop.fsName + "/ai-fonts-" + stamp + ".tsv";
    var file = new File(out);
    file.encoding = "UTF-8";
    if (!file.open("w")) {
        alert("无法写入文件：\n" + out);
        return;
    }
    file.write("\uFEFF" + rows.join("\r\n"));
    file.close();

    var docInfo = "";
    try {
        if (app.documents.length > 0) {
            var dt = app.documents[0].textFonts;
            var dl = [];
            for (var j = 0; j < dt.length; j++) {
                dl.push(dt[j].name);
            }
            docInfo = "\n当前文档使用字体：" + dl.length + " 个";
        }
    } catch (e2) {
        docInfo = "\n（检测文档字体时出错）";
    }

    alert("FontDeck 探针完成\n\n"
        + "AI 识别字体总数：" + n + "\n"
        + "AI 版本：" + app.version + "\n"
        + "导出文件：\n" + out
        + docInfo + "\n\n"
        + "请把这个文件发给饼饼。");
})();
