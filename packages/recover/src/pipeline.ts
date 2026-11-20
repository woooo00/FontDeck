/**
 * 转曲恢复的编排层：扫描结果 → 聚类成字 → 逐字识别 → 调试图。
 *
 * 调试图是刻意做的：聚类参数（间隙阈值、粘连切分）只能靠真实数据调，
 * 没有可视化就是在盲猜。每次识别都额外产出一张标注图，
 * 一眼能看出「是不是一个字一个框」。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { getOcrEngine } from "../../ocr/src/client.js";
import { clusterShapes, boxToDocPoint, type Box } from "./cluster.js";

const require = createRequire(import.meta.url);
const { Resvg } = require("@resvg/resvg-js");

export type Orientation = "h" | "v";

/** Illustrator 侧 fdRecoverScan 的返回 */
export interface ScanPayload {
  png: string;
  pngW: number;
  pngH: number;
  scale: number;
  /** 图片左上角对应的文档坐标 */
  originX: number;
  /** 图片左下角对应的文档 y */
  originY: number;
  ptsW: number;
  ptsH: number;
  textFrames: number;
  shapeCount: number;
  /** 每个轮廓的像素框 [l, t, r, b] */
  shapes: number[][];
  /**
   * 渲染位图投影算出的分带 [a, b][]。
   * h: y 区间（从上到下）；v: x 区间（从右到左，中文竖排阅读顺序）。
   * 语义由 orientation 决定，别混用。
   */
  bands?: number[][];
  /** 文字排列方向；缺省按横排处理，保证旧调用方不改也能跑 */
  orientation?: Orientation;
  /** 倾斜稿摆正的逆变换；未摆正时为空 */
  skew?: SkewTransform | null;
}

/** 渲染端摆正倾斜稿时记录的逆变换（单位：原始画布像素） */
export interface SkewTransform {
  angle: number;
  cx: number;
  cy: number;
  dx: number;
  dy: number;
  w0: number;
  h0: number;
}

/**
 * 把「摆正画布」里的像素框逆变换回「原始画布」坐标系。
 *
 * 摆正时对点做的是 p' = R(-a)·(p - C) + C + D，
 * 所以逆变换是 p = R(+a)·(p' - C - D) + C。
 * 取四角变换后的外接矩形：斜框在原画布里本来就是斜的，
 * 恢复成可编辑文字只能给轴对齐包围盒（位置近似，角度本轮不还原）。
 */
export function unrotateBox(box: Box, s: SkewTransform): Box {
  const t = (s.angle * Math.PI) / 180;
  const co = Math.cos(t);
  const si = Math.sin(t);
  const corners: Array<[number, number]> = [
    [box.l, box.t],
    [box.r, box.t],
    [box.r, box.b],
    [box.l, box.b],
  ];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of corners) {
    const vx = x - s.dx - s.cx;
    const vy = y - s.dy - s.cy;
    const ox = co * vx - si * vy + s.cx;
    const oy = si * vx + co * vy + s.cy;
    minX = Math.min(minX, ox);
    maxX = Math.max(maxX, ox);
    minY = Math.min(minY, oy);
    maxY = Math.max(maxY, oy);
  }
  return { l: minX, t: minY, r: maxX, b: maxY };
}

export interface RecognizedChar {
  ch: string;
  score: number;
  /** 像素框 */
  box: Box;
  /** 文档坐标：左下角 + 宽高 */
  doc: { x: number; y: number; w: number; h: number };
  polarity?: "dark" | "light";
  error?: string;
  /** 长文提速时跳过了逐字 OCR，这个框只是位置真值，不是「没认出来」 */
  skipped?: boolean;
}

export interface RecognizedLine {
  text: string;
  score: number;
  /** 自动语种切换时记录实际用的引擎（zh / ru），诊断日志要看 */
  engine?: string;
  /** 像素框（整行墨迹并集） */
  box: Box;
  /** 文档坐标：左下角 + 宽高 */
  doc: { x: number; y: number; w: number; h: number };
  /** 行级几何：字宽比（字符紧致宽高比中位数）/ 墨迹密度 / 倾角（度） */
  stats?: { width: number; density: number; angle: number };
  /**
   * 这一行内「单个字」的墨迹高（文档 pt）中位数。
   * 竖排恢复字号按它闭环，而不是整列高 —— 整列高 = 字高×字数 + 字间距，
   * 拿它反推字号会把「字间距」算进字里，字就偏小、间距偏大。
   */
  charH?: number;
}

export interface RecoverResult {
  chars: RecognizedChar[];
  /** 整行识别结果。西文必须走这条，逐字框对字母不成立 */
  lines: RecognizedLine[];
  /** 渲染位图算出的分界，原样带回给前端（诊断日志要用） */
  bands: number[][];
  /** 本次识别用的排列方向 */
  orientation: Orientation;
  text: string;
  /** 倾斜稿摆正的逆变换，诊断日志要用；未摆正为 null */
  skew: SkewTransform | null;
  stats: {
    rows: number;
    shapes: number;
    chars: number;
    charHeight: number;
    splitBlocks: number;
    emptyCount: number;
    avgScore: number;
    durationMs: number;
    /** 长文（>=8 行）跳过逐字 OCR，逐字校对区本来也已隐藏 */
    charOcrSkipped?: boolean;
  };
  /** 标注图路径（相对项目根），给人和排查用 */
  debugImage: string | null;
}

export interface RecoverOptions {
  charWidthRatio?: number;
  mergeRatio?: number;
  /** 裁剪时四周多留的像素，避免切到笔画边缘 */
  pad?: number;
  /** 预处理后的裁剪图存到哪（排查用），空则不存 */
  dumpDir?: string;
  /** 生成标注图，默认开 */
  debug?: boolean;
  /**
   * 跳过逐字 OCR，只保留聚类出来的框位置。
   * 整行识别才是主通道，逐字校对区已隐藏；长稿（实测 344 个框、
   * 54.7 秒）里逐字识别几乎全耗在无用功上。位置真值仍保留，
   * 逐字兜底恢复在极端情况下仍可用（只是文字为空，需用户粘贴）。
   */
  skipCharOcr?: boolean;
  /** 竖排时按列分带、整列旋转识别、坐标转置聚类 */
  orientation?: Orientation;
}

/**
 * 只允许读两个地方的图片：
 *   1. %LOCALAPPDATA%\FontDeck\recover —— AI 侧 fdRecoverScan 导出的临时图
 *   2. <项目>/data —— 测试与调试用
 *
 * 这个接口的入参里有文件路径，不设限等于给了一个任意文件读取的口子
 * （虽然只跑在本机 127.0.0.1，但没必要留这种洞）。
 */
export function isSafeRecoverPath(p: string): boolean {
  const resolved = path.resolve(p).toLowerCase();
  const allowed = [
    path.resolve(
      process.env.LOCALAPPDATA ?? "C:\\Users\\6\\AppData\\Local",
      "FontDeck",
      "recover"
    ),
    path.resolve(process.cwd(), "data"),
  ].map((x) => x.toLowerCase());

  return allowed.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep)
  );
}

/**
 * 生成标注图：原图 + 每个识别单元的框 + 编号。
 *
 * 框画成半透明填充而不是纯描边，因为转曲文字笔画细，纯描边会和字形混在一起看不清。
 * 识别失败的框用红色，成功的用蓝色。
 */
function renderDebug(
  pngPath: string,
  chars: RecognizedChar[],
  outPath: string
): boolean {
  try {
    const raw = fs.readFileSync(pngPath).toString("base64");
    const dims = chars.reduce(
      (acc, c) => ({
        w: Math.max(acc.w, c.box.r),
        h: Math.max(acc.h, c.box.b),
      }),
      { w: 0, h: 0 }
    );
    const W = Math.max(dims.w + 8, 32);
    const H = Math.max(dims.h + 8, 32);

    const rects = chars
      .map((c) => {
        const ok = !!c.ch && !c.error;
        const color = ok ? "#4f46e5" : "#e11d48";
        const x = c.box.l;
        const y = c.box.t;
        const w = Math.max(1, c.box.r - c.box.l);
        const h = Math.max(1, c.box.b - c.box.t);
        return (
          `<rect x="${x}" y="${y}" width="${w}" height="${h}" ` +
          `fill="${color}" fill-opacity="0.13" stroke="${color}" stroke-width="1.5"/>`
        );
      })
      .join("");

    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" ` +
      `viewBox="0 0 ${W} ${H}">` +
      `<image href="data:image/png;base64,${raw}" x="0" y="0" width="${W}" height="${H}"/>` +
      rects +
      `</svg>`;

    const png = new Resvg(svg, { fitTo: { mode: "original" } }).render().asPng();
    fs.writeFileSync(outPath, png);
    return true;
  } catch {
    return false;
  }
}

/** 把聚类出来的字框按 y 合并成「行框」，供整行识别取图 */
function groupLineBoxes(chars: Box[], tol: number, vertical: boolean): Box[] {
  if (vertical) {
    /* 竖排：按 x 中心分列，列间从右到左 */
    const sorted = [...chars].sort((a, b) => b.l - a.l);
    const cols: Box[] = [];
    for (const b of sorted) {
      const cx = (b.l + b.r) / 2;
      let target: Box | null = null;
      for (const c of cols) {
        if (Math.abs((c.l + c.r) / 2 - cx) <= tol) { target = c; break; }
      }
      if (target) {
        target.l = Math.min(target.l, b.l);
        target.t = Math.min(target.t, b.t);
        target.r = Math.max(target.r, b.r);
        target.b = Math.max(target.b, b.b);
      } else {
        cols.push({ ...b });
      }
    }
    return cols.sort((a, b) => b.l - a.l);
  }
  const sorted = [...chars].sort((a, b) => a.t - b.t);
  const rows: Box[] = [];
  for (const b of sorted) {
    const cy = (b.t + b.b) / 2;
    let target: Box | null = null;
    for (const r of rows) {
      if (Math.abs((r.t + r.b) / 2 - cy) <= tol) {
        target = r;
        break;
      }
    }
    if (target) {
      target.l = Math.min(target.l, b.l);
      target.t = Math.min(target.t, b.t);
      target.r = Math.max(target.r, b.r);
      target.b = Math.max(target.b, b.b);
    } else {
      rows.push({ ...b });
    }
  }
  return rows.sort((a, b) => a.t - b.t);
}

/**
 * 行带内「真实墨迹」的紧包围框。
 *
 * lineBoxes 是给整行识别器用的：横向必须铺满整幅画布，左右白边能让
 * 识别器正常断句。但它绝不能当作这一行的几何真值 —— 居中、缩进或短行
 * 时，全宽框比实际文字宽一大截（实测第二行 995px 的框里只有 525px 有字）。
 * 恢复时拿它做字号闭环，字号就被按比例放大，用户看到的就是「字号不对」。
 */
function inkBoxInBand(band: Box, shapes: Box[], vertical: boolean): Box {
  const inside = shapes.filter((s) => {
    if (vertical) {
      const ox = Math.min(s.r, band.r) - Math.max(s.l, band.l);
      return ox > 0 && ox / Math.max(1, s.r - s.l) > 0.5;
    }
    const overlap = Math.min(s.b, band.b) - Math.max(s.t, band.t);
    return overlap > 0 && overlap / Math.max(1, s.b - s.t) > 0.5;
  });
  if (inside.length === 0) return band;

  let l = Infinity;
  let t = Infinity;
  let r = -Infinity;
  let b = -Infinity;
  for (const s of inside) {
    l = Math.min(l, s.l);
    t = Math.min(t, s.t);
    r = Math.max(r, s.r);
    b = Math.max(b, s.b);
  }
  return {
    l: vertical ? Math.max(band.l, l) : Math.max(0, l),
    t: vertical ? Math.max(0, t) : Math.max(band.t, t),
    r: vertical ? Math.min(band.r, r) : Math.min(band.r, r),
    b: vertical ? Math.min(band.b, b) : Math.min(band.b, b),
  };
}

/**
 * 去掉整行识别在左侧空白上幻觉出来的省略号。
 *
 * 实测：第一行左侧 185px 全白，OCR 却给出 "...When using…"。多出来的
 * 三个点会被拿去渲染每个候选字体，整行形状因此整体错位，余弦分数从
 * 0.95 塌到 0.83，而且所有字体挤成一团失去区分度（Baloo 2 排第一）。
 *
 * 判据同时看文本和几何：只有「行首连续点 + 该行墨迹明显靠右」才删，
 * 避免误伤真的以省略号开头、且墨迹本来就靠左的句子。
 */
function trimHallucinatedDots(
  text: string, ink: Box, canvasW: number, vertical: boolean, canvasH: number
): string {
  const m = /^\s*[.．…]{2,}\s*/.exec(text);
  if (!m) return text;
  /* 竖排整列逆时针旋转后，原图的「列顶空白」变成旋转图的「行左空白」，
     同样会诱发幻觉点，判据换成墨迹顶到画布顶的距离。 */
  const lead = vertical ? ink.t : ink.l;
  const span = vertical ? canvasH : canvasW;
  if (span > 0 && lead > span * 0.05) return text.slice(m[0].length);
  return text;
}

/**
 * 竖排整列文本的逐字兜底校正。
 *
 * 中文竖排的单个字是端正的，但整列图送进横排 OCR 前必须旋转 90°，
 * 一转字就躺倒，RapidOCR 对躺倒字会认成形近字（实测「滚滚长江东逝水」
 * 整列被读成「濠濠长江东逝水」，前两字全错），而同一批字的逐字框是
 * 端正原图切出来的，逐字 OCR 全对。字体比对拿错的整列文本去渲染，
 * 余弦从 0.84 塌到 0.50，于是「文字认错 + 字体不对 + 字号自检报警」
 * 一起爆出来，其实根因只有整列 OCR 这一处。
 *
 * 只在窄条件下生效：每个聚类单元都认出一个单汉字、字数与单元数一致。
 * 横排绝不能这么做 —— 西文字母按字宽切框不成立，逐字对西文只会得到
 * 乱码，那边整行通道才是主通道。识别文本是原地改的（lines 引用）。
 */
export function correctVerticalLineText(
  chars: RecognizedChar[],
  lines: RecognizedLine[]
): void {
  if (chars.length === 0) return;
  const allHan = chars.every((c) => /^[\u3400-\u9fff]$/.test(c.ch ?? ""));
  if (!allHan) return;
  const charText = chars.map((c) => c.ch).join("");
  if (charText.length !== chars.length) return;
  const avg = chars.reduce((s, c) => s + (c.score || 0), 0) / chars.length;
  for (const line of lines) {
    if (charText !== line.text) {
      line.text = charText;
      /* 整列置信度是躺倒 OCR 给的，不可信；逐字全中时用逐字平均分兜底，
         避免面板弹出「置信度低、可能有错字」的误导提示。 */
      line.score = Math.max(line.score ?? 0, avg);
    }
  }
}

export async function recognizeScan(
  scan: ScanPayload,
  options: RecoverOptions = {}
): Promise<RecoverResult> {
  const t0 = Date.now();

  if (!fs.existsSync(scan.png)) {
    throw new Error(`扫描图不存在：${scan.png}`);
  }
  if (!isSafeRecoverPath(scan.png)) {
    throw new Error("拒绝读取工作目录之外的图片");
  }

  const orientation: Orientation = options.orientation ?? scan.orientation ?? "h";
  const vertical = orientation === "v";
  const W = scan.pngW;

  const shapes: Box[] = (scan.shapes ?? [])
    .map(([l, t, r, b]) => ({ l, t, r, b }))
    .filter((b) => b.r > b.l && b.b > b.t);

  const bands: number[][] = Array.isArray(scan.bands)
    ? scan.bands.filter((x) => Array.isArray(x) && x.length === 2)
    : [];

  /*
   * 竖排用「坐标旋转」复用横排聚类，不复制第二套算法。
   *
   * 逆时针 90°：(x, y) → (y, W - x)。旋转后：
   *   原图从右到左的列 → 旋转图从上到下的行（中文竖排阅读顺序）
   *   原图列内从上到下 → 旋转图行内从左到右
   * 于是 clusterShapes 那套「按 y 分带、行内按 x 贪心合并」原封不动就能用。
   * 这和 worker 里整列逆时针旋转 90° 再送 OCR 是同一个变换，方向一致。
   *
   * 只在这里做，输出（chars / lines / doc / 标注图）全部换回原图坐标，
   * 所以 boxToDocPoint、skew 逆变换、AI 侧位置逻辑都不用动。
   */
  const rot = (b: Box): Box => ({ l: b.t, t: W - b.r, r: b.b, b: W - b.l });
  const unrot = (b: Box): Box => ({ l: W - b.b, t: b.l, r: W - b.t, b: b.r });

  const clusterInput = vertical ? shapes.map(rot) : shapes;
  const clusterBands = vertical
    ? bands.map(([l, r]) => [W - r, W - l])
    : bands;

  const clusteredRaw = clusterShapes(clusterInput, {
    charWidthRatio: options.charWidthRatio,
    mergeRatio: options.mergeRatio,
    rowBands: clusterBands,
  });
  const clustered = vertical
    ? { ...clusteredRaw, chars: clusteredRaw.chars.map(unrot) }
    : clusteredRaw;

  const engine = getOcrEngine();
  const ocrBoxes = clustered.chars.map(
    (c) => [c.l, c.t, c.r, c.b] as [number, number, number, number]
  );

  const skipCharOcr = options.skipCharOcr === true;
  const results: any[] = skipCharOcr
    ? clustered.chars.map(() => ({ text: "", score: 0 }))
    : await engine.recognizeCrops(scan.png, ocrBoxes, options.pad ?? 3, options.dumpDir ?? "");

  /* 整行识别的取图框：优先用位图算出的行带（整行全宽），
     没有 bands 时（例如旧数据 / 单独调 recognize 接口）才退回按字框合并 */
  const lineBoxes: Box[] =
    bands.length > 0
      ? vertical
        /* 整列全高：左右留白让逆时针旋转后的识别器正常断句 */
        ? bands.map(([l, r]) => ({ l, t: 0, r, b: scan.pngH }))
        : bands.map(([t, b]) => ({ l: 0, t, r: scan.pngW, b }))
      : groupLineBoxes(
          clustered.chars,
          Math.max(4, clustered.stats.charHeight * 0.5),
          vertical
        );
  const lineResults = await engine.recognizeLines(
    scan.png,
    lineBoxes.map((b) => [b.l, b.t, b.r, b.b] as [number, number, number, number]),
    3,
    vertical
  );

  /* 恢复 / 字体比对用真实墨迹框；没有 bands 时 lineBoxes 本身已是墨迹并集 */
  const inkBoxes: Box[] =
    bands.length > 0
      ? lineBoxes.map((b) => inkBoxInBand(b, shapes, vertical))
      : lineBoxes;

  /*
   * 摆正后的位图、轮廓框、行带都在「摆正坐标系」里（OCR / 字体比对直接用），
   * 但恢复文字要落回 Illustrator 的原始文档坐标。所以只有 doc 这一步做逆变换，
   * 且 y 翻转基准要用原始画布高度 h0（originY 对应的是原始画布）。
   */
  const hForDoc = scan.skew ? scan.skew.h0 : scan.pngH;
  const toDoc = (b: Box) =>
    boxToDocPoint(
      scan.skew ? unrotateBox(b, scan.skew) : b,
      scan.scale,
      scan.originX,
      scan.originY,
      hForDoc
    );

  /*
   * 单字墨迹高（文档 pt）中位数：聚类的单字框已 unrot 回原图坐标，
   * 经 toDoc 换算即真实字高。竖排恢复字号用它闭环，避免把字间距算进字号。
   */
  const charHeights = clustered.chars
    .map((b) => toDoc(b).h)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const medianCharH = charHeights.length
    ? charHeights[Math.floor(charHeights.length / 2)]
    : 0;

  const lines: RecognizedLine[] = lineBoxes.map((_box, i) => {
    const ink = inkBoxes[i] ?? _box;
    const r = lineResults[i] ?? { text: "", score: 0 };
    return {
      text: trimHallucinatedDots(
        String(r.text ?? ""), ink, scan.pngW, vertical, scan.pngH
      ),
      score: r.score ?? 0,
      charH: Math.round(medianCharH * 100) / 100,
      engine: (r as any).engine,
      /* 行级几何（字宽比/密度/倾角）：诊断日志和字体匹配的一致性核对要用 */
      stats: (r as any).stats,
      box: ink,
      doc: toDoc(ink),
    };
  });

  const chars: RecognizedChar[] = clustered.chars.map((box, i) => {
    const r = results[i] ?? { text: "", score: 0 };
    const doc = toDoc(box);
    return {
      ch: r.text ?? "",
      score: r.score ?? 0,
      box,
      doc,
      polarity: r.polarity,
      error: r.error,
      skipped: skipCharOcr || undefined,
    };
  });

  const emptyCount = chars.filter((c) => !c.ch && !c.skipped).length;
  const scored = chars.filter((c) => c.ch);

  if (vertical && !skipCharOcr) {
    correctVerticalLineText(chars, lines);
  }

  const avgScore = scored.length > 0
    ? scored.reduce((s, c) => s + c.score, 0) / scored.length
    : lines.length > 0
      ? lines.reduce((s, l) => s + l.score, 0) / lines.length
      : 0;

  /* 标注图落在 data/ 下，便于我或用户直接看 */
  let debugImage: string | null = null;
  if (options.debug !== false) {
    const outAbs = path.resolve("data", `recover-debug-${Date.now()}.png`);
    if (renderDebug(scan.png, chars, outAbs)) {
      debugImage = path.relative(process.cwd(), outAbs).replace(/\\/g, "/");
    }
  }

  return {
    chars,
    lines,
    bands,
    orientation,
    text: chars.some((c) => c.ch)
      ? chars.map((c) => c.ch).join("")
      : lines.map((l) => l.text).join("\n"),
    skew: scan.skew ?? null,
    stats: {
      rows: clustered.stats.rows,
      shapes: shapes.length,
      chars: chars.length,
      charHeight: clustered.stats.charHeight,
      splitBlocks: clustered.stats.splitBlocks,
      emptyCount,
      avgScore: Math.round(avgScore * 100) / 100,
      durationMs: Date.now() - t0,
      charOcrSkipped: skipCharOcr,
    },
    debugImage,
  };
}
