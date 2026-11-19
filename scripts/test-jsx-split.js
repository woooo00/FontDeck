/*
 * 用假的 Illustrator 对象在 Node 里跑 host.jsx 的合并/拆分闭环。
 *
 * 关键：真实 Illustrator 的 TextFrame.lines 是 TextRange 的集合，
 * Line 对象**没有 visibleBounds**（它不是 PageItem）。旧版 fdSplitTextLines
 * 直接读 line.visibleBounds，一抛错整个文本框就被 catch 吞掉，最后返回
 * 「没有拆出任何行」——用户看到的就是「点了没反应」。
 *
 * 这里 mock 的 lines 故意不提供 visibleBounds，用来守住这个回归。
 */
const fs = require("fs");
const path = require("path");

const HOST = path.resolve(__dirname, "../apps/cep/host/host.jsx");
const src = fs.readFileSync(HOST, "utf8");

let created = [];

function makeTF(contents) {
  const tf = {
    _x: 0,
    _y: 0,
    kind: null,
    contents: contents || "",
    typename: "TextFrame",
    hidden: false,
    selected: false,
    note: "",
    textRange: {
      characterAttributes: {
        size: 12, tracking: 0, textFont: { name: "Mock" },
        fillColor: null, horizontalScale: 100,
      },
    },
    translate(dx, dy) { this._x += dx; this._y += dy; },
    duplicate() {
      const t = makeTF(this.contents);
      t.textRange.characterAttributes.size = this.textRange.characterAttributes.size;
      t.textRange.characterAttributes.tracking = this.textRange.characterAttributes.tracking;
      t.note = this.note;
      created.push(t);
      return t;
    },
  };

  /* AI 的 lines：只有 contents / characterAttributes，没有几何 */
  Object.defineProperty(tf, "lines", {
    get() {
      const parts = String(this.contents).split(/\r|\n/);
      const a = this.textRange.characterAttributes;
      const col = { length: parts.length };
      parts.forEach((s, i) => {
        /* 故意不提供 visibleBounds —— 真实 AI 的 Line 不是 PageItem */
        col[i] = {
          contents: s,
          characterAttributes: {
            size: a.size, textFont: a.textFont, fillColor: a.fillColor,
            tracking: a.tracking, horizontalScale: a.horizontalScale,
          },
        };
      });
      return col;
    },
  });

  Object.defineProperty(tf, "visibleBounds", {
    get() {
      const a = this.textRange.characterAttributes;
      const rows = String(this.contents).split(/\r|\n/);
      const n = Math.max.apply(null, rows.map((s) => Array.from(s).length));
      const w = n * a.size + Math.max(0, n - 1) * ((a.tracking || 0) / 1000) * a.size;
      const h = rows.length * a.size * 1.2;
      return [this._x, this._y + h, this._x + w, this._y];
    },
  });
  return tf;
}

const layers = [];
global.app = {
  version: "29.6",
  documents: { length: 1 },
  activeDocument: {
    layers: {
      add() {
        const l = { name: "", textFrames: { add: () => { const t = makeTF(""); created.push(t); return t; } } };
        layers.push(l);
        return l;
      },
    },
  },
  textFonts: { getByName: (n) => ({ name: n }) },
  selection: [],
};
global.TextType = { POINTTEXT: "point" };
global.RGBColor = function () {};
global.Folder = function () {};
global.File = function () {};

const api = new Function(
  src + "\nreturn { fdMergeTexts, fdSplitTextLines, fdLayoutVersion };"
)();

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (detail ? "  " + detail : ""));
  if (!cond) failed++;
}

const ver = JSON.parse(api.fdLayoutVersion());
check("布局脚本版本 v2（前端拆分守卫靠它）", ver.ok === true && ver.v === 2,
  JSON.stringify(ver));

const LINES = ["Manufacturer: Guangzhou Welltop", "Address: Room 701-706", "Dashi Street, Panyu"];

/* ---------- 1. 合并 → 拆分闭环 ---------- */
created = [];
const frames = LINES.map((s, i) => {
  const t = makeTF(s);
  t._x = 100;
  t._y = 300 - i * 40;
  t.textRange.characterAttributes.size = 12;
  return t;
});
global.app.selection = frames;
const mergeRet = JSON.parse(api.fdMergeTexts());
console.log("\n[1] 合并返回:", JSON.stringify(mergeRet));
const merged = created[created.length - 1];
check("合并成功", mergeRet.ok === true);
check("合并成 3 行", mergeRet.lines === 3, "lines=" + mergeRet.lines);
check("合并内容用 \\r 连接", merged && merged.contents === LINES.join("\r"),
  JSON.stringify(merged && merged.contents));

created = [];
global.app.selection = [merged];
const splitRet = JSON.parse(api.fdSplitTextLines());
console.log("[2] 拆分返回:", JSON.stringify(splitRet));
check("拆分成功（旧版会失败）", splitRet.ok === true,
  splitRet.ok ? "" : "error=" + splitRet.error);
check("拆出 3 个文本框", splitRet.created === 3, "created=" + splitRet.created);
check("新框数量确实是 3", created.length === 3, "实际 " + created.length);
if (created.length === 3) {
  check("逐行内容一致", created.every((t, i) => t.contents === LINES[i]),
    created.map((t) => t.contents).join(" | "));
  check("每行 x 对齐", created.every((t) => Math.abs(t.visibleBounds[0] - created[0].visibleBounds[0]) < 0.01));
  check("每行 y 递减（不重叠）",
    created[0].visibleBounds[3] > created[1].visibleBounds[3] &&
    created[1].visibleBounds[3] > created[2].visibleBounds[3],
    created.map((t) => t.visibleBounds[3].toFixed(1)).join(" > "));
  check("字号已复制", created[0].textRange.characterAttributes.size === 12);
}
check("原框已隐藏", merged.hidden === true);

/* ---------- 2. 单独一个多段文本框（没经过合并） ---------- */
created = [];
const plain = makeTF("第一行\r第二行\r第三行");
plain._x = 50; plain._y = 200;
plain.textRange.characterAttributes.size = 14;
global.app.selection = [plain];
const ret3 = JSON.parse(api.fdSplitTextLines());
console.log("[3] 独立多段框:", JSON.stringify(ret3));
check("独立框也能拆 3 行", ret3.ok === true && ret3.created === 3,
  JSON.stringify(ret3));
check("独立不误用上次的合并坐标", ret3.mode === "按行距推算",
  "mode=" + ret3.mode);

/* ---------- 3. 空选区要有明确报错 ---------- */
global.app.selection = [];
const ret4 = JSON.parse(api.fdSplitTextLines());
check("空选区明确报错", ret4.ok === false && !!ret4.error, JSON.stringify(ret4));

console.log("\n" + (failed === 0 ? "全部通过" : failed + " 项未通过"));
process.exit(failed === 0 ? 0 : 1);
