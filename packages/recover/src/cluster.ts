/**
 * 把转曲后的散碎轮廓聚成「字」。
 *
 * 为什么需要：
 * 转曲后一个字未必是一个对象。Illustrator 可能把「三」拆成三条独立横线，
 * 把「永」拆成五笔，也可能保留成一个带内孔的复合路径。形态完全不可预期。
 * 直接拿轮廓当字去识别，识别的是一些笔画，毫无意义。
 *
 * 算法（针对横排文字，实测够用）：
 *   1. 按 y 重叠分行 —— 同一行的字竖直方向必然重叠
 *   2. 行内按 x 排序，用「间隙」判连通 —— 字内笔画间隙远小于字间距
 *   3. 连通分量 = 一个字
 *   4. 宽度异常的合并块再按字宽强制切开（应对粘连）
 *
 * 为什么不直接用「等宽网格」：中文是等宽网格，但中英混排时西文字符不是一 em 宽，
 * 网格会把英文切错位。间隙法对两种情况都成立，只是粘连时需要用字宽兜底。
 */

export interface Box {
  /** 像素坐标：左、上、右、下（y 向下） */
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface ClusterResult {
  chars: Box[];
  /** 千分位统计，用于调参 */
  stats: {
    rows: number;
    shapes: number;
    /** 估出来的字高（像素） */
    charHeight: number;
    /** 被强制切开的粘连块数量 */
    splitBlocks: number;
  };
}

export interface ClusterOptions {
  /**
   * 一个字的宽度上限，相对字高。
   *
   * 为什么用「宽度上限」而不是「间隙阈值」：
   * 中文紧排时字间距只有 0.1em 左右，而「川」「三」这类字内部笔画间隙能到 0.15em ——
   * 字间间隙比字内间隙还小，用间隙做判据在原理上就分不开。
   * 但中文是等宽网格，一个字宽约等于字高，用「加上下一块会不会超过一个字宽」来分组就成立：
   *   三竖加起来 0.9 字高 → 是一个字（川）
   *   两个整字加起来 1.8 字高 → 超了，切开
   * 1.15 这个值是在实测数据上调的：留出 15% 余量给墨迹比 em 略宽的字（如「国」「圖」）。
   */
  charWidthRatio?: number;
  /** 单块宽度超过字高的多少倍就认为粘连，需要强行等分 */
  mergeRatio?: number;
  /**
   * 由渲染位图的 y 投影算出的行带 [t, b][]（像素坐标）。
   * 给了就按它强制分行，不再用 y 重叠猜 —— 后者在行距紧时会链式合并，
   * 把三行英文并成一行，切出贯穿上下的竖条框。
   */
  rowBands?: number[][];
}

const DEFAULTS: Required<ClusterOptions> = {
  charWidthRatio: 1.15,
  mergeRatio: 1.65,
  rowBands: [],
};

function w(b: Box): number {
  return b.r - b.l;
}
function h(b: Box): number {
  return b.b - b.t;
}
function cy(b: Box): number {
  return (b.t + b.b) / 2;
}
function cx(b: Box): number {
  return (b.l + b.r) / 2;
}

function merge(a: Box, b: Box): Box {
  return {
    l: Math.min(a.l, b.l),
    t: Math.min(a.t, b.t),
    r: Math.max(a.r, b.r),
    b: Math.max(a.b, b.b),
  };
}

/**
 * 估字高。
 *
 * 不能用最大值：一条撑满行高的竖线会把它拉高。
 * 也不能用中位数：小标点、笔画短的部件会把中位数拉低。
 * 取 80 分位，让它落在「完整汉字」的高度附近。
 */
function estimateCharHeight(boxes: Box[]): number {
  const hs = boxes.map(h).filter((v) => v > 0).sort((a, b) => a - b);
  if (hs.length === 0) return 0;
  const idx = Math.min(hs.length - 1, Math.floor(hs.length * 0.8));
  return hs[idx];
}

/**
 * 按 y 重叠分行。
 *
 * 容差是必要的：一个字被拆成上下两半时（「三」的三横、「王」的笔画被释放复合路径），
 * 两半的 y 范围可能刚好相接、甚至留一条细缝。要求严格重叠就会把一个字拆成两行，
 * 然后每半被当成一个字，全盘皆错。
 *
 * 但容差不能太大：行间距通常只有 0.2–0.5 行高，容差过大会把相邻两行并成一行。
 * 0.15 这个值在「容忍笔画缝隙」和「不粘连行」之间取的。
 */
function groupRows(boxes: Box[], tolerance: number): Box[][] {
  const sorted = [...boxes].sort((a, b) => a.t - b.t);
  const rows: Box[][] = [];
  const rowBox: Box[] = [];

  for (const b of sorted) {
    let placed = false;
    for (let i = 0; i < rows.length; i++) {
      const rb = rowBox[i];
      const overlap = Math.min(rb.b, b.b) - Math.max(rb.t, b.t);
      const minH = Math.min(h(rb), h(b));
      // 明显重叠 → 同行
      if (minH > 0 && overlap / minH > 0.4) {
        rows[i].push(b);
        rowBox[i] = merge(rb, b);
        placed = true;
        break;
      }
      // 小缝隙（含刚好相接 overlap=0）→ 也当同行，容忍笔画被拆开
      if (overlap >= -tolerance) {
        rows[i].push(b);
        rowBox[i] = merge(rb, b);
        placed = true;
        break;
      }
    }
    if (!placed) {
      rows.push([b]);
      rowBox.push({ ...b });
    }
  }

  return rows;
}

/** 按位图算出的行带把框分到各行 */
function assignRows(boxes: Box[], bands: number[][]): Box[][] {
  const rows: Box[][] = bands.map(() => []);
  for (const b of boxes) {
    const cy = (b.t + b.b) / 2;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < bands.length; i++) {
      const [t, bt] = bands[i];
      const d = cy < t ? t - cy : cy > bt ? cy - bt : 0;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    rows[best].push(b);
  }
  /* 不滤空行：stats.rows 必须等于行带数，否则面板会显示「行 2」却识别出 3 行 */
  return rows;
}

/** 行内按「一个字宽」的上限贪心分组 */
function clusterRow(row: Box[], charHeight: number, maxCharWidth: number): Box[] {
  if (row.length === 0) return [];
  if (row.length === 1) return [row[0]];

  const sorted = [...row].sort((a, b) => a.l - b.l);
  const out: Box[] = [];

  let i = 0;
  while (i < sorted.length) {
    let g: Box = { ...sorted[i] };
    let j = i + 1;
    /* 只要加上下一块还不超过一个字宽，就继续并进来 */
    while (j < sorted.length && sorted[j].r - g.l <= maxCharWidth) {
      g = merge(g, sorted[j]);
      j++;
    }
    out.push(g);
    i = j;
  }
  return out;
}

/**
 * 把一个过宽的块按字宽切开。
 * 只在明显粘连（宽度 > 字高 × mergeRatio）时动，切完每块宽度取字高。
 */
function splitWide(block: Box, charHeight: number, mergeRatio: number): Box[] {
  const width = w(block);
  if (charHeight <= 0 || width <= charHeight * mergeRatio) return [block];

  const n = Math.max(2, Math.round(width / charHeight));
  const step = width / n;
  const out: Box[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      l: block.l + i * step,
      t: block.t,
      r: block.l + (i + 1) * step,
      b: block.b,
    });
  }
  return out;
}

export function clusterShapes(shapes: Box[], options: ClusterOptions = {}): ClusterResult {
  /*
   * 不能直接 {...DEFAULTS, ...options}：
   * 调用方传 { gapRatio: undefined } 时，展开会把这个 undefined 覆盖到默认值上，
   * 于是 gapRatio 变 undefined → gapThreshold = NaN → 所有间隙比较都是 false
   * → 一个字都不会合并。mergeRatio 变 undefined 更糟：
   * width <= charHeight * undefined 恒为 false，于是每个字都被当成粘连块切开。
   * 这个坑在 preview.ts 里已经踩过一次，这里显式过滤。
   */
  const defined = Object.fromEntries(
    Object.entries(options).filter(([, v]) => v !== undefined)
  ) as ClusterOptions;
  const opts = { ...DEFAULTS, ...defined };

  if (shapes.length === 0) {
    return { chars: [], stats: { rows: 0, shapes: 0, charHeight: 0, splitBlocks: 0 } };
  }

  /*
   * 字高先用单个框的高度粗估（80 分位），只用来做分行容差。
   * 真正切分用的是「行高」—— 一行的竖直并集高度才是字高。
   * 如果一个字被拆成上下两半，任何单框统计都只有半个字高，
   * 只有行高能反映真实尺寸。
   */
  const roughH = estimateCharHeight(shapes);
  const rows =
    opts.rowBands && opts.rowBands.length > 0
      ? assignRows(shapes, opts.rowBands)
      : groupRows(shapes, roughH * 0.15);

  const chars: Box[] = [];
  let splitBlocks = 0;
  let maxRowH = 0;

  for (const row of rows) {
    /* rowBands 可能给出一行没分到任何轮廓，跳过它但保留行数统计 */
    if (row.length === 0) continue;
    const rowBox = row.reduce((acc, b) => merge(acc, b));
    const rowH = Math.max(1, rowBox.b - rowBox.t);
    if (rowH > maxRowH) maxRowH = rowH;

    const maxCharWidth = rowH * opts.charWidthRatio;
    const blocks = clusterRow(row, rowH, maxCharWidth);
    for (const blk of blocks) {
      const parts = splitWide(blk, rowH, opts.mergeRatio);
      if (parts.length > 1) splitBlocks++;
      chars.push(...parts);
    }
  }

  // 阅读顺序：先上后下，同高从左到右
  chars.sort((a, b) => {
    const dy = a.t - b.t;
    if (Math.abs(dy) > maxRowH * 0.5) return dy;
    return a.l - b.l;
  });

  return {
    chars,
    stats: {
      rows: rows.length,
      shapes: shapes.length,
      charHeight: Math.round(maxRowH * 10) / 10,
      splitBlocks,
    },
  };
}

/**
 * 把像素框换算成 AI 文档坐标（左下角 + 宽高），给重建文字用。
 *
 * 两套坐标系要对齐：
 *   图片  原点在左上角，y 向下
 *   文档  原点在左下角，y 向上
 *
 * 入参：
 *   box     图片像素框
 *   scale   导出时的放大倍数
 *   originX 图片左边界对应的文档 x（导出画板的 left）
 *   originY 图片底边界对应的文档 y（导出画板的 bottom）
 *   pngH    图片像素高度，用来把「距顶边的距离」翻成「距底边的距离」
 */
export function boxToDocPoint(
  box: Box,
  scale: number,
  originX: number,
  originY: number,
  pngH: number
): { x: number; y: number; w: number; h: number } {
  return {
    x: originX + box.l / scale,
    y: originY + (pngH - box.b) / scale,
    w: (box.r - box.l) / scale,
    h: (box.b - box.t) / scale,
  };
}
