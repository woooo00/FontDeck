/**
 * 端到端验证：不依赖 Illustrator，用合成数据跑完整恢复流程。
 *
 * 做法：
 *   1. 用 fontkit 取真实字形轮廓，渲染成一张「模拟转曲导出图」
 *   2. 同时精确算出每个字的墨迹包围盒（就是 AI 侧 fdRecoverScan 会返回的东西）
 *   3. 可选：把每个字人为拆成上下两半，模拟「一个字被拆成多个路径」的情况
 *   4. 跑 pipeline，看识别结果、聚类是否正确、调试图长什么样
 *
 * 这一步能验证的东西：聚类算法、坐标换算、OCR、增强逻辑。
 * 验证不了的：Illustrator 的导出行为（那部分只能让用户在 AI 里跑）。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { recognizeScan, type ScanPayload } from "../packages/recover/src/pipeline.js";
import { getOcrEngine } from "../packages/ocr/src/client.js";

const require = createRequire(import.meta.url);
const fontkit = require("fontkit") as any;
const { Resvg } = require("@resvg/resvg-js");

const OUT = "data/recover-test";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const findFace = (ps: string) => idx.faces.find((f: any) => f.postScriptName === ps);

const FONT_SIZE = 10; // AI 里常见的正文磅值
const SCALE = 4; // 导出放大倍数，和 fdRecoverScan 一致
const PADDING = 1; // 点

interface Built {
  png: string;
  scan: ScanPayload;
  truth: string;
  font: string;
  split: boolean;
}

/** 把文字渲染成图，并算出每个字的像素包围盒。支持 \n 分行 */
function build(ps: string, text: string, split: boolean): Built | null {
  const face = findFace(ps);
  if (!face) return null;

  const opened = fontkit.openSync(face.filePath);
  const font = Array.isArray(opened.fonts)
    ? opened.fonts[face.collectionIndex] ?? opened.fonts[0]
    : opened;

  const upm = font.unitsPerEm || 1000;
  const scale = FONT_SIZE / upm;

  const ascent = (font.ascent ?? upm * 0.8) * scale;
  const descent = Math.abs(font.descent ?? upm * 0.2) * scale;
  const lineGap = FONT_SIZE * 1.45; // 行距

  const lines = text.split("\n");

  const glyphBoxes: { l: number; t: number; r: number; b: number }[] = [];
  const cmds: string[] = [];

  let maxLineW = 0;
  let lineIndex = 0;

  for (const lineText of lines) {
    const run = font.layout(lineText);
    /* 这一行在图片里相对第一行基线的竖直偏移 */
    const dyPt = lineIndex * lineGap;
    const baselinePt = PADDING + ascent + dyPt;

    let xUnits = 0;
    for (let i = 0; i < run.glyphs.length; i++) {
      const g = run.glyphs[i];
      const pos = run.positions[i] ?? { xAdvance: 0, xOffset: 0, yOffset: 0 };
      const d = g.path?.toSVG?.() ?? "";
      if (d) {
        cmds.push(
          `<path d="${d}" transform="translate(${(xUnits + (pos.xOffset ?? 0)).toFixed(2)} ${(-(pos.yOffset ?? 0)).toFixed(2)})"/>`
        );
      }

      let bb: any = null;
      try {
        bb = g.bbox;
      } catch {
        bb = null;
      }
      if (bb && bb.maxX > bb.minX && bb.maxY > bb.minY) {
        /*
         * 字体单位 → 点 → 像素。
         * 基线在 (PADDING + ascent)，字形 y 向上为正，所以：
         *   顶边 = 基线 - maxY * scale
         *   底边 = 基线 - minY * scale
         */
        const lPt = PADDING + (xUnits + bb.minX) * scale;
        const rPt = PADDING + (xUnits + bb.maxX) * scale;
        const tPt = baselinePt - bb.maxY * scale;
        const bPt = baselinePt - bb.minY * scale;
        glyphBoxes.push({
          l: Math.round(lPt * SCALE),
          t: Math.round(tPt * SCALE),
          r: Math.round(rPt * SCALE),
          b: Math.round(bPt * SCALE),
        });
      }
      xUnits += pos.xAdvance ?? 0;
    }

    const lineW = xUnits * scale + PADDING * 2;
    if (lineW > maxLineW) maxLineW = lineW;

    /* 每行单独一个 <g>：外层的 translate 已经含了行偏移，所以行内从 y=0 起 */
    cmds.push("</g><g>");
    lineIndex++;
  }

  const totalW = maxLineW;
  const totalH = ascent + descent + PADDING * 2 + (lines.length - 1) * lineGap;
  const pngW = Math.max(1, Math.round(totalW * SCALE));
  const pngH = Math.max(1, Math.round(totalH * SCALE));

  /* 每行的 g：translate 到该行基线，再 scale 翻转 y */
  const groups: string[] = [];
  let idx = 0;
  let cursor = 0;
  let li = 0;
  while (idx < cmds.length) {
    const chunk: string[] = [];
    while (idx < cmds.length && cmds[idx] !== "</g><g>") {
      chunk.push(cmds[idx]);
      idx++;
    }
    idx++; // 跳过分隔符
    const baselinePt = PADDING + ascent + li * lineGap;
    groups.push(
      `<g transform="translate(${PADDING} ${baselinePt.toFixed(3)}) scale(${scale.toFixed(6)} ${(-scale).toFixed(6)})" fill="#111111">` +
        chunk.join("") +
        `</g>`
    );
    li++;
    cursor++;
  }
  void cursor;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pngW}" ` +
    `height="${pngH}" viewBox="0 0 ${totalW.toFixed(3)} ${totalH.toFixed(3)}">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>` +
    groups.join("") +
    `</svg>`;

  const pngBuf = new Resvg(svg, { fitTo: { mode: "original" } })
    .render()
    .asPng();

  const file = path.join(OUT, `${ps}-${split ? "split" : "whole"}-${Date.now()}.png`);
  fs.writeFileSync(file, pngBuf);

  /* 模拟「一个字被拆成多个路径」：把每个字的框按上下切成两块 */
  let shapes: number[][] = glyphBoxes.map((b) => [b.l, b.t, b.r, b.b]);
  if (split) {
    shapes = [];
    for (const b of glyphBoxes) {
      const mid = Math.round((b.t + b.b) / 2);
      shapes.push([b.l, b.t, b.r, mid]);
      shapes.push([b.l, mid, b.r, b.b]);
    }
  }

  opened.close?.();

  return {
    png: file,
    truth: text,
    font: ps,
    split,
    scan: {
      png: path.resolve(file),
      pngW,
      pngH,
      scale: SCALE,
      originX: 0,
      originY: 0,
      ptsW: totalW,
      ptsH: totalH,
      textFrames: 0,
      shapeCount: shapes.length,
      shapes,
    },
  };
}

async function main() {
  const cases: Built[] = [];
  for (const c of [
    { ps: "SimSun", text: "永和九年" },
    { ps: "MicrosoftYaHei", text: "设计改变" },
    { ps: "SimHei", text: "订单编号" },
    { ps: "DengXian", text: "把转曲的文字恢复" },
    /* 标点与数字：标点墨迹很窄，容易被当成笔画并到邻字 */
    { ps: "SimSun", text: "价格：128.00元" },
    /* 中英混排：西文字符不是一 em 宽，考验字宽上限法 */
    { ps: "MicrosoftYaHei", text: "FontDeck字体" },
    /* 多行：考验分行逻辑和行距判断 */
    { ps: "SimSun", text: "永和九年\n岁在癸丑" },
    { ps: "MicrosoftYaHei", text: "设计改变生活\n从这里开始" },
  ]) {
    const b = build(c.ps, c.text, false);
    if (b) cases.push(b);
  }
  /* 同一个句子，但每个字被拆成上下两半 */
  const splitCase = build("SimSun", "永和九年", true);
  if (splitCase) cases.push(splitCase);

  console.log("测试样本：");
  for (const c of cases) {
    console.log(
      `  ${c.font.padEnd(18)} 「${c.truth}」  ${c.split ? "拆成双份轮廓" : "整字单轮廓"}  ` +
        `图 ${c.scan.pngW}x${c.scan.pngH}  轮廓 ${c.scan.shapeCount} 个`
    );
  }

  console.log("\n开始识别：");
  console.log("─".repeat(80));

  for (const c of cases) {
    try {
      console.log(`\n--- ${c.font} 「${c.truth}」 ${c.split ? "(拆分轮廓)" : ""} ---`);
      console.log(`  聚类输入 ${c.scan.shapes.length} 个框`);
      const r = await recognizeScan(c.scan, {
        debug: process.env.FD_DEBUG === "1",
        dumpDir: process.env.FD_DUMP ? `${process.env.FD_DUMP}/${c.font}-${c.split ? "split" : "whole"}` : "",
      });
      const truthFlat = c.truth.replace(/\n/g, "");
      const ok = r.text === truthFlat;
      const acc =
        [...truthFlat].filter((ch, i) => r.text[i] === ch).length / Math.max(1, truthFlat.length);
      console.log(
        `${ok ? "✓" : acc >= 0.75 ? "~" : "✗"} ${c.font.padEnd(18)}「${c.truth}」→「${r.text}」`
      );
      console.log(
        `    行 ${r.stats.rows} · 轮廓 ${r.stats.shapes} → 字 ${r.stats.chars} · ` +
          `切开 ${r.stats.splitBlocks} · 空 ${r.stats.emptyCount} · ` +
          `字高 ${r.stats.charHeight}px · 均分 ${r.stats.avgScore} · ${r.stats.durationMs}ms`
      );
      console.log(`    调试图 ${r.debugImage}`);
    } catch (e: any) {
      console.log(`✗ ${c.font} 失败：${e.message}`);
    }
  }

  console.log("─".repeat(80));

  /* OCR 是常驻子进程，不停掉的话 Node 的 event loop 永远不空，进程不退出 */
  getOcrEngine().stop();
  process.exit(0);
}

main().catch((e) => {
  console.error("异常:", e);
  getOcrEngine().stop();
  process.exit(1);
});
