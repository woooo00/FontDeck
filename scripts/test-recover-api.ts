/**
 * 通过 HTTP 接口跑一遍恢复识别，验证服务端路由真的能用。
 * 和 test-recover.ts 的区别：那个直接调函数，这个走完整的 HTTP 链路。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fontkit = require("fontkit") as any;
const { Resvg } = require("@resvg/resvg-js");

const API = "http://127.0.0.1:47615";
const OUT = "data/recover-api-test";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const FONT_SIZE = 10;
const SCALE = 4;
const PADDING = 1;

function build(ps: string, text: string) {
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
    _truth: text,
  };
}

async function main() {
  const cases = [
    build("SimHei", "订单编号"),
    build("SimSun", "永和九年岁在癸丑"),
    build("MicrosoftYaHei", "设计改变生活"),
  ].filter(Boolean) as any[];

  for (const c of cases) {
    const truth = c._truth;
    delete c._truth;

    const t = Date.now();
    const r = await fetch(`${API}/api/recover/recognize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c),
    });
    const d: any = await r.json();
    const cost = Date.now() - t;

    if (!d.ok) {
      console.log(`✗ 「${truth}」 HTTP ${r.status} 错误：${d.error}`);
      continue;
    }
    const ok = d.text === truth;
    console.log(
      `${ok ? "✓" : "✗"} 「${truth}」→「${d.text}」  ${cost}ms  ` +
        `字 ${d.stats.chars} 行 ${d.stats.rows} 空白 ${d.stats.emptyCount}`
    );
    if (d.debugImage) console.log(`    标注图 ${d.debugImage}`);

    /* 抽查第一个字的文档坐标，确认换算没跑偏 */
    const c0 = d.chars[0];
    console.log(
      `    首字「${c0.ch}」像素框 ${JSON.stringify(c0.box)} → 文档坐标 ` +
        `x=${c0.doc.x.toFixed(2)} y=${c0.doc.y.toFixed(2)} h=${c0.doc.h.toFixed(2)}`
    );
  }
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
