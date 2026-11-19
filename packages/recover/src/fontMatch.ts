/**
 * 从转曲字形反推原稿用的是哪款字体。
 *
 * 思路和「相似度推荐」共用一套向量，但方向相反：
 *   相似度：已知字体 A，找本机最像它的其他字体（比的是**渲染结果**）
 *   字体匹配：已知一个字形（转曲后的像素），找本机哪个字体渲染出来最像它
 *
 * 为什么只比 2-3 个代表字而不是全部：
 * 打开一个中文字体要 20-40ms（文件十几 MB），本机 100 个中文字体全比一轮是 3-4 秒。
 * 每个字都单独跑一轮没有意义 —— 同一段文字的字体是同一个，
 * 所以取 2-3 个墨迹最饱满的字（笔画多的字区分度最高）投票就够。
 *
 * 已知限制：相似度判断不了「同一款字体的不同字重」（实测间隔只有 0.014），
 * 所以匹配结果会落在正确家族上，但可能选错字重。这在 UI 上是可接受的，
 * 用户能从候选列表里改。
 */
import fs from "node:fs";
import { createRequire } from "node:module";

import { glyphMask, densityVector, cosine } from "../../font-core/src/similarity.js";
import { getOcrEngine } from "../../ocr/src/client.js";
import type { FontFace, FontIndex } from "../../font-core/src/types.js";

const require = createRequire(import.meta.url);
const fontkit = require("fontkit") as any;

export interface MatchCandidate {
  faceId: string;
  postScriptName: string;
  family: string;
  familyZh?: string;
  subfamily: string;
  /** 0–1，越高越像 */
  score: number;
}

/**
 * 按 PostScript 名去重：同一款字体装两份（本机用户目录 + 系统目录）时，
 * 只留 canonical 那份（索引阶段用 duplicateOf 标好了副本）。
 */
function dedupeByPostScriptName(faces: FontFace[]): FontFace[] {
  const seen = new Map<string, FontFace>();
  const out: FontFace[] = [];
  for (const f of faces) {
    const key = (f.postScriptName ?? "").trim().toLowerCase();
    if (!key) {
      out.push(f);
      continue;
    }
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, f);
      out.push(f);
    } else if (!f.duplicateOf && prev.duplicateOf) {
      const at = out.indexOf(prev);
      if (at >= 0) out[at] = f;
      seen.set(key, f);
    }
  }
  return out;
}

export interface MatchResult {
  /** 综合候选，已按分数降序 */
  candidates: MatchCandidate[];
  /** 参与投票的字 */
  samples: string[];
}

export interface MatchOptions {
  /** 返回前几个候选 */
  limit?: number;
  /** 最多用几个样本字投票 */
  maxSamples?: number;
  /** 只在这些 face 里找（默认全部） */
  candidateIds?: string[];
}

/** base64 → 归一化到 0–1 的密度向量 */
function decodeVector(b64: string): Float32Array | null {
  try {
    const buf = Buffer.from(b64, "base64");
    if (buf.length !== 256) return null;
    const out = new Float32Array(256);
    for (let i = 0; i < 256; i++) out[i] = buf[i] / 255;
    return out;
  } catch {
    return null;
  }
}

/** 取字体里某个字的密度向量；没有这个字形返回 null */
function faceVector(font: any, ch: string): Float32Array | null {
  try {
    const m = glyphMask(font, ch);
    if (!m) return null;
    return densityVector(m);
  } catch {
    return null;
  }
}

/**
 * 挑样本字：笔画多、墨迹饱满的字区分度最高。
 * 「一」「二」这种几乎不携带字体特征，拿来比等于随机。
 *
 * 必须按字去重。之前「滚滚长江东逝水」挑出来的是「水 / 滚 / 滚」，
 * 两个「滚」等于给同一个字投了两票，实际只有 2 个独立样本 ——
 * 碰巧某个字体在这两字上像就能排第一，推荐自然不准。
 */
function pickSamples(
  chars: { ch: string; score: number; box: { l: number; t: number; r: number; b: number } }[],
  max: number
): typeof chars {
  const seen = new Set<string>();
  return [...chars]
    .filter((c) => c.ch && c.ch.length === 1 && c.score > 0)
    .sort((a, b) => {
      /* 先看墨迹面积（框面积近似），再看识别置信度 */
      const areaA = (a.box.r - a.box.l) * (a.box.b - a.box.t);
      const areaB = (b.box.r - b.box.l) * (b.box.b - b.box.t);
      if (Math.abs(areaA - areaB) > 4) return areaB - areaA;
      return b.score - a.score;
    })
    .filter((c) => {
      if (seen.has(c.ch)) return false;
      seen.add(c.ch);
      return true;
    })
    .slice(0, max);
}

export async function matchFont(
  pngPath: string,
  chars: { ch: string; score: number; box: { l: number; t: number; r: number; b: number } }[],
  index: FontIndex,
  options: MatchOptions = {}
): Promise<MatchResult> {
  const limit = options.limit ?? 6;
  /* 5 个不重复的字。字体文件只需打开一次，多算几次余弦几乎不花时间 */
  const maxSamples = options.maxSamples ?? 5;

  const samples = pickSamples(chars, maxSamples);
  if (samples.length === 0) return { candidates: [], samples: [] };

  /* ---------- 1. 取样本字的密度向量（Python 侧图像处理） ---------- */
  const engine = getOcrEngine();
  const boxes = samples.map(
    (c) => [c.box.l, c.box.t, c.box.r, c.box.b] as [number, number, number, number]
  );
  const encoded = await engine.vectorizeCrops(pngPath, boxes, 2);

  const sampleVectors: { ch: string; vec: Float32Array }[] = [];
  for (let i = 0; i < samples.length; i++) {
    const v = encoded[i] ? decodeVector(encoded[i]!) : null;
    if (v) sampleVectors.push({ ch: samples[i].ch, vec: v });
  }
  if (sampleVectors.length === 0) return { candidates: [], samples: [] };

  /* ---------- 2. 候选字体：含这些字的 face ---------- */
  const wantCjk = sampleVectors.some((s) => /[\u3400-\u9fff\uf900-\ufaff]/.test(s.ch));

  let pool: FontFace[] = index.faces.filter(
    (f) => f.postScriptName && f.health !== "missing-file"
  );
  if (options.candidateIds) {
    const allow = new Set(options.candidateIds);
    pool = pool.filter((f) => allow.has(f.id));
  } else {
    /* 中文样本只比含中文字形的字体，省掉一大半无用的打开操作 */
    pool = pool.filter((f) => (wantCjk ? f.hasCJK : true));
  }
  /*
   * 同一款字体装了两份（本机用户目录 + 系统目录）时按 PostScript 名去重。
   * 不去重的话，候选列表里同一款字体占两格，把真正的候选挤出去。
   * canonical 那份（不带 duplicateOf）优先保留。
   */
  pool = dedupeByPostScriptName(pool);

  /* ---------- 3. 逐 face 打分 ---------- */
  const scored: { face: FontFace; score: number }[] = [];

  for (const face of pool) {
    let opened: any;
    try {
      opened = fontkit.openSync(face.filePath);
    } catch {
      continue;
    }

    try {
      const font = Array.isArray(opened?.fonts)
        ? opened.fonts[face.collectionIndex] ?? opened.fonts[0]
        : opened;
      if (!font) continue;

      let sum = 0;
      let n = 0;
      for (const s of sampleVectors) {
        const fv = faceVector(font, s.ch);
        if (!fv) continue;
        sum += cosine(s.vec, fv);
        n++;
      }
      /* 样本字一个都没有说明这个 face 不含这些字，跳过 */
      if (n === 0) continue;

      /* 少一个字形就扣分，避免「只匹配上一半字」的字体被高估 */
      const coverage = n / sampleVectors.length;
      scored.push({ face, score: (sum / n) * coverage });
    } catch {
      /* 单个字体出问题不该中断整轮 */
    } finally {
      try {
        opened?.close?.();
      } catch {
        /* ignore */
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);

  /*
   * 返回的是一份「综合候选」，不是每个字各自的候选。
   *
   * 因为打的分本来就是所有样本字合并投票的结果 —— 同一段文字的字体必然是同一个，
   * 拆成「每个字都推荐一遍」只会让人误以为它们独立算过，实际三行数值一模一样。
   */
  return {
    candidates: scored.slice(0, limit).map((x) => ({
      faceId: x.face.id,
      postScriptName: x.face.postScriptName,
      family: x.face.family,
      familyZh: x.face.familyZh,
      subfamily: x.face.subfamily,
      score: Math.round(x.score * 1000) / 1000,
    })),
    samples: sampleVectors.map((s) => s.ch),
  };
}
