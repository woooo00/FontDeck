/**
 * P0 验证第一步：造 OCR 测试图。
 *
 * 路径和产品里将来一样：字体 → fontkit 取字形轮廓 → SVG → resvg 栅格化 → PNG。
 *
 * 尺寸刻意按 PaddleOCR 的训练分布来（字高 ~48px、单行宽度几百像素）。
 * 之前按 64px 生成再放大到 1200 宽（单字 200px+），检测框会切错——
 * 那不是引擎的问题，是输入不在它的预期范围内。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { renderTextSvg } from "../packages/font-core/src/preview.js";

const require = createRequire(import.meta.url);
const { Resvg } = require("@resvg/resvg-js");

const OUT_DIR = "data/ocr-test";
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const findFace = (ps: string) =>
  idx.faces.find((f: any) => f.postScriptName === ps);

interface Case {
  name: string;
  ps: string;
  text: string;
  size?: number;
}

const CASES: Case[] = [
  { name: "01-宋体-长句", ps: "SimSun", text: "永和九年岁在癸丑" },
  { name: "02-雅黑-短句", ps: "MicrosoftYaHei", text: "设计改变生活" },
  { name: "03-黑体-数字", ps: "SimHei", text: "订单编号2024" },
  { name: "04-宋体-标点", ps: "SimSun", text: "价格：￥128.00" },
  { name: "05-雅黑-中英混排", ps: "MicrosoftYaHei", text: "FontDeck字体管理" },
  { name: "06-等线-长句", ps: "DengXian", text: "把转曲的文字恢复成可编辑" },
  { name: "07-宋体-小字号", ps: "SimSun", text: "设计改变生活", size: 32 },
  { name: "08-黑体-小字号", ps: "SimHei", text: "设计改变生活", size: 32 },
];

const manifest: { name: string; png: string; truth: string }[] = [];

for (const c of CASES) {
  const face = findFace(c.ps);
  if (!face) {
    console.log(`跳过 ${c.name}：找不到 ${c.ps}`);
    continue;
  }
  const svg = renderTextSvg(face.filePath, face.collectionIndex, {
    text: c.text,
    fontSize: c.size ?? 48,
    padding: 16,
    color: "#000000",
    background: "#ffffff",
    maxWidth: 4000,
  });
  if (!svg) {
    console.log(`跳过 ${c.name}：轮廓渲染失败`);
    continue;
  }
  const png = new Resvg(svg, { fitTo: { mode: "original" } }).render().asPng();
  const file = `${OUT_DIR}/${c.name}.png`;
  fs.writeFileSync(file, png);
  manifest.push({ name: c.name, png: file, truth: c.text });
  console.log(`  ${c.name}  ${(png.length / 1024).toFixed(0)} KB  「${c.text}」`);
}

fs.writeFileSync(
  `${OUT_DIR}/manifest.json`,
  JSON.stringify(manifest, null, 2),
  "utf-8"
);
console.log(`\n共生成 ${manifest.length} 张，清单在 ${OUT_DIR}/manifest.json`);
