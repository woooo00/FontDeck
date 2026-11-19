/**
 * 端到端验证「几何 → 服务端渲染 → 识别」这条主通道。
 *
 * 模拟 Illustrator 侧 fdRecoverGeometry 的产出：把字体轮廓拆成
 * 「每点 6 个数（锚点 + 进控制 + 出控制）」的扁平点串，像素坐标、y 向下，
 * 和真实回传格式完全一致，然后打 /api/recover/geometry。
 *
 * 这条通道取代了原先让 AI 导出 PNG 的做法 —— 那个在真实文档上会卡死。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fontkit = require("fontkit") as any;

const API = "http://127.0.0.1:47615";
const FONT_SIZE = 10;
const SCALE = 4;
const PADDING = 2;

interface P {
  ax: number;
  ay: number;
  ix: number;
  iy: number;
  ox: number;
  oy: number;
}

/** fontkit 的 path commands → 每条轮廓的点序列（控制点用进/出柄表达） */
function contoursOf(glyphPath: any): P[][] {
  const cmds: any[] = glyphPath?.commands ?? [];
  const out: P[][] = [];
  let cur: P[] = [];

  const last = () => (cur.length ? cur[cur.length - 1] : null);

  for (const c of cmds) {
    const a = c.args ?? [];
    switch (c.command) {
      case "moveTo":
        if (cur.length > 1) out.push(cur);
        cur = [{ ax: a[0], ay: a[1], ix: a[0], iy: a[1], ox: a[0], oy: a[1] }];
        break;

      case "lineTo":
        cur.push({ ax: a[0], ay: a[1], ix: a[0], iy: a[1], ox: a[0], oy: a[1] });
        break;

      case "quadraticCurveTo": {
        const p0 = last();
        if (!p0) break;
        const qx = a[0];
        const qy = a[1];
        const ex = a[2];
        const ey = a[3];
        /* 二次转三次：控制点落在 P0→Q 的 2/3 与 P3→Q 的 2/3 处 */
        p0.ox = p0.ax + (2 / 3) * (qx - p0.ax);
        p0.oy = p0.ay + (2 / 3) * (qy - p0.ay);
        cur.push({
          ax: ex,
          ay: ey,
          ix: ex + (2 / 3) * (qx - ex),
          iy: ey + (2 / 3) * (qy - ey),
          ox: ex,
          oy: ey,
        });
        break;
      }

      case "bezierCurveTo": {
        const p0 = last();
        if (!p0) break;
        p0.ox = a[0];
        p0.oy = a[1];
        cur.push({
          ax: a[4],
          ay: a[5],
          ix: a[2],
          iy: a[3],
          ox: a[4],
          oy: a[5],
        });
        break;
      }

      case "closePath": {
        if (cur.length > 1) {
          const first = cur[0];
          const tail = cur[cur.length - 1];
          /* 首尾重合时把末点的进柄并到首点上，避免多出一段零长曲线 */
          if (Math.abs(tail.ax - first.ax) < 0.01 && Math.abs(tail.ay - first.ay) < 0.01) {
            first.ix = tail.ix;
            first.iy = tail.iy;
            cur.pop();
          }
        }
        if (cur.length > 1) out.push(cur);
        cur = [];
        break;
      }

      default:
        break;
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

function buildGeometry(ps: string, text: string) {
  const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
  const face = idx.faces.find((f: any) => f.postScriptName === ps);
  if (!face) throw new Error("找不到字体 " + ps);

  const opened = fontkit.openSync(face.filePath);
  const font = Array.isArray(opened.fonts)
    ? opened.fonts[face.collectionIndex] ?? opened.fonts[0]
    : opened;

  const upm = font.unitsPerEm || 1000;
  const s = FONT_SIZE / upm;
  const run = font.layout(text);

  const ascent = (font.ascent ?? upm * 0.8) * s;
  const descent = Math.abs(font.descent ?? upm * 0.2) * s;
  const baseline = PADDING + ascent;

  /* 第一遍：字体单位下的点，同时求整体包围盒 */
  const glyphPolys: P[][][] = [];
  let xUnits = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < run.glyphs.length; i++) {
    const g = run.glyphs[i];
    const pos = run.positions[i] ?? { xAdvance: 0, xOffset: 0, yOffset: 0 };
    const dx = xUnits + (pos.xOffset ?? 0);
    const dy = -(pos.yOffset ?? 0);

    const polys = contoursOf(g.path).map((cs) =>
      cs.map((p) => ({
        ax: p.ax + dx,
        ay: p.ay + dy,
        ix: p.ix + dx,
        iy: p.iy + dy,
        ox: p.ox + dx,
        oy: p.oy + dy,
      }))
    );
    glyphPolys.push(polys);

    for (const cs of polys) {
      for (const p of cs) {
        if (p.ax < minX) minX = p.ax;
        if (p.ax > maxX) maxX = p.ax;
        if (p.ay < minY) minY = p.ay;
        if (p.ay > maxY) maxY = p.ay;
      }
    }
    xUnits += pos.xAdvance ?? 0;
  }

  /*
   * 和 JSX 的 fdRecoverGeometry 同一套换算：
   * 画布从墨迹并集外扩 PADDING 开始，x 向右、y 向下，单位像素。
   * 文档坐标（pt）里 y 是向上的，所以像素 y 要用 (maxY - ay) 来翻。
   */
  const ox = minX * s - PADDING;
  const originY = baseline - minY * s - PADDING;

  const ptsW = (maxX - minX) * s + PADDING * 2;
  const ptsH = (maxY - minY) * s + PADDING * 2;
  const W = Math.round(ptsW * SCALE);
  const H = Math.round(ptsH * SCALE);

  const shapes = glyphPolys
    .filter((polys) => polys.length > 0)
    .map((polys) => ({
      c: 1,
      p: polys.map((cs) => {
        const flat: number[] = [];
        for (const p of cs) {
          flat.push(
            Math.round(((p.ax - minX) * s + PADDING) * SCALE),
            Math.round(((maxY - p.ay) * s + PADDING) * SCALE),
            Math.round(((p.ix - minX) * s + PADDING) * SCALE),
            Math.round(((maxY - p.iy) * s + PADDING) * SCALE),
            Math.round(((p.ox - minX) * s + PADDING) * SCALE),
            Math.round(((maxY - p.oy) * s + PADDING) * SCALE)
          );
        }
        return flat;
      }),
    }));

  opened.close?.();

  return {
    geom: {
      w: W,
      h: H,
      scale: SCALE,
      originX: ox,
      originY,
      ptsW,
      ptsH,
      textFrames: 0,
      shapeCount: shapes.length,
      shapes,
    },
    ps,
    text,
  };
}

async function main() {
  const cases = [
    buildGeometry("SimHei", "订单编号"),
    buildGeometry("MicrosoftYaHei", "设计改变生活"),
    buildGeometry("SimSun", "永和九年岁在癸丑"),
  ];

  let pass = 0;
  for (const c of cases) {
    console.log(`\n=== 「${c.text}」 真实字体 ${c.ps} ===`);
    console.log(
      `  画布 ${c.geom.w}×${c.geom.h}，轮廓 ${c.geom.shapeCount}，点数合计 ${c.geom.shapes.reduce(
        (n, s) => n + s.p.reduce((m, f) => m + f.length / 6, 0),
        0
      )}`
    );

    const t0 = Date.now();
    const r = await fetch(`${API}/api/recover/geometry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c.geom),
    });
    const d: any = await r.json();

    if (!d.ok) {
      console.log("  ✗ 失败:", d.error);
      continue;
    }

    const same = d.text === c.text;
    if (same) pass++;
    console.log(
      `  ${same ? "✓" : "✗"} 识别「${d.text}」 行 ${d.stats.rows} 单元 ${d.stats.chars} ` +
        `耗时 ${Date.now() - t0}ms（识别 ${d.stats.durationMs}ms）`
    );

    const bad = d.chars
      .map((x: any, i: number) => (x.ch !== c.text[i] ? `${i}:${x.ch || "空"}(分数${x.score})` : ""))
      .filter(Boolean);
    if (bad.length) console.log("  错字位置：" + bad.join(" "));
    if (d.debugImage) console.log("  标注图：" + d.debugImage);

    /* 面板点完识别会自动跑字体匹配，这里一并验证，别让它单独挂掉 */
    const samples = d.chars
      .filter((x: any) => x.ch && x.box)
      .map((x: any) => ({ ch: x.ch, score: x.score, box: [x.box.l, x.box.t, x.box.r, x.box.b] }));

    if (samples.length) {
      const rm = await fetch(`${API}/api/recover/match`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ png: d.png, chars: samples }),
      });
      const dm: any = await rm.json();
      if (!dm.ok) {
        console.log("  ✗ 字体匹配失败:", dm.error);
      } else {
        console.log(
          `  字体匹配 ${dm.durationMs}ms → ` +
            dm.candidates
              .slice(0, 3)
              .map((x: any) => `${x.familyZh || x.family}(${x.subfamily})${x.rel}%`)
              .join("  ")
        );
      }
    }
  }

  console.log(`\n结果：${pass}/${cases.length} 完全正确`);
}

main().catch((e) => {
  console.error("失败:", e);
  process.exit(1);
});
