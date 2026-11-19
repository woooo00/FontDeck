/**
 * 验证字体匹配：用已知字体造转曲图，看能不能反推回来。
 *
 * 判据放宽到「家族命中」：相似度本身分不开同款的不同字重（实测间隔 0.014），
 * 要求连字重都对上是不现实的标准。家族对上就等于闭环成立。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { recognizeScan } from "../packages/recover/src/pipeline.js";
import { matchFont } from "../packages/recover/src/fontMatch.js";
import { getOcrEngine } from "../packages/ocr/src/client.js";
import { familyKeyOf } from "../packages/font-core/src/family.js";

const require = createRequire(import.meta.url);
const fontkit = require("fontkit") as any;
const { Resvg } = require("@resvg/resvg-js");

const OUT = "data/match-test";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const FONT_SIZE = 10;
const SCALE = 4;
const PADDING = 1;

function buildScan(ps: string, text: string) {
  const face = idx.faces.find((f: any) => f.postScriptName === ps);
  if (!face) return null;

  const opened = fontkit.openSync(face.filePath);
  const font = Array.isArray(opened.fonts)
    ? opened.fonts[face.collectionIndex] ?? opened.fonts[0]
    : opened;

  const upm = font.unitsPerEm || 1000;
  const scale = FONT_SIZE / upm;
  const run = font.layout(text);
  const ascent = (font.ascent ?? upm * 0.8) * scale;
  const descent = Math.abs(font.descent ?? upm * 0.2) * scale;
  const baselinePt = PADDING + ascent;

  const boxes: number[][] = [];
  const cmds: string[] = [];
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
      boxes.push([
        Math.round((PADDING + (xUnits + bb.minX) * scale) * SCALE),
        Math.round((baselinePt - bb.maxY * scale) * SCALE),
        Math.round((PADDING + (xUnits + bb.maxX) * scale) * SCALE),
        Math.round((baselinePt - bb.minY * scale) * SCALE),
      ]);
    }
    xUnits += pos.xAdvance ?? 0;
  }

  const totalW = xUnits * scale + PADDING * 2;
  const totalH = ascent + descent + PADDING * 2;
  const pngW = Math.round(totalW * SCALE);
  const pngH = Math.round(totalH * SCALE);

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pngW}" height="${pngH}" ` +
    `viewBox="0 0 ${totalW.toFixed(3)} ${totalH.toFixed(3)}">` +
    `<rect width="100%" height="100%" fill="#ffffff"/>` +
    `<g transform="translate(${PADDING} ${baselinePt.toFixed(3)}) scale(${scale.toFixed(6)} ${(-scale).toFixed(6)})" fill="#111111">` +
    cmds.join("") +
    `</g></svg>`;

  const file = path.join(OUT, `${ps}-${Date.now()}.png`);
  fs.writeFileSync(file, new Resvg(svg, { fitTo: { mode: "original" } }).render().asPng());
  opened.close?.();

  return {
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
      shapeCount: boxes.length,
      shapes: boxes,
    },
    expectPs: ps,
    expectFamily: face.familyZh || face.family,
    expectKey: familyKeyOf(face.family, face.postScriptName),
    text,
  };
}

async function main() {
  const cases = [
    buildScan("SimSun", "永和九年岁在癸丑"),
    buildScan("MicrosoftYaHei", "设计改变生活"),
    buildScan("SimHei", "订单编号"),
    buildScan("DengXian", "把转曲的文字恢复"),
    buildScan("STKaiti", "春江花月夜"),
  ].filter(Boolean) as any[];

  console.log(`共 ${cases.length} 个案例，候选字体 ${idx.faces.filter((f: any) => f.hasCJK).length} 个（含中文）\n`);

  let hit = 0;

  for (const c of cases) {
    const t0 = Date.now();
    const rec = await recognizeScan(c.scan, { debug: false });
    const tRec = Date.now() - t0;

    const t1 = Date.now();
    const result = await matchFont(c.scan.png, rec.chars, idx, { limit: 5 });
    const tMatch = Date.now() - t1;

    const best = result.candidates[0] ?? null;
    const isHit = best && familyKeyOf(best.family, best.postScriptName) === c.expectKey;
    if (isHit) hit++;

    console.log(
      `${isHit ? "✓" : "✗"} 「${rec.text}」 期望 ${c.expectFamily}` +
        `  →  ${best ? best.familyZh || best.family : "无推荐"} ` +
        `(${best ? (best.score * 100).toFixed(0) : 0}%)  [识别 ${tRec}ms · 匹配 ${tMatch}ms]`
    );

    if (!isHit && best) {
      const top = result.candidates;
      console.log(
        "    前 5：" +
          top
            .map(
              (x) =>
                `${x.familyZh || x.family}(${x.subfamily}) ${(x.score * 100).toFixed(0)}%`
            )
            .join("  ")
      );
    }
    console.log(
      "    样本字：" +
        result.samples.join(" ") +
        "  期望 PS：" +
        c.expectPs
    );
  }

  console.log(`\n家族命中 ${hit}/${cases.length}`);

  getOcrEngine().stop();
  process.exit(0);
}

main().catch((e) => {
  console.error("失败:", e);
  getOcrEngine().stop();
  process.exit(1);
});
