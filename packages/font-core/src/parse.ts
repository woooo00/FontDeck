/**
 * 字体解析：fontkit 封装
 *
 * 三个已实测的坑：
 * 1. fontkit 的 familyName 带字重后缀（"Alibaba PuHuiTi R"），必须用 preferredFamily 才是真家族名
 * 2. .ttc 是字体集合，一个文件多个 face，要逐个展开
 * 3. .fon 是 16 位 NE 可执行文件里的位图字体，fontkit 读不了，扫描阶段直接排除
 */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  FontCategory,
  FontFace,
  FontScope,
  VariationAxis,
} from "./types.js";

const require = createRequire(import.meta.url);
// fontkit 是 CJS，用 require 拿更稳
const fontkit = require("fontkit") as any;

const CJK_PROBE = 0x4e2d; // 中
const LATIN_PROBE = 0x41; // A

const SUPPORTED_EXT = new Set([".ttf", ".otf", ".ttc", ".otc", ".woff", ".woff2"]);
const IGNORED_EXT = new Set([
  ".fon", // 位图字体（NE 可执行文件），不可解析
  ".compositefont", // 实为 WPF 回退配置 XAML，根本不是字体
  ".dat", // DirectWrite 缓存
  ".rar",
  ".zip",
  ".ini",
  ".txt",
  ".xml",
  ".exe",
  ".db",
]);

export function isSupportedFontFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return SUPPORTED_EXT.has(ext);
}

export function isIgnoredFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  return IGNORED_EXT.has(ext);
}

/* ------------------------------------------------------------------ */
/* 分类                                                                */
/* ------------------------------------------------------------------ */

function pickLang(
  records: Record<string, string> | undefined,
  lang: string
): string | undefined {
  if (!records) return undefined;
  const v = records[lang];
  return v && v.trim() ? v.trim() : undefined;
}

function classifyCategory(font: any): FontCategory {
  // 顺序很重要：字体名关键词优先。
  // sFamilyClass 很多字体乱填或为 0（Malgun Gothic 就被填成了 script），
  // 名称命中的可信度反而更高。
  const names = [
    font.postscriptName,
    font.familyName,
    font.fullName,
    font.name?.records?.fontFamily?.en,
    font.name?.records?.fontFamily?.zh,
    font.name?.records?.preferredFamily?.en,
    font.name?.records?.preferredFamily?.zh,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/mono|code|consol|等宽|固定|monospace/.test(names)) return "monospace";
  if (/script|hand|brush|kai|楷|行书|草|手写|笔/.test(names)) return "script";
  if (/serif|mincho|明朝|宋|times|georgia|garamond|명조|바탕/.test(names)) return "serif";
  if (/sans|gothic|ゴシック|黑|哥特|雅黑|고딕|helvetica|arial|苹方|pingfang/.test(names))
    return "sans-serif";

  // 名称判不出来，再看 OS/2
  let familyClass = 0;
  try {
    const os2 = font["OS/2"];
    if (os2 && typeof os2.sFamilyClass === "number") {
      familyClass = (os2.sFamilyClass >> 8) & 0xff;
    }
  } catch {
    /* ignore */
  }

  if (familyClass >= 1 && familyClass <= 7) return "serif";
  if (familyClass === 8) return "sans-serif";
  if (familyClass === 9) return "display";
  if (familyClass === 10) return "script";
  if (familyClass === 12) return "symbol";

  // 最后用 PANOSE
  try {
    const panose = font["OS/2"]?.panose;
    if (panose) {
      const bFamily = panose.bFamilyType ?? panose[0];
      const bSerif = panose.bSerifStyle ?? panose[1];
      if (bFamily === 2 && typeof bSerif === "number") {
        if (bSerif >= 2 && bSerif <= 10) return "serif";
        if (bSerif >= 11 && bSerif <= 13) return "sans-serif";
      }
      if (bFamily === 3) return "script";
      if (bFamily === 4) return "display";
      if (bFamily === 5) return "symbol";
    }
  } catch {
    /* ignore */
  }

  return "unknown";
}

function readVariationAxes(font: any): VariationAxis[] {
  try {
    const axes = font.variationAxes;
    if (!axes || typeof axes !== "object") return [];
    return Object.keys(axes).map((tag) => {
      const a = axes[tag];
      return {
        tag,
        name: a?.name ?? tag,
        min: a?.min ?? 0,
        default: a?.default ?? 0,
        max: a?.max ?? 0,
      };
    });
  } catch {
    return [];
  }
}

function faceFingerprint(filePath: string, collectionIndex: number, size: number, mtimeMs: number): string {
  // 用「路径 + 索引 + 大小 + 修改时间」做指纹，避免读全文件
  const h = createHash("sha1");
  h.update(`${filePath.toLowerCase()}|${collectionIndex}|${size}|${Math.floor(mtimeMs)}`);
  return h.digest("hex").slice(0, 16);
}

export function makeFaceId(filePath: string, collectionIndex: number): string {
  const h = createHash("sha1");
  h.update(`${filePath.toLowerCase()}|${collectionIndex}`);
  return h.digest("hex").slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* 单个 face 解析                                                       */
/* ------------------------------------------------------------------ */

function buildFace(
  font: any,
  filePath: string,
  collectionIndex: number,
  stat: fs.Stats,
  scope: FontScope
): FontFace {
  const records = font.name?.records ?? {};

  const preferredFamily = records.preferredFamily as Record<string, string> | undefined;
  const plainFamily = records.fontFamily as Record<string, string> | undefined;
  const preferredSub = records.preferredSubfamily as Record<string, string> | undefined;
  const plainSub = records.fontSubfamily as Record<string, string> | undefined;

  // 关键：优先 preferredFamily，否则一个家族会被按字重拆成几十个
  const family =
    pickLang(preferredFamily, "en") ??
    pickLang(plainFamily, "en") ??
    font.familyName ??
    font.postscriptName ??
    "Unknown";

  // familyZh 实际是「本地语言名」：优先中文，其次日文、韩文。
  // 日文字体（Kozuka、Hiragino）没有中文名，但日文名对用户比英文名好认得多。
  const familyZh =
    pickLang(preferredFamily, "zh") ??
    pickLang(plainFamily, "zh") ??
    pickLang(preferredFamily, "ja") ??
    pickLang(plainFamily, "ja") ??
    pickLang(preferredFamily, "ko") ??
    pickLang(plainFamily, "ko");

  const subfamily =
    pickLang(preferredSub, "en") ?? pickLang(plainSub, "en") ?? font.subfamilyName ?? "Regular";
  const subfamilyZh =
    pickLang(preferredSub, "zh") ??
    pickLang(plainSub, "zh") ??
    pickLang(preferredSub, "ja") ??
    pickLang(plainSub, "ja");

  let weightClass = 400;
  try {
    const w = font["OS/2"]?.usWeightClass;
    if (typeof w === "number" && w >= 1 && w <= 1000) weightClass = w;
  } catch {
    /* ignore */
  }

  let isItalic = false;
  try {
    const fsSel = font["OS/2"]?.fsSelection;
    if (typeof fsSel === "number") isItalic = (fsSel & 0x01) !== 0;
    if (!isItalic) {
      const mac = font.head?.macStyle;
      if (typeof mac === "number") isItalic = (mac & 0x02) !== 0;
    }
  } catch {
    /* ignore */
  }

  let isFixedPitch = false;
  try {
    const v = font.post?.isFixedPitch;
    isFixedPitch = !!(v && v !== 0);
  } catch {
    /* ignore */
  }

  let hasCJK = false;
  let hasLatin = false;
  try {
    if (typeof font.hasGlyphForCodePoint === "function") {
      hasCJK = font.hasGlyphForCodePoint(CJK_PROBE);
      hasLatin = font.hasGlyphForCodePoint(LATIN_PROBE);
    }
  } catch {
    /* ignore */
  }

  let glyphCount = 0;
  try {
    glyphCount = font.numGlyphs ?? 0;
  } catch {
    /* ignore */
  }

  const isVariable = !!font.fvar;
  const ext = path.extname(filePath).toLowerCase();

  return {
    id: makeFaceId(filePath, collectionIndex),
    postScriptName: font.postscriptName ?? "",
    family,
    familyZh,
    subfamily,
    subfamilyZh,
    fullName: font.fullName ?? "",
    filePath,
    fileName: path.basename(filePath),
    collectionIndex,
    format: ext.replace(".", "") || "unknown",
    fileSize: stat.size,
    mtimeMs: stat.mtimeMs,
    weightClass,
    isItalic,
    isFixedPitch,
    hasCJK,
    hasLatin,
    glyphCount,
    isVariable,
    variationAxes: isVariable ? readVariationAxes(font) : [],
    scope,
    registered: false,
    health: "ok",
    category: classifyCategory(font),
    fingerprint: faceFingerprint(filePath, collectionIndex, stat.size, stat.mtimeMs),
  };
}

/* ------------------------------------------------------------------ */
/* 文件级解析                                                          */
/* ------------------------------------------------------------------ */

export interface ParseResult {
  faces: FontFace[];
  error?: string;
}

export function parseFontFile(filePath: string, scope: FontScope): ParseResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (e: any) {
    return { faces: [], error: `stat 失败: ${e.message}` };
  }

  let opened: any;
  try {
    opened = fontkit.openSync(filePath);
  } catch (e: any) {
    return { faces: [], error: `${e.constructor?.name ?? "Error"}: ${e.message}` };
  }

  const isCollection = Array.isArray(opened?.fonts);

  try {
    if (isCollection) {
      const faces: FontFace[] = [];
      for (let i = 0; i < opened.fonts.length; i++) {
        try {
          faces.push(buildFace(opened.fonts[i], filePath, i, stat, scope));
        } catch (e: any) {
          // 集合里某个 face 坏了，不影响其它
        }
      }
      return { faces };
    }
    return { faces: [buildFace(opened, filePath, 0, stat, scope)] };
  } finally {
    try {
      opened?.close?.();
    } catch {
      /* ignore */
    }
  }
}
