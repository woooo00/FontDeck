/*
 * 用假的 Illustrator 对象在 Node 里真跑一遍 host.jsx 的两个修复点：
 *   1) fdRecoverApply  —— 七个字应该合成「一行一个文本框」，而不是七个单字
 *   2) fdMergeTexts    —— 横排的七个单字合并后不能变成竖排（不能每字一个 \r）
 *
 * ExtendScript 是 ES3/ES5，Node 能直接执行。这里 mock 掉 app / TextType /
 * RGBColor，并用 getter 模拟 visibleBounds（AI 里它是随字号、字距实时变化的）。
 * 这样 tracking 的校准逻辑也能被真正执行，而不是只做语法检查。
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
    textRange: { characterAttributes: { size: 12, tracking: 0 } },
    translate(dx, dy) {
      this._x += dx;
      this._y += dy;
    },
    duplicate() {
      const t = makeTF(this.contents);
      t.textRange.characterAttributes.size = this.textRange.characterAttributes.size;
      t.textRange.characterAttributes.tracking = this.textRange.characterAttributes.tracking;
      /* 记录一份，测试里才能读到合并产物 */
      created.push(t);
      return t;
    },
  };
  Object.defineProperty(tf, "visibleBounds", {
    get() {
      const a = this.textRange.characterAttributes;
      const n = Array.from(this.contents).length;
      const w = n * a.size + Math.max(0, n - 1) * ((a.tracking || 0) / 1000) * a.size;
      const h = a.size * 0.88;
      return [this._x, this._y + h, this._x + w, this._y];
    },
  });
  return tf;
}

const layer = {
  name: "",
  textFrames: {
    add() {
      const t = makeTF("");
      created.push(t);
      return t;
    },
  },
};

global.app = {
  version: "29.6",
  documents: { length: 1 },
  activeDocument: { layers: { add: () => layer } },
  textFonts: {
    getByName(n) {
      /* 模拟「PostScript 名在 AI 里查不到、中文显示名可以」的情况 */
      if (n === "BAD-PS-NAME") throw new Error("not found");
      return { name: n };
    },
  },
  selection: [],
};
global.TextType = { POINTTEXT: "point" };
global.RGBColor = function () {};
global.Folder = function () {};
global.File = function () {};

const api = new Function(
  src + "\nreturn { fdRecoverApply, fdMergeTexts };"
)();

let failed = 0;
function check(name, cond, detail) {
  console.log((cond ? "  PASS  " : "  FAIL  ") + name + (detail ? "  " + detail : ""));
  if (!cond) failed++;
}

/* ---------- 1. 恢复：7 个字 → 1 个整行文本框 ---------- */
const TEXT = "滚滚长江东逝水";
const items = Array.from(TEXT).map((ch, i) => ({
  ch: ch,
  x: i * 36,
  y: 100,
  w: 30,
  h: 30,
  font: "",
}));

created = [];
const applyRet = JSON.parse(api.fdRecoverApply(JSON.stringify(items)));
console.log("\n[1] fdRecoverApply 返回:", JSON.stringify(applyRet));

check("成功", applyRet.ok === true);
check("只建 1 个文本框（整句）", created.length === 1, "实际 " + created.length);
check("内容是完整句子", created[0] && created[0].contents === TEXT,
  "实际 " + JSON.stringify(created[0] && created[0].contents));
check("只有 1 行", applyRet.rows === 1, "rows=" + applyRet.rows);
const tr = created[0] && created[0].textRange.characterAttributes.tracking;
check("tracking 已校准到原行宽", typeof tr === "number" && tr > 0 && tr < 2000, "tracking=" + tr);
check("字号按墨迹高放大过", created[0] && created[0].textRange.characterAttributes.size > 12,
  "size=" + (created[0] && created[0].textRange.characterAttributes.size));
const b = created[0] && created[0].visibleBounds;
check("行首对齐到原点", b && Math.abs(b[0]) < 0.01 && Math.abs(b[3] - 100) < 0.01,
  "bounds=" + JSON.stringify(b));

/* ---------- 2. 合并：横排单字不能变竖排 ---------- */
function singleRow() {
  return Array.from(TEXT).map((ch, i) => {
    const t = makeTF(ch);
    t.textRange.characterAttributes.size = 30;
    t._x = i * 36;
    t._y = 100;
    return t;
  });
}

let frames = singleRow();
global.app.selection = frames;
const mergeRet = JSON.parse(api.fdMergeTexts());
const merged = created.find((t) => t.contents.indexOf("\r") >= 0) || null;
console.log("\n[2] fdMergeTexts 返回:", JSON.stringify(mergeRet));

check("合并成功", mergeRet.ok === true);
check("只产生 1 行", mergeRet.lines === 1, "lines=" + mergeRet.lines);
check("合并结果不含换行（没变竖排）", mergeRet.lines === 1);
check("原单字框已隐藏", frames.every((f) => f.hidden === true));

/* 重新造一份，从 duplicate 出来的框上直接读内容 */
created = [];
frames = singleRow();
global.app.selection = frames;
api.fdMergeTexts();
const dup = created[0];
console.log("    合并后内容:", JSON.stringify(dup && dup.contents));
check("duplicate 内容与原文一致", dup && dup.contents === TEXT,
  "实际 " + JSON.stringify(dup && dup.contents));

/* ---------- 3. 多行：行与行之间才应该有换行 ---------- */
const twoRows = [
  makeTF("滚"), makeTF("滚"), makeTF("长"),
  makeTF("江"), makeTF("东"),
];
twoRows.forEach((t, i) => {
  t.textRange.characterAttributes.size = 30;
  t._x = (i % 3) * 36;
  t._y = i < 3 ? 140 : 100;
});
global.app.selection = twoRows;
const ret2 = JSON.parse(api.fdMergeTexts());
console.log("\n[3] 多行合并:", JSON.stringify(ret2));
check("识别为 2 行", ret2.lines === 2, "lines=" + ret2.lines);

/* ---------- 4. 字体名回退 ---------- */
created = [];
const fontItems = [
  { ch: "是", x: 0, y: 100, w: 30, h: 30, font: "BAD-PS-NAME", fontAlt: "华文新魏" },
  { ch: "的", x: 36, y: 100, w: 30, h: 30, font: "BAD-PS-NAME", fontAlt: "华文新魏" },
];
const fontRet = JSON.parse(api.fdRecoverApply(JSON.stringify(fontItems)));
console.log("\n[4] 字体名回退:", JSON.stringify(fontRet));
check("回退到中文显示名", fontRet.font === "华文新魏", "font=" + fontRet.font);
check("没有报字体不可用", (fontRet.errors || []).length === 0,
  JSON.stringify(fontRet.errors));

/* ---------- 5. 整行模式（英文整句，带行号） ---------- */
created = [];
const EN = "3. Fold the cord in the same way as it was first delivered in its packaging.";
const enRet = JSON.parse(api.fdRecoverApply(JSON.stringify([
  { ch: EN, row: 0, x: 10, y: 100, w: 245.5, h: 8, font: "MiSans-Regular" },
])));
console.log("\n[5] 整行模式:", JSON.stringify(enRet));
check("整句建成 1 个文本框", created.length === 1, "实际 " + created.length);
check("英文整句含空格完整保留", created[0] && created[0].contents === EN);
check("字体已应用", enRet.font === "MiSans-Regular", "font=" + enRet.font);
check("整行宽度闭环命中", enRet.calib &&
  Math.abs(enRet.calib.actualW - enRet.calib.targetW) < 0.2,
  JSON.stringify(enRet.calib));

console.log("\n" + (failed === 0 ? "全部通过" : failed + " 项未通过"));
process.exit(failed === 0 ? 0 : 1);
