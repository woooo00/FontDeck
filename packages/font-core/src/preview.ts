/**
 * SVG 轮廓预览
 *
 * 为什么不用 @font-face 让浏览器加载字体：
 * 本机中文字体普遍 10-20MB（msyh.ttc 19.7MB、source han sans cn light 21MB），
 * 网格里一次性加载几百个会直接拖垮内存。改在服务端用 fontkit 把文字转成矢量轮廓，
 * 每个样本几 KB，浏览器一个字体文件都不用下载。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fontkit = require("fontkit") as any;

export interface PreviewOptions {
  text?: string;
  fontSize?: number;
  padding?: number;
  color?: string;
  background?: string;
  /** 超长文本截断宽度（px） */
  maxWidth?: number;
  /** 文本超出 maxWidth 时自动缩小字号，避免路径被画布裁掉 */
  autoFit?: boolean;
  /** 有些字体没有中文字形，用占位符代替 */
  fallbackText?: string;
}

const DEFAULTS: Required<PreviewOptions> = {
  text: "永 Aa 123",
  fontSize: 40,
  padding: 10,
  color: "#1a1a1a",
  background: "transparent",
  maxWidth: 900,
  autoFit: true,
  fallbackText: "",
};

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 把字体里没有的字符剔掉，避免出现豆腐块 */
function filterSupportedChars(font: any, text: string): string {
  let out = "";
  for (const ch of text) {
    try {
      if (ch === " " || ch === "\n" || ch === "\t") {
        out += ch;
        continue;
      }
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      if (typeof font.hasGlyphForCodePoint === "function" && !font.hasGlyphForCodePoint(cp)) {
        continue;
      }
      out += ch;
    } catch {
      out += ch;
    }
  }
  return out;
}

/**
 * 渲染单个字体的一段文字为 SVG 字符串。
 * 需要精确指定 collectionIndex（.ttc 内的第几个 face）。
 */
export function renderTextSvg(
  filePath: string,
  collectionIndex: number,
  options: PreviewOptions = {}
): string | null {
  /*
   * 不能用 {...DEFAULTS, ...options} 直接合并：调用方显式传 text: undefined 时，
   * 展开会把这个 undefined 覆盖到默认值上（展开只看键在不在，不看值是什么），
   * 结果 text 变成 undefined，后面 filterSupportedChars 遍历 undefined 抛错，
   * 整张预览变成 404。这里把 undefined 的键剔掉再合并。
   */
  const defined = Object.fromEntries(
    Object.entries(options).filter(([, v]) => v !== undefined)
  ) as PreviewOptions;
  const opts = { ...DEFAULTS, ...defined };

  let opened: any;
  try {
    opened = fontkit.openSync(filePath);
  } catch {
    return null;
  }

  let font: any;
  try {
    const isCollection = Array.isArray(opened?.fonts);
    if (isCollection) {
      font = opened.fonts[collectionIndex] ?? opened.fonts[0];
    } else {
      font = opened;
    }
    if (!font) return null;

    const upm: number = font.unitsPerEm || 1000;

    let text = filterSupportedChars(font, opts.text);
    if (!text.trim()) {
      if (!opts.fallbackText) return null;
      text = filterSupportedChars(font, opts.fallbackText);
      if (!text.trim()) return null;
    }

    const run = font.layout(text);
    const rawAdvance = run.advanceWidth ?? 0;

    // 宽度超限时按比例缩字号。不这么做的话，路径会画到 viewBox 外面被裁掉，
    // 看起来像"字体名显示不全"，其实是画布不够宽。
    let scale = opts.fontSize / upm;
    if (opts.autoFit && rawAdvance > 0 && rawAdvance * scale > opts.maxWidth) {
      scale = opts.maxWidth / rawAdvance;
    }
    const advance = rawAdvance * scale;

    let x = 0;
    const pieces: string[] = [];
    for (let i = 0; i < run.glyphs.length; i++) {
      const glyph = run.glyphs[i];
      const pos = run.positions[i] ?? { xAdvance: 0, xOffset: 0, yOffset: 0 };
      // 注意：这里必须保持在「字体单位」空间，外层 <g> 才做 scale。
      // 之前在这里乘了 scale，导致坐标被缩两次、字形全挤在一起。
      const gx = x + (pos.xOffset ?? 0);
      const gy = -(pos.yOffset ?? 0);
      x += pos.xAdvance ?? 0;

      let d = "";
      try {
        d = glyph.path?.toSVG?.() ?? "";
      } catch {
        d = "";
      }
      if (!d) continue;
      pieces.push(
        `<path d="${d}" transform="translate(${gx.toFixed(1)} ${gy.toFixed(1)})"/>`
      );
    }

    if (pieces.length === 0) return null;

    const width = Math.ceil(advance + opts.padding * 2);
    const ascent = (font.ascent ?? upm * 0.8) * scale;
    const descent = Math.abs(font.descent ?? upm * 0.2) * scale;
    const height = Math.ceil(ascent + descent + opts.padding * 2);
    const baseline = Math.ceil(ascent + opts.padding);

    const bg =
      opts.background && opts.background !== "transparent"
        ? `<rect width="100%" height="100%" fill="${escapeXml(opts.background)}"/>`
        : "";

    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`,
      ` viewBox="0 0 ${width} ${height}" role="img">`,
      bg,
      `<g transform="translate(${opts.padding} ${baseline}) scale(${scale.toFixed(5)} ${(-scale).toFixed(5)})"`,
      ` fill="${escapeXml(opts.color)}">`,
      pieces.join(""),
      `</g></svg>`,
    ].join("");
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
/* 简易 LRU 缓存                                                       */
/* ------------------------------------------------------------------ */

const cache = new Map<string, string>();
const MAX_CACHE = 500;

export function renderCached(
  filePath: string,
  collectionIndex: number,
  options: PreviewOptions = {}
): string | null {
  const key = `${filePath.toLowerCase()}#${collectionIndex}#${options.text ?? DEFAULTS.text}#${options.fontSize ?? DEFAULTS.fontSize}#${options.color ?? DEFAULTS.color}`;
  const hit = cache.get(key);
  if (hit) {
    // 刷新 LRU 顺序
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const svg = renderTextSvg(filePath, collectionIndex, options);
  if (svg) {
    cache.set(key, svg);
    if (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  return svg;
}

export function clearPreviewCache(): void {
  cache.clear();
}
