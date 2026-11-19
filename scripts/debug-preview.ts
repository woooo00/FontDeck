/** 排查特定字体预览为空的成因 */
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fontkit = require("fontkit");

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const f = idx.faces.find(
  (x: any) => (x.familyZh || x.family).includes("未来荧黑")
);
if (!f) {
  console.log("没找到");
  process.exit(1);
}

console.log("file:", f.filePath);
console.log("index:", f.collectionIndex, "format:", f.format);
console.log("family:", f.family, "/", f.familyZh);
console.log("upm:", "");

const font = fontkit.openSync(f.filePath);
const target = Array.isArray(font.fonts) ? font.fonts[f.collectionIndex] : font;
console.log("unitsPerEm:", target.unitsPerEm);
console.log("ascent:", target.ascent, "descent:", target.descent);
console.log("numGlyphs:", target.numGlyphs);

const text = "永和九年 岁在癸丑";
let kept = "";
for (const ch of text) {
  const cp = ch.codePointAt(0)!;
  const ok = ch === " " || target.hasGlyphForCodePoint(cp);
  if (ok) kept += ch;
  else console.log("  缺字形:", ch, "U+" + cp.toString(16));
}
console.log("过滤后:", JSON.stringify(kept));

const run = target.layout(kept);
console.log("layout glyphs:", run.glyphs.length, "advanceWidth:", run.advanceWidth);
let emptyPaths = 0;
for (let i = 0; i < run.glyphs.length; i++) {
  const d = run.glyphs[i].path?.toSVG?.() ?? "";
  if (!d) emptyPaths++;
}
console.log("空 path 数:", emptyPaths);

const scale17 = 17 / target.unitsPerEm;
console.log("17px 时总宽:", (run.advanceWidth * scale17).toFixed(1), "px");
console.log("17px 时 ascent:", (target.ascent * scale17).toFixed(1));
console.log("17px 时 descent:", (Math.abs(target.descent) * scale17).toFixed(1));
