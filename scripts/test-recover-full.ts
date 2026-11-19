/**
 * 完整链路：扫描 → 识别 → 字体匹配，全部走 HTTP。
 * 等价于面板里点一次「识别」会发生的所有事。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fontkit = require("fontkit") as any;
const { Resvg } = require("@resvg/resvg-js");

const API = "http://127.0.0.1:47615";
const OUT = "data/recover-full";
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
    ps,
    text,
  };
}

async function main() {
  const cases = [
    buildScan("SimHei", "订单编号"),
    buildScan("MicrosoftYaHei", "设计改变生活"),
  ].filter(Boolean) as any[];

  for (const c of cases) {
    console.log(`\n=== 「${c.text}」 真实字体 ${c.ps} ===`);

    const r1 = await fetch(`${API}/api/recover/recognize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c.scan),
    });
    const d1: any = await r1.json();
    if (!d1.ok) {
      console.log("识别失败:", d1.error);
      continue;
    }
    console.log(`识别：「${d1.text}」 ${d1.stats.durationMs}ms`);

    const samples = d1.chars
      .filter((x: any) => x.ch && x.box)
      .map((x: any) => ({
        ch: x.ch,
        score: x.score,
        box: [x.box.l, x.box.t, x.box.r, x.box.b],
      }));

    const r2 = await fetch(`${API}/api/recover/match`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ png: c.scan.png, chars: samples }),
    });
    const d2: any = await r2.json();
    if (!d2.ok) {
      console.log("匹配失败:", d2.error);
      continue;
    }

    console.log(`字体匹配 ${d2.durationMs}ms，样本字 ${d2.samples.join(" ")}`);
    console.log(
      "  候选：" +
        d2.candidates
          .map((x: any) => `${x.familyZh || x.family}(${x.subfamily}) ${x.rel}%`)
          .join("  ")
    );
    console.log(`  综合推荐：${d2.best ? (d2.best.familyZh || d2.best.family) + " " + d2.best.subfamily : "无"}`);
  }
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
