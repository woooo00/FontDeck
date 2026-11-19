/**
 * 字形相似度引擎
 *
 * 用途：
 *   1. 字体替代推荐（文档缺字体时找本机最像的）
 *   2. 重复检测辅助（按字形而非名字）
 *   3. 按样子找字体
 *
 * 做法：取字形轮廓 → 按「墨迹包围盒」归一化 → 光栅化成 64×64 位图
 *      → 压成 16×16 的墨迹密度向量 → 余弦相似度。
 *
 * 三个关键设计决定，都是踩过坑之后定的：
 *
 * 1) 按墨迹包围盒归一化，不按 em 框。
 *    不同字体的字面大小本来就不同（思源黑体字面比苹方大），按 em 框比会把
 *    「字面大」误判成「形状不同」。按墨迹框归一化比的是纯形状。
 *
 * 2) 用分块密度 + 余弦，不用位图 IoU。
 *    IoU 对笔画粗细极度敏感——实测「微软雅黑 Regular vs Bold」只有 0.574，
 *    而「雅黑 Bold vs 思源黑 Bold」有 0.826，同款字体反而比异款分数低，没法用。
 *    试过用膨胀/腐蚀归一化笔画粗细，但分辨率不够时形态学操作会破坏字形结构。
 *    余弦相似度对「整体线性缩放」天然不敏感（B = k·A 时 cos = 1），
 *    粗细变了分数几乎不动，字形结构差异则保留在密度分布里。
 *
 * 3) 分辨率必须 64，不能 32。
 *    32×32 下汉字内部笔画糊成一片，宋体和黑体只差 0.09，区分不开。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fontkit = require("fontkit") as any;

/** 位图边长。64 是实测下限：32 时汉字笔画糊成一片，宋体和黑体分不开 */
export const GRID = 64;

/** 密度网格边长。每格 4×4 像素，统计意义足够且向量只有 256 维 */
export const BLOCKS = 16;

export interface GlyphMask {
  /** 每像素 1 字节，0 或 1 */
  pixels: Uint8Array;
  /** 墨迹覆盖率，用来剔除空白字形 */
  coverage: number;
}

export interface SamplePair {
  /** 有 CJK 字形时用的字。都是常用字，几乎所有中文字体都有；
      结构上兼顾独体（人）、包围（国）、上下（家）、八法（永） */
  cjk: string[];
  /** 纯西文字体用的字，涵盖直笔、下伸部、圆形、斜笔 */
  latin: string[];
}

export const SAMPLES: SamplePair = {
  cjk: ["永", "国", "人", "家"],
  latin: ["R", "g", "a", "Q"],
};

/* ------------------------------------------------------------------ */
/* 轮廓 → 位图                                                         */
/* ------------------------------------------------------------------ */

/*
 * 这里不用 @resvg/resvg-js 光栅化：实测它每次渲染要 746ms（每次都在重建
 * 渲染上下文），781 个字体 × 4 个字要 39 分钟，不可接受。
 * 自己写扫描线填充，反正最后要二值化，不需要抗锯齿，单字形 ~0.1ms。
 */

type Point = [number, number];

/** 把 path 命令摊平成多边形轮廓（贝塞尔按固定步数采样） */
function flattenPath(
  commands: any[],
  mapX: (v: number) => number,
  mapY: (v: number) => number
): Point[][] {
  const polys: Point[][] = [];
  let cur: Point[] = [];
  let cx = 0;
  let cy = 0;

  const push = (x: number, y: number) => {
    cur.push([x, y]);
    cx = x;
    cy = y;
  };

  for (const cmd of commands) {
    const a = cmd.args ?? [];
    switch (cmd.command) {
      case "moveTo":
        if (cur.length > 1) polys.push(cur);
        cur = [];
        push(mapX(a[0]), mapY(a[1]));
        break;
      case "lineTo":
        push(mapX(a[0]), mapY(a[1]));
        break;
      case "quadraticCurveTo": {
        const x1 = mapX(a[0]);
        const y1 = mapY(a[1]);
        const x2 = mapX(a[2]);
        const y2 = mapY(a[3]);
        const steps = 10;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const mt = 1 - t;
          push(
            mt * mt * cx + 2 * mt * t * x1 + t * t * x2,
            mt * mt * cy + 2 * mt * t * y1 + t * t * y2
          );
        }
        break;
      }
      case "bezierCurveTo": {
        const x1 = mapX(a[0]);
        const y1 = mapY(a[1]);
        const x2 = mapX(a[2]);
        const y2 = mapY(a[3]);
        const x3 = mapX(a[4]);
        const y3 = mapY(a[5]);
        const steps = 12;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const mt = 1 - t;
          push(
            mt * mt * mt * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
            mt * mt * mt * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3
          );
        }
        break;
      }
      case "closePath":
        if (cur.length > 1) {
          cur.push([cur[0][0], cur[0][1]]);
          polys.push(cur);
          cur = [];
        }
        break;
      default:
        break;
    }
  }
  if (cur.length > 1) polys.push(cur);
  return polys;
}

/** 扫描线填充，even-odd 规则。字体轮廓外顺内逆，even-odd 与 nonzero 结果一致 */
function scanlineFill(polys: Point[][], grid: number): Uint8Array {
  const px = new Uint8Array(grid * grid);
  if (polys.length === 0) return px;

  for (let y = 0; y < grid; y++) {
    const sy = y + 0.5;
    const xs: number[] = [];

    for (const poly of polys) {
      for (let i = 0; i < poly.length - 1; i++) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[i + 1];
        if ((y1 <= sy && y2 > sy) || (y2 <= sy && y1 > sy)) {
          const t = (sy - y1) / (y2 - y1);
          xs.push(x1 + t * (x2 - x1));
        }
      }
    }

    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);

    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(grid - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) px[y * grid + x] = 1;
    }
  }

  return px;
}

/** 取出字体里某个字的位图。找不到字形或渲染失败返回 null */
export function glyphMask(font: any, char: string): GlyphMask | null {
  let path: any;
  try {
    const cp = char.codePointAt(0);
    if (cp === undefined) return null;
    if (typeof font.hasGlyphForCodePoint === "function" && !font.hasGlyphForCodePoint(cp)) {
      return null;
    }
    const run = font.layout(char);
    if (!run?.glyphs?.length) return null;
    path = run.glyphs[0]?.path;
    if (!path) return null;
  } catch {
    return null;
  }

  const commands: any[] = path.commands ?? [];
  if (commands.length === 0) return null;

  let bbox: any;
  try {
    bbox = path.bbox;
  } catch {
    bbox = null;
  }
  if (!bbox) return null;

  const bw = bbox.maxX - bbox.minX;
  const bh = bbox.maxY - bbox.minY;
  if (!(bw > 0) || !(bh > 0)) return null;

  // 按墨迹包围盒等比缩放，居中放进 GRID×GRID
  const pad = 2;
  const scale = (GRID - pad * 2) / Math.max(bw, bh);
  const offsetX = (GRID - bw * scale) / 2;
  const offsetY = (GRID - bh * scale) / 2;

  // 字体坐标 y 向上，位图 y 向下，这里翻转
  const polys = flattenPath(
    commands,
    (x) => (x - bbox.minX) * scale + offsetX,
    (y) => (bbox.maxY - y) * scale + offsetY
  );
  if (polys.length === 0) return null;

  const pixels = scanlineFill(polys, GRID);
  let ink = 0;
  for (let i = 0; i < pixels.length; i++) ink += pixels[i];

  // 少于 16 个像素基本是噪点或极细线条，没有比较价值
  if (ink < 16) return null;
  return { pixels, coverage: ink / (GRID * GRID) };
}

/* ------------------------------------------------------------------ */
/* 密度向量                                                            */
/* ------------------------------------------------------------------ */

/** 把位图压成 BLOCKS×BLOCKS 的墨迹密度向量，每个分量 0..1 */
export function densityVector(mask: GlyphMask): Float32Array {
  const size = GRID / BLOCKS;
  const out = new Float32Array(BLOCKS * BLOCKS);
  for (let by = 0; by < BLOCKS; by++) {
    for (let bx = 0; bx < BLOCKS; bx++) {
      let n = 0;
      for (let y = by * size; y < (by + 1) * size; y++) {
        const rowBase = y * GRID;
        for (let x = bx * size; x < (bx + 1) * size; x++) {
          n += mask.pixels[rowBase + x];
        }
      }
      out[by * BLOCKS + bx] = n / (size * size);
    }
  }
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ------------------------------------------------------------------ */
/* 字体级签名                                                          */
/* ------------------------------------------------------------------ */

export interface FontSignature {
  samples: string[];
  /** 每个样本字的密度向量，缺字为 null */
  density: (Float32Array | null)[];
  /**
   * 每个样本字的位图，配合 IoU 用。
   * 可选：落盘的相似度表只存密度向量，服务端从磁盘重建签名时没有位图。
   */
  masks?: (GlyphMask | null)[];
  /** 参与比较的有效字形数 */
  valid: number;
}

/** 打开字体文件并按有无 CJK 选样本字，生成签名 */
export function signatureForFace(
  filePath: string,
  collectionIndex: number,
  hasCJK: boolean
): FontSignature | null {
  let opened: any;
  try {
    opened = fontkit.openSync(filePath);
  } catch {
    return null;
  }

  try {
    const font = Array.isArray(opened?.fonts)
      ? opened.fonts[collectionIndex] ?? opened.fonts[0]
      : opened;
    if (!font) return null;

    const samples = hasCJK ? SAMPLES.cjk : SAMPLES.latin;
    const masks = samples.map((ch) => glyphMask(font, ch));
    const density = masks.map((m) => (m ? densityVector(m) : null));
    const valid = masks.filter(Boolean).length;
    if (valid === 0) return null;
    return { samples: [...samples], density, masks, valid };
  } catch {
    return null;
  } finally {
    try {
      opened?.close?.();
    } catch {
      /* ignore */
    }
  }
}

/** 位图交并比 */
export function pixelIoU(a: GlyphMask, b: GlyphMask): number {
  let inter = 0;
  let uni = 0;
  const n = a.pixels.length;
  for (let i = 0; i < n; i++) {
    const x = a.pixels[i];
    const y = b.pixels[i];
    if (x & y) inter++;
    if (x | y) uni++;
  }
  return uni === 0 ? 0 : inter / uni;
}

/**
 * 混合相似度 = 密度余弦 + 位图 IoU。
 * 余弦对笔画粗细免疫但丢位置信息，IoU 对位置敏感但怕粗细变化，
 * 两者互补。权重是扫出来的，见 scripts/tune-similarity.ts。
 */
export function signatureSimilarity(
  a: FontSignature,
  b: FontSignature,
  iouWeight = 0.5
): number {
  // 样本字必须一致，否则是拿「永」跟「R」比，毫无意义
  if (a.samples.length !== b.samples.length) return 0;
  for (let i = 0; i < a.samples.length; i++) {
    if (a.samples[i] !== b.samples[i]) return 0;
  }

  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.density.length; i++) {
    const da = a.density[i];
    const db = b.density[i];
    if (!da || !db) continue;
    const cosScore = cosine(da, db);
    // 位图只有内存里才有（落盘表只存密度），没有就退化成纯余弦
    const ma = a.masks?.[i];
    const mb = b.masks?.[i];
    const iouScore = iouWeight > 0 && ma && mb ? pixelIoU(ma, mb) : cosScore;
    sum += cosScore * (1 - iouWeight) + iouScore * iouWeight;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/* ------------------------------------------------------------------ */
/* 字形指纹：判断「是不是同一份字形数据」                                 */
/* ------------------------------------------------------------------ */

/*
 * 相似度判断不了「同一款字体的不同字重」（实测间隔只有 0.014）：
 * Regular 和 Bold 的笔画粗细差一倍，结构差异比两款不同的黑体还大。
 * 但「重复检测」要回答的是另一个问题——这两份文件是不是同一份字形。
 * 那用指纹（轮廓坐标序列的哈希）比相似度准确得多：
 * 坐标完全一致 = 同一份数据；只是文件名或 PostScript 名被改了也能抓出来。
 */

function fnv1a(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 取某个字的轮廓指纹。坐标取整到 0.1，吸收不同文件间的浮点误差 */
export function glyphFingerprint(font: any, char: string): string | null {
  try {
    const cp = char.codePointAt(0);
    if (cp === undefined) return null;
    if (typeof font.hasGlyphForCodePoint === "function" && !font.hasGlyphForCodePoint(cp)) {
      return null;
    }
    const run = font.layout(char);
    const path = run?.glyphs?.[0]?.path;
    if (!path) return null;
    const commands: any[] = path.commands ?? [];
    if (commands.length === 0) return null;

    const parts: string[] = [];
    for (const cmd of commands) {
      parts.push(cmd.command);
      for (const v of cmd.args ?? []) {
        parts.push(String(Math.round(v * 10)));
      }
    }
    return fnv1a(parts.join(","));
  } catch {
    return null;
  }
}

/** 字体级指纹：所有样本字的指纹拼接后再哈希一次 */
export function faceFingerprint(filePath: string, collectionIndex: number): string | null {
  let opened: any;
  try {
    opened = fontkit.openSync(filePath);
  } catch {
    return null;
  }
  try {
    const font = Array.isArray(opened?.fonts)
      ? opened.fonts[collectionIndex] ?? opened.fonts[0]
      : opened;
    if (!font) return null;

    const all = [...SAMPLES.cjk, ...SAMPLES.latin];
    const fps: string[] = [];
    for (const ch of all) {
      const fp = glyphFingerprint(font, ch);
      fps.push(fp ?? "-");
    }
    // 一个字形都没有的话没有意义
    if (fps.every((f) => f === "-")) return null;
    return fnv1a(fps.join("|"));
  } catch {
    return null;
  } finally {
    try {
      opened?.close?.();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 序列化：密度向量量化成 uint8，体积小，够用                           */
/* ------------------------------------------------------------------ */

export function densityToBase64(density: (Float32Array | null)[], count: number): string {
  const buf = Buffer.alloc(count * BLOCKS * BLOCKS);
  let off = 0;
  for (let k = 0; k < count; k++) {
    const d = density[k];
    for (let i = 0; i < BLOCKS * BLOCKS; i++) {
      buf[off++] = d ? Math.round(Math.min(1, Math.max(0, d[i])) * 255) : 0;
    }
  }
  return buf.toString("base64");
}

export function densityFromBase64(b64: string, count: number): (Float32Array | null)[] {
  const buf = Buffer.from(b64, "base64");
  const out: (Float32Array | null)[] = [];
  for (let k = 0; k < count; k++) {
    const base = k * BLOCKS * BLOCKS;
    let sum = 0;
    const arr = new Float32Array(BLOCKS * BLOCKS);
    for (let i = 0; i < BLOCKS * BLOCKS; i++) {
      arr[i] = buf[base + i] / 255;
      sum += arr[i];
    }
    out.push(sum === 0 ? null : arr);
  }
  return out;
}
