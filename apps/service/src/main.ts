/**
 * FontDeck 本地服务
 *
 * 只绑定 127.0.0.1，提供：字体索引查询、SVG 预览、静态 UI。
 * 启动时全量扫描一次（约 1.5s），之后常驻内存。
 *
 * 用法：npx tsx apps/service/src/main.ts
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanFonts } from "../../../packages/font-core/src/scan.js";
import { renderCached } from "../../../packages/font-core/src/preview.js";
import { recognizeScan, isSafeRecoverPath } from "../../../packages/recover/src/pipeline.js";
import { getOcrEngine } from "../../../packages/ocr/src/client.js";
import { matchFont } from "../../../packages/recover/src/fontMatch.js";
import { readFontRegistry } from "../../../packages/font-core/src/registry.js";
import {
  familyKeyOf,
  stripStyleTokens,
  tokenizeFamily,
} from "../../../packages/font-core/src/family.js";
import {
  installFontFile,
  listInstalled,
  readLedger,
  restoreFont,
  uninstallFont,
  userFontsDir,
} from "../../../packages/win-font/src/installer.js";
import type { FontFace, FontIndex } from "../../../packages/font-core/src/types.js";
import { getUpdateState, isBusy, isInstalledCopy, startUpdate } from "./updater.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");


/** 把用户报的问题 + 当前识别上下文压成一段可直接复制的诊断文本 */
function buildReportText(id: string, body: any): string {
  const ctx = body.context ?? {};
  const geom = ctx.geom ?? {};
  const rec = ctx.recognize ?? {};
  const st = rec.stats ?? {};
  const font = ctx.font ?? {};
  const apply = ctx.apply ?? {};
  const ui = ctx.ui ?? {};
  /* 环境：宿主版本可能只在 recover 流程里才拿到，这里统一兜一层 */
  const env = body.env ?? {};
  const host = env.host ?? {};
  const aiVersion = body.appVersion || host.appVersion || "未知";
  const L: string[] = [];
  const push = (s = "") => L.push(s);

  push(`=== FontDeck 诊断日志 ${id} ===`);
  push(`时间：${new Date().toLocaleString("zh-CN")}`);
  push(
    `AI：${aiVersion}   面板：${body.uiVersion || "未知"}   服务：${body.serviceGeneratedAt || "未知"}`
  );
  push(`问题：${(body.issues || []).join("、") || "未选择"}`);
  if (body.note) push(`备注：${body.note}`);

  push("");
  push("--- 几何 / 输入 ---");
  push(
    `画布 ${geom.w ?? "?"}×${geom.h ?? "?"}，轮廓 ${geom.shapeCount ?? "?"} 条，scale ${geom.scale ?? "?"}，origin (${geom.originX ?? "?"}, ${geom.originY ?? "?"})`
  );
  push(`选区内真实文本框 ${geom.textFrames ?? "?"}，墨迹占比 ${rec.gear?.inkRatio ?? "?"}`);
  push(`行分界 bands：${JSON.stringify(rec.bands ?? geom.bands ?? [])}`);
  if (rec.skew) {
    push(
      `倾斜：检测到 ${rec.skew.angle}°，已自动摆正；下面的行墨迹框是摆正后坐标系，恢复位置已逆变换回原稿`
    );
  }
  push(`渲染图：${rec.png || "无"}`);
  push(`标注图：${rec.debugImage || "无"}`);

  push("");
  push("--- 识别 ---");
  push(
    `聚类 ${st.rows ?? "?"} 行 / ${st.chars ?? "?"} 单元 / 字高 ${st.charHeight ?? "?"} / 强制切开 ${st.splitBlocks ?? "?"} 块 / 空白 ${st.emptyCount ?? "?"}`
  );
  push(`耗时 ${st.durationMs ?? rec.gear?.totalMs ?? "?"}ms`);
  /*
   * 倒转自检：整块文字旋转 180° 会让 OCR、字体、字号、位置同时崩，
   * 用户会一次报五个问题。日志里必须显式留痕，否则下次又当成五个
   * 独立 bug 逐个排查。翻正读到的原文也留一份，方便直接回填。
   */
  if (rec.likelyFlipped180) {
    push(
      `  ⚠ 疑似整块旋转 180°：原图 OCR 平均 ${rec.ocrAvg ?? "?"} / 翻正 ${rec.flipAvg ?? "?"}`
    );
    if (rec.flipText) push(`  翻正后原文：${JSON.stringify(rec.flipText)}`);
  }
  if (st.charOcrSkipped) push("  逐字 OCR：长文已跳过（提速），位置框仍保留");
  const usedEngines = Array.from(
    new Set(
      (Array.isArray(rec.lines) ? rec.lines : [])
        .map((l: any) => l && l.engine)
        .filter(Boolean)
    )
  );
  if (usedEngines.length) push(`  识别引擎：${usedEngines.join(", ")}`);
  const ls = Array.isArray(rec.lines) ? rec.lines : [];
  if (ls.length) {
    ls.forEach((l: any, i: number) =>
      push(`  行${i + 1} [${Number(l.score || 0).toFixed(3)}] ${JSON.stringify(l.text ?? "")}`)
    );
    /* 行墨迹框是字号闭环的真值，宽度取错会直接把字号放大，日志里留一份 */
    push(
      `  行墨迹框 [l,t,r,b] px：${JSON.stringify(
        ls.map((l: any) => (l.box ? [l.box.l, l.box.t, l.box.r, l.box.b] : null))
      )}`
    );
    /* 行级几何：字宽比 / 密度 / 倾角 —— 「字体不对」类问题先看这三项 */
    const withStats = ls.filter((l: any) => l && l.stats);
    if (withStats.length) {
      push(
        `  行级几何（字宽比/密度/倾角）：` +
          withStats
            .map(
              (l: any) =>
                ` ${Number(l.stats.width || 0).toFixed(2)}/${Number(
                  l.stats.density || 0
                ).toFixed(2)}/${Number(l.stats.angle || 0).toFixed(2)}°`
            )
            .join(" |")
      );
    }
  } else {
    push("  整行识别：无结果");
  }
  const cs = Array.isArray(rec.chars) ? rec.chars : [];
  if (cs.length) {
    push(
      `  逐字（前 ${Math.min(cs.length, 24)}）：` +
        cs
          .slice(0, 24)
          .map((c: any) => `${c.ch || "□"}${Number(c.score || 0).toFixed(2)}`)
          .join(" ")
    );
  }

  push("");
  push("--- 字体 ---");
  if (Array.isArray(font.candidates) && font.candidates.length) {
    push(`模式 ${font.mode || "?"}，耗时 ${font.durationMs ?? "?"}ms`);
    /*
     * 字体比对用的文本必须留一份：整行比对是拿这句话去渲染每个候选的，
     * OCR 错一个字母就会把排名带歪。用户粘了原文重跑后，这里会变成原文，
     * 一眼能分清「推荐是基于识别结果」还是「基于用户原文」。
     */
    if (font.lines?.length) {
      push(
        `  比对文本：${font.lines
          .map((l: any) => JSON.stringify(String(l.text ?? "")))
          .join(" / ")}`
      );
    }
    /*
     * 最高分低于 0.6 时，整行比对根本没找到像的字体（正常稿 0.84~0.99）。
     * 相对百分比仍会显示「100%」，很容易被当成推荐可信 —— 明说不可信。
     */
    const topScore = Number(font.candidates[0]?.score ?? 0);
    if (topScore > 0 && topScore < 0.6) {
      push(
        `  ⚠ 最高相似度仅 ${topScore.toFixed(4)}（正常稿 0.84 以上），推荐不可信；多半是识别文本或字形本身有问题`
      );
    }
    font.candidates.slice(0, 6).forEach((c: any) =>
      push(`  ${c.familyZh || c.family} ${c.subfamily || ""}  ${c.score}  ${c.rel}%`)
    );
  } else {
    push("  未执行或失败");
  }

  push("");
  push("--- 恢复 ---");
  if (apply.ok !== undefined) {
    push(
      `创建 ${apply.created} 个文本框 / ${apply.rows} 行，字体 ${apply.font || "（默认）"}`
    );
    if (apply.calib) {
      push(
        `校准：字号 ${apply.calib.size}pt，字距 ${apply.calib.tracking}，行宽 ${apply.calib.actualW} → ${apply.calib.targetW}pt`
      );
      /*
       * 宽度闭环自检：字号有「墨迹高 × 1.4」的高度上限，一旦识别出的
       * 文本比原文短很多（漏字 / 乱码），要撑到目标行宽所需的字号会被
       * 上限卡住，整行文字就缩成一团。以前这个失败是静默的，日志里
       * 只有一串看不出问题的数字；现在直接把偏差标出来。
       */
      const tw = Number(apply.calib.targetW || 0);
      const aw = Number(apply.calib.actualW || 0);
      if (tw > 0 && aw > 0) {
        const dev = ((aw - tw) / tw) * 100;
        if (Math.abs(dev) > 10) {
          push(
            `  ⚠ 宽度闭环未收敛：实际比目标${dev < 0 ? "短" : "长"} ${Math.abs(dev).toFixed(1)}%（字号被高度上限卡住，文字会明显偏小/偏挤）`
          );
        }
      }
      /*
       * 字号自检：一行里同时有升部（b/t）和降部（,）时，墨迹高约等于 1.1 倍
       * 字号，所以 size/墨迹高 正常在 0.87~1.35。字号是拿「整行宽度」闭环算的，
       * 字体选错时会被一起带偏，用户会同时报「字号不对 / 字距不对 / 位置不对」。
       * 把这个比值写出来，一眼就能分清是几何换算的问题还是字体选错连带的。
       *
       * 阈值取 0.87 而不是 0.9：实测 FD-20261117-142243 算出 0.895，只是贴着
       * 下界就被报成「已偏离」，反而误导人去查字号。
       */
      const ink = ls[0]?.doc?.h;
      if (ink > 0 && apply.calib.size > 0) {
        const ratio = apply.calib.size / ink;
        push(
          `  字号自检：墨迹高 ${Number(ink).toFixed(2)}pt，字号/墨迹高 ${ratio.toFixed(2)}` +
            `（西文正常 0.87~1.35${ratio < 0.87 || ratio > 1.35 ? "，已偏离，多半是字体选错连带" : "，正常"}）`
        );
      }
    }
    if (apply.errors?.length) push(`错误：${apply.errors.join("；")}`);
  } else {
    push("  未执行");
  }

  push("");
  push("--- 面板当前状态 ---");
  push(`整行框内容：${JSON.stringify(ui.lineText ?? "")}`);
  push(`选中字体：${ui.fontName || "（无）"}`);
  /* 手动框与下拉是两个元素，谁生效只有记录才知道 */
  if (ui.fontManual) push(`手动指定：${ui.fontManual}`);
  if (ui.requestedFont) push(`恢复请求字体：${ui.requestedFont}`);
  if (ui.autoSegment) push("行内分段：整行分数低，服务端自动拆的");
  /* 行内分段：用户拆了几段、每段认成什么，排查「一段字体不对」全靠它 */
  if (Array.isArray(ui.segments) && ui.segments.length) {
    push(`行内分段：${ui.segments.length} 段`);
    ui.segments.forEach((s: any, i: number) => {
      push(
        `  段${i + 1} ${JSON.stringify(String(s?.text ?? ""))} 字体 ${s?.font || "（未比）"}` +
          (typeof s?.score === "number" ? ` 置信度 ${s.score}` : "")
      );
    });
  }
  if (ui.lastError) push(`最近报错：${ui.lastError}`);

  push("");
  push("--- 排版整理 trace（最近一次按行拆分）---");
  /*
   * ExtendScript.dll 原生崩溃不留 JS 堆栈，AI 侧的步进日志是唯一线索。
   * 附在诊断日志里，用户贴一份文本就能看到崩在哪一步。
   */
  try {
    const tracePath = path.join(recoverDir(), "split-trace.log");
    if (fs.existsSync(tracePath)) {
      const tl = fs.readFileSync(tracePath, "utf-8").split(/\r?\n/).filter(Boolean);
      tl.slice(-25).forEach((l) => push("  " + l));
    } else {
      push("  无（本次会话没点过按行拆分）");
    }
  } catch (e: any) {
    push("  读取失败：" + String(e?.message ?? e));
  }

  push("");
  push("--- 环境 ---");
  {
    /* 宿主（Illustrator）与 CEP 是两个版本号，混在一起看会误判：
       「AI 29.6 但 CEP 10」说明面板跑在降级环境里，界面走样是预期的 */
    push(
      `Illustrator：${aiVersion}` +
        (host.appName ? ` (${host.appName})` : "") +
        (host.appLocale ? `  语言 ${host.appLocale}` : "")
    );
    push(`CEP：${env.cep || "未知"}   Chromium：${env.chrome || "未知"}`);
    push(
      `系统：${env.platform || "?"}   DPR ${env.dpr ?? "?"}   屏幕 ${env.screen || "?"}   面板 ${env.panel || "?"}`
    );
    push(
      `CPU ${env.cpu ?? "?"} 核   内存 ${env.mem ?? "?"} GB   UA：${env.ua || "?"}`
    );
    /* 服务端自己的运行环境：同一台机器上可能同时装了 Node 和便携运行时，
       出问题时需要确认服务是被哪个解释器拉起来的 */
    push(
      `服务进程：pid ${process.pid}  Node ${process.version}  ${os.platform()} ${os.release()}  ` +
        `${os.cpus().length} 核  ${Math.round(os.totalmem() / 1073741824 * 10) / 10} GB  ` +
        `已运行 ${Math.round(process.uptime())}s`
    );
  }

  push("");
  push("--- 文件 ---");
  push(`完整上下文：data/feedback/${id}.json`);
  push(`本报告：data/feedback/${id}.txt`);
  if (rec.png) push(`渲染图：${rec.png}`);
  if (rec.debugImage) push(`标注图：${rec.debugImage}`);
  return L.join("\n");
}

/**
 * 转曲恢复的临时图目录。
 * 和 AI 侧、pipeline 的路径白名单必须是同一个地方，
 * 否则 recognizeScan 会以「拒绝读取工作目录之外的图片」把请求打回。
 */
function recoverDir(): string {
  const dir = path.join(
    process.env.LOCALAPPDATA ?? "C:\\Users\\6\\AppData\\Local",
    "FontDeck",
    "recover"
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const HOST = "127.0.0.1";
const PREFERRED_PORT = Number(process.env.FONTDECK_PORT ?? 47615);

/* ------------------------------------------------------------------ */
/* 索引                                                                */
/* ------------------------------------------------------------------ */

let index: FontIndex | null = null;

/** 按家族分组的索引：一个家族一张卡，而不是一个字重一张卡 */
interface FamilyGroup {
  key: string;
  name: string;
  family: string;
  familyZh?: string;
  rep: FontFace;
  faces: FontFace[];
  hasCJK: boolean;
  category: string;
  scope: string;
  health: string;
  isVariable: boolean;
  /** faceId → 字重列表里显示的名字。同家族撞名时会自动加前缀区分 */
  labels: Map<string, string>;
}

let families: FamilyGroup[] = [];
let faceById = new Map<string, FontFace>();

/* ------------------------------------------------------------------ */
/* 相似度与重复（由 scripts/build-neighbors.ts 预生成）                  */
/* ------------------------------------------------------------------ */

interface NeighborData {
  generatedAt: string;
  stats: { similar: number; hashed: number; dupGroups: number };
  /** faceId → top-N 相似字体，已按分数降序 */
  byId: Record<string, { id: string; s: number }[]>;
  hashById: Record<string, string>;
  dupGroups: string[][];
}

let neighbors: NeighborData | null = null;
/** 文件内容重复的 face */
let dupByHash = new Set<string>();
/** faceId → 同组其它 faceId */
let dupPartnerOf = new Map<string, string[]>();
/**
 * 内容重复组里的「多余副本」。
 *
 * 同一款字体同时装在系统目录和用户目录时，字重列表会多出一倍条目，
 * 而且两行显示完全一样（都是 Regular · 400），用户没法选也不该看到。
 * 每组只留一个代表，其余的从列表里略去——详情页的「内容重复」提示里依然能点进去。
 */
let dupExtra = new Set<string>();

function loadNeighbors(): NeighborData | null {
  if (neighbors) return neighbors;
  try {
    neighbors = JSON.parse(
      fs.readFileSync(path.join(ROOT, "data", "neighbors.json"), "utf-8")
    );
  } catch {
    // 没建过索引不该让服务起不来，静默降级成「没有相似度为能」
    neighbors = null;
    return null;
  }

  for (const g of neighbors!.dupGroups) {
    for (const id of g) {
      dupByHash.add(id);
      dupPartnerOf.set(
        id,
        g.filter((x) => x !== id)
      );
    }
    /* 选代表：优先字形多的（通常是完整版而非子集），其次按组内原顺序 */
    let rep = g[0];
    let best = -1;
    for (const id of g) {
      const f = faceById.get(id);
      const score = f ? f.glyphCount : 0;
      if (score > best) {
        best = score;
        rep = id;
      }
    }
    for (const id of g) if (id !== rep) dupExtra.add(id);
  }
  return neighbors;
}

/** 代表 face 打分：能正常显示的优先 */
function repScore(f: FontFace): number {
  let s = 0;
  if (f.health === "ok") s += 100;
  if (f.health === "suspicious") s -= 50;
  if (f.health === "unregistered") s -= 20;
  if (f.registered) s += 30;
  if (!f.duplicateOf) s += 40;
  return s;
}

/**
 * 字重列表的显示名。
 *
 * 家族合并后会出现撞名，逐级处理，只在真的撞了才加料：
 *
 * 一级 —— 正常情况就是 subfamily（Regular / Bold / Italic）。
 *
 * 二级 —— Franklin Gothic Book / Heavy / Medium 三个家族的 subfamily 都叫 Regular，
 * 列出来是三行一模一样的。把家族名里被去掉的款式词补回来（Book Regular / Heavy Regular）。
 *
 * 三级 —— Arial 装了三个 ArialMT，PostScript 名、subfamily 字重全都一样，
 * 家族名里也没有款式词可补，只剩文件名能区分（Regular · arial）。
 *
 * 刻意不把字重数字拼进名字：右侧那一列已经显示字重值了，拼进来会变成
 * 「Regular · 400 · arial … 400」，重复且挤。
 */
function variantLabels(faces: FontFace[]): Map<string, string> {
  const base = (f: FontFace) => (f.subfamily || "Regular").trim();
  const counts = new Map<string, number>();
  for (const f of faces) counts.set(base(f), (counts.get(base(f)) ?? 0) + 1);

  const out = new Map<string, string>();

  /* 一级 + 二级 */
  for (const f of faces) {
    const b = base(f);
    if ((counts.get(b) ?? 0) <= 1) {
      out.set(f.id, b);
      continue;
    }
    const full = tokenizeFamily(f.family);
    const kept = stripStyleTokens(full);
    const removed = full.slice(kept.length).join(" ");
    out.set(f.id, removed ? `${removed} ${b}` : b);
  }

  /* 三级：还撞名就补文件名 */
  const tally = new Map<string, number>();
  out.forEach((label) => tally.set(label, (tally.get(label) ?? 0) + 1));
  for (const f of faces) {
    const label = out.get(f.id)!;
    if ((tally.get(label) ?? 0) <= 1) continue;
    const stem = (f.fileName || "").replace(/\.[^.]+$/, "") || f.postScriptName;
    out.set(f.id, `${label} · ${stem}`);
  }

  return out;
}

function buildFamilies(idx: FontIndex): FamilyGroup[] {
  const map = new Map<string, FontFace[]>();
  for (const f of idx.faces) {
    if (!f.postScriptName) continue;
    // 同一份文件的第二份副本不进列表，否则字重里会出现两行一模一样的条目
    if (dupExtra.has(f.id)) continue;
    // 用归一化后的英文家族名归键：中文名有的 face 有、有的没有，用它归会把同一款拆开
    const key = familyKeyOf(f.family, f.postScriptName);
    if (!key) continue;
    const arr = map.get(key);
    if (arr) arr.push(f);
    else map.set(key, [f]);
  }

  const out: FamilyGroup[] = [];
  map.forEach((faces, key) => {
    const sorted = [...faces].sort(
      (a, b) => repScore(b) - repScore(a) || b.glyphCount - a.glyphCount
    );
    const rep = sorted[0];
    out.push({
      key,
      name: (rep.familyZh || rep.family || rep.postScriptName).trim(),
      family: rep.family,
      familyZh: rep.familyZh,
      rep,
      faces: sorted,
      hasCJK: rep.hasCJK,
      category: rep.category,
      scope: rep.scope,
      health: rep.health,
      isVariable: rep.isVariable,
      labels: variantLabels(sorted),
    });
  });

  return out;
}

function loadIndex(): FontIndex {
  if (index) return index;
  process.stdout.write("扫描字体...");
  const t0 = Date.now();
  index = scanFonts();
  process.stdout.write(` ${index.stats.parsedFaces} face / ${Date.now() - t0}ms\n`);

  faceById = new Map(index.faces.map((f) => [f.id, f]));

  /*
   * 必须先加载重复表再分组：分组时要把「多余副本」剔掉，
   * 否则同一款字体的系统级和用户级两份会各占一行字重。
   */
  const nb = loadNeighbors();

  const t1 = Date.now();
  families = buildFamilies(index);
  process.stdout.write(`分组家族 ${families.length} 个 / ${Date.now() - t1}ms\n`);

  process.stdout.write(
    nb
      ? `相似度 ${nb.stats.similar} 个 · 内容重复 ${nb.stats.dupGroups} 组（已折叠 ${dupExtra.size} 份多余副本）\n`
      : `未找到 data/neighbors.json，相似度与重复检测不可用\n`
  );

  return index;
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

interface Query {
  q: string;
  cat: string;
  lang: string;
  scope: string;
  health: string;
  /** "" 不筛 | "1" 同名重复（PostScript 名撞车）| "hash" 文件内容完全相同 */
  dup: string;
  offset: number;
  limit: number;
}

function parseQuery(url: URL): Query {
  return {
    q: (url.searchParams.get("q") ?? "").trim().toLowerCase(),
    cat: url.searchParams.get("cat") ?? "",
    lang: url.searchParams.get("lang") ?? "",
    scope: url.searchParams.get("scope") ?? "",
    health: url.searchParams.get("health") ?? "",
    dup: url.searchParams.get("dup") ?? "",
    offset: Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0),
    limit: Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 60) || 60)),
  };
}

/**
 * 同一款字体装了两份时（本机用户目录 + 系统目录），按 PostScript 名去重。
 *
 * 索引阶段已经用 duplicateOf 标好了「哪一份是副本」，canonical 那份
 * （已注册 > 系统目录 > 文件更大）不带 duplicateOf。这里再去一次重的，
 * 是为了兜住两种情况：
 *   1) canonical 那份文件坏了（missing-file）被过滤掉了，副本还能用；
 *   2) 副本先被扫到。
 *
 * 不去重的后果：字体比对的前 12 名里，同一款字体占两格，真身被挤出去；
 * 手动搜索框也会列出两个「Arial Regular」，让人以为系统装坏了。
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
      continue;
    }
    /* 已有了一份：如果新来的是 canonical，就换掉原来的副本 */
    if (!f.duplicateOf && prev.duplicateOf) {
      const at = out.indexOf(prev);
      if (at >= 0) out[at] = f;
      seen.set(key, f);
    }
  }
  return out;
}

function matches(f: FontFace, q: Query): boolean {
  if (q.cat && f.category !== q.cat) return false;
  if (q.scope && f.scope !== q.scope) return false;
  if (q.health && f.health !== q.health) return false;
  if (q.dup === "1" && !f.duplicateOf) return false;
  if (q.dup === "hash" && !dupByHash.has(f.id)) return false;
  if (q.lang === "cjk" && !f.hasCJK) return false;
  if (q.lang === "latin" && f.hasCJK) return false;
  if (q.q) {
    const hay = [
      f.family,
      f.familyZh ?? "",
      f.subfamily,
      f.subfamilyZh ?? "",
      f.postScriptName,
      f.fullName ?? "",
      f.fileName,
    ]
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q.q)) return false;
  }
  return true;
}

function matchesFamily(g: FamilyGroup, q: Query): boolean {
  if (q.cat && g.category !== q.cat) return false;
  if (q.scope && g.scope !== q.scope) return false;
  if (q.health && g.health !== q.health) return false;
  if (q.dup === "1" && !g.faces.some((f) => f.duplicateOf)) return false;
  if (q.dup === "hash" && !g.faces.some((f) => dupByHash.has(f.id))) return false;
  if (q.lang === "cjk" && !g.hasCJK) return false;
  if (q.lang === "latin" && g.hasCJK) return false;
  if (q.q) {
    const hay = g.faces
      .map((f) =>
        [
          f.family,
          f.familyZh ?? "",
          f.subfamily,
          f.postScriptName,
          f.fullName ?? "",
          f.fileName,
        ].join(" ")
      )
      .join(" ")
      .toLowerCase();
    if (!hay.includes(q.q)) return false;
  }
  return true;
}

/** 列表里只返回必要字段，别把 600KB 全甩给前端 */
function slim(f: FontFace) {
  return {
    id: f.id,
    family: f.family,
    familyZh: f.familyZh,
    subfamily: f.subfamily,
    postScriptName: f.postScriptName,
    category: f.category,
    scope: f.scope,
    health: f.health,
    registered: f.registered,
    isVariable: f.isVariable,
    isFixedPitch: f.isFixedPitch,
    hasCJK: f.hasCJK,
    weightClass: f.weightClass,
    format: f.format,
    fileSize: f.fileSize,
    glyphCount: f.glyphCount,
    duplicateOf: f.duplicateOf,
    collectionIndex: f.collectionIndex,
    hasFileDup: dupByHash.has(f.id),
  };
}

/** 字重列表条目：带上去重后的显示名 */
function slimSibling(f: FontFace, g: FamilyGroup) {
  return { ...slim(f), label: g.labels.get(f.id) ?? f.subfamily };
}

/** 重复副本要带上路径 —— 用户最想知道的就是「另一份到底在哪」 */
function slimWithPath(f: FontFace) {
  return { ...slim(f), filePath: f.filePath, fileName: f.fileName };
}

/** 相似字体：直接读预生成的邻居表，服务端零计算 */
function similarFor(f: FontFace, limit: number) {
  const nb = loadNeighbors();
  if (!nb) return [];
  const list = nb.byId[f.id];
  if (!list) return [];

  const out: {
    id: string;
    postScriptName: string;
    family: string;
    familyZh?: string;
    subfamily: string;
    hasCJK: boolean;
    score: number;
  }[] = [];
  /*
   * 按家族去重。同一款字体装了多份（比如华文宋体在系统目录和用户目录各有一份）
   * 会在邻居表里出现两次，列表上看着像「推荐了同一个东西两遍」。
   * 留下分数最高的那个代表即可。
   */
  const seenFamily = new Set<string>();

  for (const n of list) {
    if (out.length >= limit) break;
    const t = faceById.get(n.id);
    if (!t) continue;
    const famKey = familyKeyOf(t.family, t.postScriptName);
    if (seenFamily.has(famKey)) continue;
    seenFamily.add(famKey);
    out.push({
      id: t.id,
      postScriptName: t.postScriptName,
      family: t.family,
      familyZh: t.familyZh,
      subfamily: t.subfamily,
      hasCJK: t.hasCJK,
      score: n.s,
    });
  }
  return out;
}

function slimFamily(g: FamilyGroup) {
  return {
    key: g.key,
    id: g.rep.id,
    name: g.name,
    family: g.family,
    hasCJK: g.hasCJK,
    category: g.category,
    scope: g.scope,
    health: g.health,
    isVariable: g.isVariable,
    faceCount: g.faces.length,
    postScriptName: g.rep.postScriptName,
    weightClass: g.rep.weightClass,
    format: g.rep.format,
    fileSize: g.rep.fileSize,
    hasDuplicate: g.faces.some((f) => !!f.duplicateOf),
    hasFileDup: g.faces.some((f) => dupByHash.has(f.id)),
  };
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function serveStatic(res: http.ServerResponse, urlPath: string) {
  const webDir = path.join(ROOT, "apps", "web");
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  const full = path.join(webDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));

  if (!full.startsWith(webDir)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(full)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

function json(res: http.ServerResponse, body: unknown, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    // CEP 面板的 file:// origin 是 null，必须放开
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

/* ------------------------------------------------------------------ */
/* 写操作：安装 / 卸载 / 还原                                            */
/* ------------------------------------------------------------------ */

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function invalidateIndex() {
  index = null;
  families = [];
  faceById = new Map();
  // 字号库变了，相似度与重复表的 id 就对不上了，下次请求重新读
  neighbors = null;
  dupByHash = new Set();
  dupPartnerOf = new Map();
  dupExtra = new Set();
  faceToFamily = null;
}

/* ------------------------------------------------------------------ */
/* 常用字体（使用计数）                                                 */
/* ------------------------------------------------------------------ */

/**
 * 常用字体 = 「真正用上过的次数」，不是收藏。
 *
 * 计分口径（前端埋点，权重写在这里方便一处调）：
 *   应用到选区 +3 · 转曲恢复里被采用 +2 · 打开详情 +1
 * 只加不减，同分按最近使用时间排。
 *
 * 为什么放服务端而不是 localStorage：字体库面板和转曲恢复是同一页面，
 * 但 CEP 的 storage 会随扩展目录清理一起丢；而 data/ 是项目自己的数据，
 * 丢了重装字体也不会丢。另外服务端才有完整家族表，能把 ps 名聚成家族卡片。
 */
const USAGE_PATH = path.join(ROOT, "data", "usage.json");
/** n = 总积分，t = 最近一次时间，a = 真正「应用过」的次数（只有它才进常用榜） */
type Usage = { n: number; t: number; a: number };
let usageCache: Record<string, Usage> | null = null;
let faceToFamily: Map<string, FamilyGroup> | null = null;

function loadUsage(): Record<string, Usage> {
  if (usageCache) return usageCache;
  try {
    const raw = JSON.parse(fs.readFileSync(USAGE_PATH, "utf-8"));
    usageCache = raw && typeof raw === "object" ? (raw as Record<string, Usage>) : {};
  } catch {
    usageCache = {};
  }
  /*
   * 旧记录没有 a 字段（那时「打开详情 +1」也计数）。迁移规则：
   * 浏览只加 1 分，所以 n>=2 至少意味着「应用过一次」（+2/+3）。
   * 不迁移的话，用户之前真用过的字体会突然掉出常用榜。
   */
  let migrated = false;
  for (const k of Object.keys(usageCache!)) {
    const r: any = (usageCache as any)[k];
    if (r && typeof r.a !== "number") {
      r.a = Number(r.n) >= 2 ? 1 : 0;
      migrated = true;
    }
  }
  if (migrated) saveUsage();
  return usageCache!;
}

function saveUsage() {
  try {
    fs.mkdirSync(path.dirname(USAGE_PATH), { recursive: true });
    fs.writeFileSync(USAGE_PATH, JSON.stringify(usageCache ?? {}, null, 2), "utf-8");
  } catch {
    /* 计数写不进去不影响主流程 */
  }
}

/**
 * 打点。weight 3 = 应用到选区，2 = 转曲恢复里采用，1 = 只是看过。
 *
 * 常用榜只认 a>0（真的应用过）：光翻列表不该把常用塞满。
 * 分值和次数分开记 —— n 用来排序（应用一次抵浏览三次），
 * a 用来决定「有没有资格进榜」。
 */
function hitUsage(ps: string, weight = 1) {
  const key = String(ps ?? "").trim().toLowerCase();
  if (!key) return false;
  const u = loadUsage();
  const cur = u[key] ?? { n: 0, t: 0, a: 0 };
  const w = Math.max(1, Math.min(5, Math.round(Number(weight) || 1)));
  u[key] = {
    n: (Number(cur.n) || 0) + w,
    t: Date.now(),
    a: (Number(cur.a) || 0) + (w >= 2 ? 1 : 0),
  };
  saveUsage();
  return true;
}

/** ps 名 → 家族（字重面属于同一张卡片） */
function familyOfPostScript(ps: string): FamilyGroup | null {
  if (!faceToFamily) {
    faceToFamily = new Map();
    for (const g of families) {
      for (const f of g.faces) {
        const k = (f.postScriptName || "").toLowerCase();
        if (k && !faceToFamily.has(k)) faceToFamily.set(k, g);
      }
    }
  }
  return faceToFamily.get(String(ps ?? "").trim().toLowerCase()) ?? null;
}

/**
 * 探测「一行里混了两种样式」，给面板一个可直接采用的分段结果。
 *
 * 只在一整行比对分数已经不可信时被调用（< 0.6），所以不怕误报：
 * 正常稿根本走不进这里。
 *
 * 为什么用「最宽空白」下刀而不是检测字重：逐字符 stroke_weight 剖面
 * 在**单一**样式的真实稿上 min/max 也能差 8~16 倍（字母 'i' 与 'm' 的
 * 天然差异），完全淹没了 Bold↔Regular 这一步台阶（实测混合稿 1.7 倍，
 * 单一样式稿最高到 1.3 倍，区间重叠）。而本案例最宽空白恰好就是
 * WARNING: 与正文的交界（80px，行高 185 的 43%）。
 */
async function probeSplitSegments(
  png: string,
  box: number[],
  pool: FontFace[],
  wholeScore: number
): Promise<any> {
  try {
    const engine = getOcrEngine();
    const raw = await engine.splitLine(png, box, 2);
    if (!Array.isArray(raw) || raw.length !== 2) return null;

    const boxes = raw.map((b) => [b.l, b.t, b.r, b.b] as [number, number, number, number]);
    const texts = await engine.recognizeLines(png, boxes, 3);
    const out: any[] = [];
    for (let i = 0; i < boxes.length; i++) {
      const text = String(texts[i]?.text ?? "").trim();
      if (!text) return null;
      const scores = await engine.compareLineFonts(
        png,
        [{ box: boxes[i], text, weight: 1 }],
        pool.map((f) => ({
          id: f.id,
          path: f.filePath,
          index: f.collectionIndex ?? 0,
        }))
      );
      const byId = new Map(scores.map((s) => [s.id, s]));
      const ranked = pool
        .filter((f) => byId.has(f.id))
        .map((f) => ({
          postScriptName: f.postScriptName,
          family: f.family,
          familyZh: f.familyZh,
          subfamily: f.subfamily,
          score: byId.get(f.id)!.score,
          weightFit: (byId.get(f.id) as any)?.weightFit ?? null,
        }))
        .sort((a, b) => b.score - a.score)
        /* 先留 40 个：短段（比如 8 个字母的 "WARNING:"）单独比对极不稳定，
           真正该选的是「和长段同一个家族、只换字重」的那个，它常常排在
           第六名开外。下面用家族共识把它提上来，再截前 6。 */
        .slice(0, 40);
      out.push({ box: boxes[i], text, ranked });
    }

    /*
     * 家族共识：同一行的几段几乎一定是同一个字体家族，只是字重不同。
     * 实测 "WARNING:" 单独比对了 0.8594 的微软雅黑（真身其实是同一家族
     * 的粗体），把长段的家族提上来后才对。只在短段上做，长段自己的分数
     * 已经足够可信，不要动它。
     */
    const longest = out.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    const famOf = (c: any) =>
      String(c.family || c.familyZh || "")
        .trim()
        .toLowerCase();
    const famWant = famOf(longest.ranked[0] ?? {});
    if (famWant) {
      for (const seg of out) {
        if (seg === longest || seg.text.length > 12) continue;
        const idx = seg.ranked.findIndex((c: any) => famOf(c) === famWant);
        if (idx > 0) {
          const [hit] = seg.ranked.splice(idx, 1);
          seg.ranked.unshift(hit);
        }
        /*
         * 提上来的常常是同族的 Regular，而粗体标题段要的是同族的粗字重：
         * 实测 "WARNING:" 段 HarmonyOS Sans Regular 0.8313（字重吻合 0.86）
         * vs Medium 0.8199（字重吻合 0.99）—— 分数差 1%，字重却是对的那一档。
         * 恢复出来的字重错了，用户一样报「字体不对」。
         */
        const cluster = seg.ranked.filter((c: any) => famOf(c) === famWant).slice(0, 4);
        if (cluster.length > 1) {
          const bestByWeight = cluster.reduce((a: any, b: any) =>
            (b.weightFit ?? 0) > (a.weightFit ?? 0) ? b : a
          );
          const cur = seg.ranked[0];
          if (
            (cur.weightFit ?? 0) < 0.92 &&
            (bestByWeight.weightFit ?? 0) >= 0.95 &&
            cur.score - bestByWeight.score < 0.12
          ) {
            const at = seg.ranked.indexOf(bestByWeight);
            if (at > 0) {
              const [hit2] = seg.ranked.splice(at, 1);
              seg.ranked.unshift(hit2);
            }
          }
        }
      }
    }

    const segments = out.map((seg) => {
      const top6 = seg.ranked.slice(0, 6);
      /* 相对百分比按这 6 个里的最高分算，不按「排第一的那个」算：
         家族共识可能把 0.83 的提到达 0.86 的前面，用 0.83 当 100%
         会让同一个下拉里出现「103%」 */
      const best6 = Math.max(...top6.map((c: any) => c.score), 0.0001);
      return {
        box: seg.box,
        text: seg.text,
        score: seg.ranked[0]?.score ?? 0,
        candidates: top6.map((c: any) => ({
          ...c,
          rel: Math.min(100, Math.round((c.score / best6) * 100)),
        })),
      };
    });

    /* 分段没带来实质提升 → 不是「混样式」，别打扰用户 */
    const best = Math.max(...segments.map((o) => o.score));
    if (best < wholeScore + 0.1) return null;
    return { wholeScore, segments };
  } catch {
    /* 探测失败不影响主结果 */
    return null;
  }
}

async function handlePost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
) {
  try {
    /*
     * 自动更新：发起一次「下载 + 安装」后台任务。
     *
     * 为什么下载放在服务端而不是面板里：GitHub 的 Release 资产域名不带
     * CORS 头，Chromium 里 fetch 直接被拦（实测）。版本检查能过只是因为
     * api.github.com 带 CORS，资产下载是另一个域名。
     *
     * 为什么只是一个"发起"：几十 MB 的安装包不适合挂在一个请求体里，
     * 前端拿 jobId 轮询进度，中途断了也能看清是卡住还是在下。
     */
    if (url.pathname === "/api/update/install") {
      if (!isInstalledCopy()) {
        json(res, {
          ok: false,
          error: "当前是从源码目录运行的开发模式，自动更新已禁用（会覆盖你的开发目录）",
        }, 400);
        return;
      }
      if (isBusy()) {
        json(res, { ok: false, error: "已经有一个更新在进行中" }, 409);
        return;
      }

      const raw = await readBody(req, 1024 * 1024);
      const body = JSON.parse(raw.toString("utf-8") || "{}");
      const version = String(body.version ?? "").trim();
      const downloadUrl = String(body.url ?? "").trim();

      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        json(res, { ok: false, error: "版本号不合法" }, 400);
        return;
      }
      if (!/^https:\/\//i.test(downloadUrl)) {
        json(res, { ok: false, error: "下载地址必须是 https" }, 400);
        return;
      }

      const st = startUpdate(version, downloadUrl);
      json(res, { ok: true, state: st });
      return;
    }

    /*
     * 装完之后由前端调用，让老进程自己退出。
     *
     * 不自动退：装完还要让前端把"请重开 Illustrator"显示出来，
     * 一退出面板就成了一张断了线的空壳。
     * 但也不能不退 —— 端口一直被老进程占着，launcher 探活会认为
     * "已经在跑"，新版本永远不会被拉起来，用户重开也还是旧界面。
     */
    if (url.pathname === "/api/update/restart") {
      json(res, { ok: true });
      setTimeout(() => {
        try {
          process.exit(0);
        } catch {
          /* ignore */
        }
      }, 600);
      return;
    }

    /*
     * 转曲恢复：识别
     *
     * 入参就是 AI 侧 fdRecoverScan 的返回（导出的图路径 + 每个轮廓的像素框）。
     * 聚类、裁剪、OCR、坐标换算全在这一步做完。
     */
    /*
     * 转曲恢复：按路径几何渲染 + 识别。
     *
     * 这是主通道。AI 侧 fdRecoverGeometry 只回传轮廓坐标（不导图片），
     * 由 Python 自己画图并顺便算出每个轮廓的精确像素框，再走原来的
     * 聚类 + 逐字识别流程。
     *
     * 换掉原来的「AI 导出 PNG」原因：doc.exportFile 在真实文档上会卡住
     * AI 的 UI 线程，CEP 的 evalScript 回调永不返回，面板看起来完全没反应。
     */
    if (url.pathname === "/api/recover/geometry") {
      /* 几百个字的轮廓点串能到几百 KB，给足上限 */
      const raw = await readBody(req, 24 * 1024 * 1024);
      const body = JSON.parse(raw.toString("utf-8") || "{}");

      const shapes = Array.isArray(body.shapes) ? body.shapes : [];
      if (shapes.length === 0) {
        json(res, { ok: false, error: "缺少轮廓数据" }, 400);
        return;
      }

      const w = Number(body.w ?? 0);
      const h = Number(body.h ?? 0);
      if (!(w > 0 && h > 0)) {
        json(res, { ok: false, error: "画布尺寸非法" }, 400);
        return;
      }

      const dir = recoverDir();
      const pngPath = path.join(dir, `geom-${Date.now()}.png`);

      /*
       * 渲染倍率。
       *
       * AI 侧按 1pt = scale 像素回传轮廓，如果 1:1 渲染，一行 12pt 的
       * 说明文字只有 12 像素高 —— 字形细节全糊成黑块，OCR 会冒出
       * 「outiook」「reaa?」这种幻觉，字体比对更是全靠猜（实测候选分数
       * 挤在 0.84 附近，Top1 与 Top2 只差 0.4%）。
       *
       * 放大渲染后，同样的稿件 OCR 就干净了（outiook → outlook）。
       * 几何点、画布尺寸一起放大，scan.scale 也同步放大，所以
       * 文档坐标换算（box / scale）完全不用改。
       *
       * 倍率按画布面积自适应：大稿本来就字够大，放大只会让渲染和 OCR
       * 成倍变慢（18 行俄语稿 1 倍已要 57 秒），小稿才是真正受益的。
       */
      const area = w * h;
      const RS = area <= 200000 ? 4 : area <= 500000 ? 2 : 1;
      const scaledShapes = shapes.map((s: any) => ({
        c: Number(s?.c ?? 1),
        p: (Array.isArray(s?.p) ? s.p : []).map((flat: number[]) => {
          const out = new Array(flat.length);
          for (let i = 0; i + 1 < flat.length; i += 2) {
            out[i] = Number(flat[i]) * RS;
            out[i + 1] = Number(flat[i + 1]) * RS;
          }
          return out;
        }),
      }));

      try {
        const t0 = Date.now();
        const rendered = await getOcrEngine().renderGeometry(
          scaledShapes,
          w * RS,
          h * RS,
          pngPath.replace(/\\/g, "/"),
          3
        );

        const scan = {
          png: rendered.png,
          pngW: rendered.w,
          pngH: rendered.h,
          scale: Number(body.scale ?? 4) * RS,
          originX: Number(body.originX ?? 0),
          originY: Number(body.originY ?? 0),
          ptsW: Number(body.ptsW ?? 0),
          ptsH: Number(body.ptsH ?? 0),
          textFrames: Number(body.textFrames ?? 0),
          shapeCount: shapes.length,
          shapes: rendered.shapes,
          /* 位图 y 投影算出的行分界，多行识别全靠它 */
          bands: rendered.bands ?? [],
          /* 倾斜稿摆正的逆变换，pipeline 用它把 doc 坐标变回原始画布 */
          skew: rendered.skew ?? null,
        } as any;

        const result = await recognizeScan(scan, {
          charWidthRatio: body.charWidthRatio ? Number(body.charWidthRatio) : undefined,
          mergeRatio: body.mergeRatio ? Number(body.mergeRatio) : undefined,
          /* 8 行以上走整行通道即可：逐字 OCR 在长稿上要跑几百次，
             而逐字校对区已隐藏，实测 18 行俄语稿省下约 45 秒 */
          skipCharOcr: (rendered.bands ?? []).length >= 8,
        });

        /*
         * 低置信度自检：整块文字被旋转 180° 时 OCR 会彻底崩（FD-20261112
         * 那份实测平均 0.176，读成 "areeaase"），而字体比对、字号闭环、
         * 位置全被这串乱码带偏 —— 用户会一次报「少字 / 认错 / 字体不对 /
         * 字号字距不对 / 位置不对」五个问题，其实只是同一个根因。
         *
         * 只在原图平均分 < 0.5 时翻 180° 重跑一次整行 OCR；翻正分 > 0.75
         * 且高出 0.3 以上才判定「疑似倒转」，并把翻正读到的原文一起返回。
         * **不自动摆正**：旋转识别按用户决定保持冻结；而且让用户在 AI 里
         * 把稿子转正再识别，恢复出的文字方向才与原稿一致、位置也对得上。
         */
        const rlines: any[] = Array.isArray((result as any).lines)
          ? (result as any).lines
          : [];
        const ocrAvg = rlines.length
          ? rlines.reduce((s: number, l: any) => s + Number(l.score || 0), 0) /
            rlines.length
          : 0;
        let flipAvg = 0;
        let flipText = "";
        let likelyFlipped180 = false;
        if (ocrAvg < 0.5 && rlines.length > 0) {
          try {
            const flipPng = path
              .join(dir, `flip-${Date.now()}.png`)
              .replace(/\\/g, "/");
            const boxes = rlines
              .filter((l: any) => l && l.box)
              .map((l: any) => [l.box.l, l.box.t, l.box.r, l.box.b]);
            const flip = await getOcrEngine().flipCheck(
              rendered.png,
              boxes,
              flipPng
            );
            flipAvg = Number(flip.avg || 0);
            likelyFlipped180 = flipAvg > 0.75 && flipAvg > ocrAvg + 0.3;
            if (likelyFlipped180) {
              flipText = (flip.lines || [])
                .map((x: any) => String(x.text || "").trim())
                .filter(Boolean)
                .join("\n");
            }
          } catch (e: any) {
            /* 自检失败不该影响主链路，但必须留痕 —— 否则「倒转稿没提示」
               到底是判据不满足还是自检自己炸了，日志里分不出来 */
            console.warn("[flipcheck] 倒转自检失败:", e?.message ?? e);
          }
        }

        json(res, {
          ok: true,
          ...result,
          /* 前端后续调 /api/recover/match 要用这张图和它对应的坐标系 */
          png: rendered.png,
          pngW: rendered.w,
          pngH: rendered.h,
          scale: scan.scale,
          originX: scan.originX,
          originY: scan.originY,
          textFrames: scan.textFrames,
          bands: rendered.bands ?? [],
          skew: rendered.skew ?? null,
          gear: { totalMs: Date.now() - t0, inkRatio: rendered.inkRatio },
          /* 倒转自检：面板据此给「先转正再识别」的提示，不改动识别结果 */
          ocrAvg: Math.round(ocrAvg * 1000) / 1000,
          flipAvg: Math.round(flipAvg * 1000) / 1000,
          likelyFlipped180,
          flipText,
        });
      } catch (e: any) {
        json(res, { ok: false, error: e?.message ?? "渲染识别失败" }, 500);
      }
      return;
    }

    if (url.pathname === "/api/recover/recognize") {
      const raw = await readBody(req, 4 * 1024 * 1024);
      const body = JSON.parse(raw.toString("utf-8") || "{}");

      const scan = {
        png: String(body.png ?? ""),
        pngW: Number(body.pngW ?? 0),
        pngH: Number(body.pngH ?? 0),
        scale: Number(body.scale ?? 4),
        originX: Number(body.originX ?? 0),
        originY: Number(body.originY ?? 0),
        ptsW: Number(body.ptsW ?? 0),
        ptsH: Number(body.ptsH ?? 0),
        textFrames: Number(body.textFrames ?? 0),
        shapeCount: Number(body.shapeCount ?? 0),
        shapes: Array.isArray(body.shapes) ? body.shapes : [],
        bands: Array.isArray(body.bands) ? body.bands : [],
      };

      if (!scan.png || scan.shapes.length === 0) {
        json(res, { ok: false, error: "缺少图片或轮廓数据" }, 400);
        return;
      }

      try {
        const result = await recognizeScan(scan, {
          charWidthRatio: body.charWidthRatio ? Number(body.charWidthRatio) : undefined,
          mergeRatio: body.mergeRatio ? Number(body.mergeRatio) : undefined,
        });
        json(res, { ok: true, ...result });
      } catch (e: any) {
        json(res, { ok: false, error: e?.message ?? "识别失败" }, 500);
      }
      return;
    }

    /*
     * 转曲恢复：猜原稿字体
     *
     * 只比 2-3 个代表字，不是每个字都比 —— 同一段文字字体必然相同，
     * 而打开一个中文字体要 20-40ms，全字参与会把耗时翻好几倍。
     */
    /*
     * 转曲恢复：把一行按墨迹空隙拆成 n 段。
     *
     * 用途：同一行里有多套样式（粗体标签 + 常规内容、大小字号混排）时，
     * 整行会被统一成一个字体一个字号。这里让用户指定段数，服务端只在
     * 真实空白列下刀，每段再走各自的识别/字体比对/恢复。
     *
     * 为什么不自动判断哪里换了样式：实测这批转曲稿的信号不够 ——
     * 单一样式稿笔画只有 2px、字重差 ±1px 与噪声同量级，字框高度被
     * 大小写主导（同行波动 ±40%），整行渲染比对又会因字距漂移对不齐。
     * 三条路都验证过且都不可靠，硬切必然误伤，所以改成用户可控。
     */
    if (url.pathname === "/api/recover/split-line") {
      const raw = await readBody(req, 1024 * 1024);
      const body = JSON.parse(raw.toString("utf-8") || "{}");

      const png = String(body.png ?? "");
      const box = Array.isArray(body.box) ? body.box.map(Number) : null;
      const n = Number(body.n ?? 2);
      if (!png || !box || box.length < 4 || box.some((v: number) => !Number.isFinite(v))) {
        json(res, { ok: false, error: "缺少图片或行框" }, 400);
        return;
      }
      if (!isSafeRecoverPath(png)) {
        json(res, { ok: false, error: "拒绝读取工作目录之外的图片" }, 400);
        return;
      }
      if (!(n >= 2 && n <= 8)) {
        json(res, { ok: false, error: "段数需在 2~8 之间" }, 400);
        return;
      }

      try {
        const segments = await getOcrEngine().splitLine(png, box, Math.round(n));
        json(res, { ok: true, segments });
      } catch (e: any) {
        json(res, { ok: false, error: e?.message ?? "拆分失败" }, 500);
      }
      return;
    }

    /*
     * 按给定像素框直接读文本（行内分段用）。
     *
     * 和 /api/recover/recognize 的区别：那条走完整管线（再算行带、再聚类），
     * 而这里已经知道"就是一个框、就是一行"，直接交给整行识别器最省事也最准。
     */
    if (url.pathname === "/api/recover/ocr-lines") {
      const raw = await readBody(req, 4 * 1024 * 1024);
      const body = JSON.parse(raw.toString("utf-8") || "{}");

      const png = String(body.png ?? "");
      const boxes = Array.isArray(body.boxes) ? body.boxes : [];
      if (!png || boxes.length === 0) {
        json(res, { ok: false, error: "缺少图片或框" }, 400);
        return;
      }
      if (!isSafeRecoverPath(png)) {
        json(res, { ok: false, error: "拒绝读取工作目录之外的图片" }, 400);
        return;
      }

      try {
        const clean = boxes
          .filter((b: any) => Array.isArray(b) && b.length >= 4)
          .map((b: any) => b.slice(0, 4).map(Number));
        const out = await getOcrEngine().recognizeLines(png, clean, 3);
        json(res, {
          ok: true,
          lines: out.map((r: any) => ({
            text: String(r?.text ?? ""),
            score: Number(r?.score ?? 0),
          })),
        });
      } catch (e: any) {
        json(res, { ok: false, error: e?.message ?? "识别失败" }, 500);
      }
      return;
    }

    if (url.pathname === "/api/recover/match") {
      const raw = await readBody(req, 8 * 1024 * 1024);
      const body = JSON.parse(raw.toString("utf-8") || "{}");

      const png = String(body.png ?? "");
      const chars = Array.isArray(body.chars) ? body.chars : [];
      const lineText = String(body.lineText ?? "").trim();
      const lineBox = Array.isArray(body.lineBox) ? body.lineBox : null;
      /* 新版面板传多行：每行带自己的墨迹框和文本，逐行比对再加权 */
      const lineRows = Array.isArray(body.lines) ? body.lines : [];
      if (!png || (chars.length === 0 && !lineText && lineRows.length === 0)) {
        json(res, { ok: false, error: "缺少图片或字符数据" }, 400);
        return;
      }

      const idx = loadIndex();

      try {
        const t0 = Date.now();
        let ranked: any[];
        let samples: string[];
        let mode = "glyph";
        /* 整行分数不可信时，服务端额外探测出来的分段结果 */
        let autoSegments: any = null;
        /* 实际参与比对的文本：字体垂直度量要用同一句来测墨迹底 */
        let matchText = "";

        if (lineRows.length > 0 || lineText) {
          /*
           * 整行轮廓比对：拿 OCR 认出的整句，用每个候选字体渲染一遍，
           * 跟转曲轮廓比归一化后的形状。多行时每行单独比、按墨迹面积加权：
           * 某一行文本有小错也不至于把结果带偏。实测两行英文稿，只比第一行
           * 且文本带行首幻觉 "..." 时 Baloo 2 0.8386 排第一、各字体挤成噪声；
           * 两行加权后 MiSans 包揽前六。
           */
          mode = "line";
          const pool = dedupeByPostScriptName(
            idx.faces.filter(
              (f) => f.postScriptName && f.health !== "missing-file" && f.filePath
            )
          );
          const targets = lineRows.length > 0
            ? lineRows
                .filter((x: any) => x && String(x.text ?? "").trim())
                .sort(
                  (a: any, b: any) =>
                    String(b.text ?? "").length - String(a.text ?? "").length
                )
                .slice(0, 6)
                .map((x: any) => ({
                  box: Array.isArray(x.box) ? x.box : null,
                  text: String(x.text).trim(),
                  weight: Number(x.weight ?? 1),
                }))
            : [{ box: lineBox, text: lineText, weight: 1 }];
          matchText = String(targets[0]?.text ?? "");

          /*
           * 切片：OCR 的逐字框经常把两三个字母粘成一格（"lis" / "co" / "ht"），
           * 框里本来就是多个字母，所以要比对就得**整串一起渲染**再比，
           * 不是拿它当单字（拿 "ht" 去比 "h" 必然全错，这正是旧代码
           * 只敢用 length===1 的切片、结果退化到只剩 "w" 和 "1" 两个的原因）。
           *
           * 过滤规则，每一条都是被真实数据逼出来的：
           *   1) 含标点一律丢。标点在所有字体里几乎一样（句点就是个小圆），
           *      不携带字体特征；"W." / "S." / "$:I." 这类还多是切分噪声。
           *   2) 极窄字符丢（宽/高 < 0.32）。l、i、1 在几百款字体里长一个样。
           *   3) 必须在行文本里找得到。OCR 会给幻觉字符，对不上就是噪声。
           *   4) 置信度门槛只设 0.25，**不作为主要判据** —— 汉字单字没有上下文，
           *      OCR 置信度天然只有 0.3~0.5（实测「滚滚长江东逝水」全部 0.29~0.50），
           *      按英文那种 0.6 去卡会把中文切片全部误杀。
           *      真正把关的是第 3 条；文本认错的切片会在 Python 侧
           *      因为余弦掉到 0.5 以下被剔除，不会污染排序。
           */
          const corrText = lineText || targets.map((t: any) => String(t.text ?? "")).join("");
          const slices: Array<{ box: number[]; text: string }> = (() => {
            if (!Array.isArray(chars) || chars.length === 0) return [];
            const out: Array<{ box: number[]; text: string; area: number }> = [];
            for (const c of chars as any[]) {
              const raw = String(c?.ch ?? "").trim();
              if (!raw || raw.length > 4) continue;
              if (/[^A-Za-z0-9\u3400-\u9fff]/.test(raw)) continue;
              const bx = Array.isArray(c?.box) ? c.box : null;
              if (!bx || bx.length < 4) continue;
              const box = bx.slice(0, 4).map((v: any) => Number(v) || 0);
              const bw = Math.abs(box[2] - box[0]);
              const bh = Math.abs(box[3] - box[1]);
              if (bh <= 0 || bw / bh < 0.32) continue;
              if (Number(c?.score ?? 0) < 0.25) continue;
              let text = raw;
              if (corrText) {
                const at = corrText.toLowerCase().indexOf(raw.toLowerCase());
                if (at < 0) continue;
                /* 大小写校正：OCR 常把 s 认成 S，用行文本里那一份覆盖 */
                text = corrText.substr(at, raw.length);
              }
              const area = bw * bh;
              out.push({ box, text, area });
            }
            /* 框面积大的优先：2~3 个字母的粘连片信息量远高于单个窄字符 */
            out.sort((a, b) => b.area - a.area);
            /* 同一个字出现两次（「滚滚长江」）只留一个 —— 重复切片等于
               给这个字投两票，会让碰巧像它的字体被高估 */
            const used = new Set<string>();
            return out
              .filter((s) => {
                if (used.has(s.text)) return false;
                used.add(s.text);
                return true;
              })
              .slice(0, 8)
              .map(({ box, text }) => ({ box, text }));
          })();

          const scores = await getOcrEngine().compareLineFonts(
            png,
            targets,
            pool.map((f) => ({
              id: f.id,
              path: f.filePath,
              index: f.collectionIndex ?? 0,
            })),
            slices
          );
          const byId = new Map(scores.map((s) => [s.id, s]));
          ranked = pool
            .filter((f) => byId.has(f.id))
            .map((f) => {
              const s = byId.get(f.id)!;
              return {
                faceId: f.id,
                postScriptName: f.postScriptName,
                family: f.family,
                familyZh: f.familyZh,
                subfamily: f.subfamily,
                score: s.score,
                /* 字重 / 字宽吻合度：给面板显示，让「字体不对」能一眼
                   定位到是字族不对、字重不对，还是字宽不对 */
                weightFit: (s as any).weightFit ?? null,
                widthFit: (s as any).widthFit ?? null,
                geoFit: (s as any).geoFit ?? null,
                widthRatio: (s as any).widthRatio ?? null,
                /* 切片形状吻合度：诊断日志里带上它，以后「字体不对」
                   能一眼看出是形状判错、还是被字重/字宽修正翻盘 */
                sliceFit: (s as any).sliceFit ?? null,
              };
            })
            .sort((a, b) => b.score - a.score)
            /* 给 12 个而不是 6 个：字体识别是「最相似推荐」而不是鉴定，
               真身常排在第 7~10 位（实测 Arial 排第 7 名），只给 6 个
               用户根本看不到正确答案 */
            .slice(0, 12);
          samples = [];

          /*
           * 整行分数过低 → 很可能这一行里混了两种字重/字号（粗体标题 +
           * 常规正文是最常见的说明书排版）。整行只按一个字重渲染，正确
           * 字体会被整片挤下去（实测 0.48，推荐成 Gabriola 装饰体）。
           * 这里按最宽空白拆两段各自比对，明显变好才回报给面板。
           */
          if (targets.length === 1 && Array.isArray(targets[0].box)) {
            const whole = ranked[0]?.score ?? 0;
            if (whole > 0 && whole < 0.6) {
              autoSegments = await probeSplitSegments(
                png,
                targets[0].box as number[],
                pool,
                whole
              );
            }
          }
        } else {
          const result = await matchFont(
            png,
            chars.map((c: any) => ({
              ch: String(c.ch ?? ""),
              score: Number(c.score ?? 0),
              box: {
                l: Number(c.box?.[0] ?? 0),
                t: Number(c.box?.[1] ?? 0),
                r: Number(c.box?.[2] ?? 0),
                b: Number(c.box?.[3] ?? 0),
              },
            })),
            idx,
            { limit: 6, maxSamples: Number(body.maxSamples ?? 5) }
          );
          ranked = result.candidates;
          samples = result.samples;
        }

        /*
         * 整行分数过低时，主动探测「这一行里混了两种字重/字号」。
         *
         * 实测 FD-20261117-142243：`• WARNING:(粗) Do not use ...(常规)`，
         * 整行按单一字重渲染，WARNING 段全错 → 最高分只有 0.48，面板推荐
         * 了 Gabriola（装饰体）。同一行按最宽空白切成两段后分别是 0.94 / 0.86。
         *
         * 为什么不在正常稿上跑：两条 compare 加一次 OCR 要 4~6 秒。只在
         * 整行已经不可信（< 0.6）时才跑，正常稿零额外开销、零误报。
         */
        /* 原始余弦分数绝对值偏低（转曲图是「抗锯齿渲染再二值化」，候选字体是
         * 「直接扫描线填充」，两者边缘处理天然不同）。按最高分归一化后再给前端，
         * 否则用户看到 30% 会以为没匹配上。
         */
        const topScore = Math.max(0.0001, ranked[0]?.score ?? 0);

        /*
         * 垂直度量：AI 的 textFrame.visibleBounds 下边是「行框底」
         * （= 基线 − descent×字号），不是字形墨迹的底。恢复时直接拿它对位，
         * 整行就会按该字体的 descender 高度上移 —— 于是「换一个字体，
         * 偏移量就变」。实测 FD-20261118-102207：华文琥珀 11.9pt 整体偏高。
         *
         * 这里给每个候选算两项（都按 em 归一化）：
         *   descent   行框底比基线低多少
         *   inkBottom 这行字在该字体下墨迹底比基线低多少（负数=墨迹在基线之上）
         * 前端算 lift = descent + inkBottom，恢复时把行框底换成墨迹底。
         */
        const lifts = new Map<string, { descent: number; inkBottom: number }>();
        try {
          const sampleText = matchText;
          const pairs: Array<[string, number]> = [];
          const seenPath = new Set<string>();
          /* 只测前 8 个：每个字体要渲染一次量墨迹，12 个会多花半秒；
             真身几乎都在前几名，后面的候选算不到就和改动前一样退回 0 */
          for (const c of ranked.slice(0, 8)) {
            const face = idx.faces.find(
              (x) => x.postScriptName === c.postScriptName && x.filePath
            );
            if (!face?.filePath) continue;
            const key = face.filePath + "#" + (face.collectionIndex || 0);
            if (seenPath.has(key)) continue;
            seenPath.add(key);
            pairs.push([face.filePath, Number(face.collectionIndex) || 0]);
          }
          if (pairs.length) {
            const ms = await getOcrEngine().fontMetrics(pairs, sampleText);
            /* TTC 合集里同一文件有多个 face，key 必须带 index */
            for (const m of ms) {
              lifts.set(String(m.path) + "#" + (Number(m.index) || 0), m);
            }
          }
        } catch {
          /* 度量失败不影响匹配：前端拿不到 lift 就退回旧的对位方式 */
        }

        const candidates = ranked.map((c) => {
          const face = idx.faces.find(
            (x) => x.postScriptName === c.postScriptName && x.filePath
          );
          const m = face?.filePath
            ? lifts.get(
                String(face.filePath) + "#" + (Number(face.collectionIndex) || 0)
              )
            : null;
          return {
            ...c,
            rel: Math.round((c.score / topScore) * 100),
            descent: m ? Math.round(m.descent * 1000) / 1000 : null,
            inkBottom: m ? Math.round(m.inkBottom * 1000) / 1000 : null,
          };
        });

        json(res, {
          ok: true,
          candidates,
          samples,
          mode,
          segments: autoSegments,
          best: candidates[0] ?? null,
          durationMs: Date.now() - t0,
        });
      } catch (e: any) {
        json(res, { ok: false, error: e?.message ?? "字体匹配失败" }, 500);
      }
      return;
    }

    /*
     * 常用字体计数：面板在「真正用上」某个字体时打一点。
     * 失败一律静默（返回 ok:false 也只是少记一次，不该打断用户操作）。
     */
    if (url.pathname === "/api/usage/hit") {
      const raw = await readBody(req, 64 * 1024);
      const body = JSON.parse(raw.toString("utf-8") || "{}");
      const ok = hitUsage(
        String(body.ps ?? body.postScriptName ?? ""),
        Number(body.weight ?? 1)
      );
      json(res, { ok }, ok ? 200 : 400);
      return;
    }

    /*
     * 从「常用」里移除。前端传整族 ps 名（top 接口的 psList），
     * 一次多选的多个家族合并成一个数组提交。
     * 返回被删的原始计数，面板据此做「撤销」。
     */
    if (url.pathname === "/api/usage/remove") {
      const raw = await readBody(req, 256 * 1024);
      const body = JSON.parse(raw.toString("utf-8") || "{}");
      const list: string[] = Array.isArray(body.ps) ? body.ps : [];
      const u = loadUsage();
      const removed: Record<string, { n: number; t: number }> = {};
      for (const name of list) {
        const k = String(name ?? "").trim().toLowerCase();
        if (!k || !u[k]) continue;
        removed[k] = u[k];
        delete u[k];
      }
      saveUsage();
      json(res, { ok: true, removed, left: Object.keys(u).length });
      return;
    }

    /* 撤销移除：原样写回计数，不动时间戳 */
    if (url.pathname === "/api/usage/restore") {
      const raw = await readBody(req, 256 * 1024);
      const body = JSON.parse(raw.toString("utf-8") || "{}");
      const entries = body.entries && typeof body.entries === "object" ? body.entries : {};
      const u = loadUsage();
      let n = 0;
      for (const k of Object.keys(entries)) {
        const e = entries[k] || {};
        const key = String(k).trim().toLowerCase();
        if (!key) continue;
        u[key] = {
          n: Number(e.n) || 1,
          t: Number(e.t) || Date.now(),
          /* 撤销时必须把「应用次数」一起写回去，否则记录会掉出常用榜 */
          a: Number(e.a) || 0,
        };
        n++;
      }
      saveUsage();
      json(res, { ok: true, restored: n });
      return;
    }

    /*
     * 诊断日志：用户在面板里勾选问题类型后一键生成。
     * 同时落一份完整 JSON（排查用）和一份可直接复制的纯文本。
     */
    if (url.pathname === "/api/feedback/report") {
      const raw = await readBody(req, 4 * 1024 * 1024);
      let body: any = {};
      try {
        body = JSON.parse(raw.toString("utf-8") || "{}");
      } catch {
        json(res, { ok: false, error: "请求不是合法 JSON" }, 400);
        return;
      }

      const d = new Date();
      const p2 = (n: number) => String(n).padStart(2, "0");
      const id = `FD-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(
        d.getHours()
      )}${p2(d.getMinutes())}${p2(d.getSeconds())}`;

      try {
        const dir = path.resolve(ROOT, "data", "feedback");
        fs.mkdirSync(dir, { recursive: true });
        const text = buildReportText(id, body);
        const jsonPath = path.join(dir, `${id}.json`);
        const txtPath = path.join(dir, `${id}.txt`);
        fs.writeFileSync(
          jsonPath,
          JSON.stringify({ id, at: d.toISOString(), ...body }, null, 2),
          "utf-8"
        );
        fs.writeFileSync(txtPath, text, "utf-8");
        json(res, { ok: true, id, text, jsonPath, txtPath });
      } catch (e: any) {
        json(res, { ok: false, error: e?.message ?? "写日志失败" }, 500);
      }
      return;
    }

    /* 安装（本地路径，CEP 面板的文件对话框走这条） */
    if (url.pathname === "/api/install") {
      const raw = await readBody(req, 1024 * 1024);
      const body = JSON.parse(raw.toString("utf-8") || "{}");

      const existing = new Set(readFontRegistry().map((e) => e.regName));
      const result = installFontFile(String(body.path ?? ""), {
        existingRegNames: existing,
        overwrite: !!body.overwrite,
      });

      if (result.ok) invalidateIndex();
      return json(res, result, result.ok ? 200 : 400);
    }

    /* 安装（直接上传二进制，浏览器拖拽走这条） */
    if (url.pathname === "/api/install-raw") {
      const buf = await readBody(req, 200 * 1024 * 1024);
      if (buf.length === 0) return json(res, { ok: false, error: "空文件" }, 400);

      const rawName = req.headers["x-filename"];
      let fileName = "uploaded-font.ttf";
      if (typeof rawName === "string" && rawName) {
        try {
          fileName = path.basename(decodeURIComponent(rawName));
        } catch {
          fileName = path.basename(rawName);
        }
      }

      const tmpDir = path.join(ROOT, "data", "uploads");
      fs.mkdirSync(tmpDir, { recursive: true });
      const tmpPath = path.join(
        tmpDir,
        `${Date.now()}_${fileName.replace(/[\\/:*?"<>|]/g, "_")}`
      );
      fs.writeFileSync(tmpPath, buf);

      const existing = new Set(readFontRegistry().map((e) => e.regName));
      const result = installFontFile(tmpPath, { existingRegNames: existing });

      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }

      if (result.ok) invalidateIndex();
      return json(res, result, result.ok ? 200 : 400);
    }

    /* 卸载 */
    if (url.pathname === "/api/uninstall") {
      const raw = await readBody(req, 64 * 1024);
      const body = JSON.parse(raw.toString("utf-8") || "{}");
      const result = uninstallFont(String(body.id ?? ""));
      if (result.ok) invalidateIndex();
      return json(res, result, result.ok ? 200 : 400);
    }

    /* 还原 */
    if (url.pathname === "/api/restore") {
      const raw = await readBody(req, 64 * 1024);
      const body = JSON.parse(raw.toString("utf-8") || "{}");
      const result = restoreFont(String(body.id ?? ""));
      if (result.ok) invalidateIndex();
      return json(res, result, result.ok ? 200 : 400);
    }

    json(res, { error: "not found" }, 404);
  } catch (e: any) {
    json(res, { ok: false, error: e.message }, 500);
  }
}

/*
 * 空闲自动退出。
 * 面板会在需要时自己把服务拉起来，所以没必要常驻占内存：
 * 关掉 Illustrator 之后没人访问，最多半小时就自己收摊。
 * 面板前端有心跳，只要面板开着就不会误判。
 */
const IDLE_TIMEOUT_MS = Number(process.env.FONTDECK_IDLE_MS ?? 30 * 60 * 1000);
let lastActivity = Date.now();

/*
 * 跨域来源白名单。
 *
 * CEP 面板是 file:// 加载的，浏览器给的 Origin 就是字符串 "null"，必须放行；
 * curl / python / launcher 探活不带 Origin，也放行。其余一律拒绝。
 */
function originAllowed(origin: string): boolean {
  if (!origin) return true;
  if (origin === "null") return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
}

/*
 * 写操作只接受这两种 Content-Type。
 *
 * 这是 CSRF 的实际闸门，配合下面的 OPTIONS 白名单生效：
 *   1) application/json / octet-stream 都不属于 CORS「简单请求」，
 *      浏览器必须先发 preflight，而 preflight 会被 Origin 白名单拦掉；
 *   2) 攻击者想退回简单请求只能用 text/plain、form-urlencoded、
 *      multipart/form-data，这里直接 415 拒绝。
 * 早先只校验 Host —— 那是无效的：跨域请求的 Host 是「目标地址」，
 * 恒等于 127.0.0.1，跟来源无关，等于任意网页都能调 /api/install-raw。
 */
const ALLOWED_POST_TYPES = ["application/json", "application/octet-stream"];

function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  lastActivity = Date.now();
  const url = new URL(req.url ?? "/", `http://${HOST}:${PREFERRED_PORT}`);

  if (req.method === "OPTIONS") {
    if (!originAllowed(String(req.headers.origin ?? ""))) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("forbidden origin");
      return;
    }
    res.writeHead(204, {
      "Access-Control-Allow-Origin": String(req.headers.origin ?? "*"),
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    res.end();
    return;
  }

  if (req.method === "POST") {
    const host = (req.headers.host ?? "").split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") {
      json(res, { error: "forbidden host" }, 403);
      return;
    }
    const ctype = String(req.headers["content-type"] ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_POST_TYPES.includes(ctype)) {
      json(res, { ok: false, error: "unsupported content-type" }, 415);
      return;
    }
    /*
     * handlePost 内部虽然整体包了 try/catch，但 res 已被对端销毁时
     * json() 自己会抛，所以这里再兜一层，进程不能因为一个请求死掉。
     */
    void handlePost(req, res, url).catch((e: any) => {
      if (!res.headersSent) {
        json(res, { ok: false, error: e?.message ?? "internal error" }, 500);
      }
    });
    return;
  }

  const idx = loadIndex();

  /* 健康检查 */
  if (url.pathname === "/api/health") {
    json(res, {
      ok: true,
      faces: idx.stats.parsedFaces,
      generatedAt: idx.generatedAt,
      version: idx.version,
    });
    return;
  }

  /*
   * 版本与更新源。
   *
   * 只回本地信息，**不代客户端去请求 GitHub** —— 原因很实际：
   * CEP 面板跑在 Chromium 里，走系统代理；而这里的 Node 进程默认不走
   * 系统代理（Node 不读注册表里的 proxy 设置）。国内机器上「浏览器能开
   * GitHub、Node 超时」是常态，所以探测这一步交给前端做，服务端只提供
   * 版本号和仓库地址。
   *
   * `data/update.json` 是可选的运维配置，不放进代码里：
   *   { "repo": "owner/fontdeck", "api": "", "check": true }
   * api 留空就走 GitHub 官方；填了就用同结构的自建/镜像地址。
   */
  if (url.pathname === "/api/update/info") {
    const pkg = (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
      } catch {
        return {} as any;
      }
    })();
    let cfg: any = {};
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "update.json"), "utf-8"));
    } catch {
      /* 没配就是没配，不是错误 */
    }
    json(res, {
      ok: true,
      current: String(pkg.version || "0.0.0"),
      repo: String(cfg.repo || ""),
      api: String(cfg.api || ""),
      check: cfg.check !== false,
      /* 面板壳的版本：壳不跟着服务端更新，单独报出来便于排查「更新了但界面没变」 */
      panelVersion: String(cfg.panelVersion || ""),
      /*
       * 从源码目录跑的时候不能自动更新（会覆盖开发目录），
       * 前端据此决定按钮是「立即更新」还是「手动下载」。
       */
      autoUpdate: isInstalledCopy(),
    });
    return;
  }

  /* 更新任务进度：前端轮询这个 */
  if (url.pathname === "/api/update/status") {
    json(res, { ok: true, state: getUpdateState() });
    return;
  }

  /* 统计 */
  if (url.pathname === "/api/stats") {
    const nb = loadNeighbors();
    json(res, {
      ...idx.stats,
      familyCount: families.length,
      similarCount: nb?.stats.similar ?? 0,
      fileDupGroups: nb?.stats.dupGroups ?? 0,
      fileDupFaces: dupByHash.size,
    });
    return;
  }

  /* 安装台账 */
  if (url.pathname === "/api/installed") {
    const ledger = readLedger();
    json(res, {
      installed: ledger.records.filter((r) => r.status === "installed"),
      uninstalled: ledger.records.filter((r) => r.status === "uninstalled").slice(-30),
    });
    return;
  }

  /*
   * 常用字体（按使用次数）。返回的是**家族卡片**，不是 face：
   * 用户心智里「我在用 HarmonyOS Sans」，不是「我在用某个字重」。
   * 同一个家族的不同字重只占一张卡，取该家族里用得最多的那份计数。
   */
  if (url.pathname === "/api/usage/top") {
    const limit = Math.max(
      1,
      Math.min(40, Number(url.searchParams.get("limit") ?? 12) || 12)
    );
    const u = loadUsage();
    const entries = Object.keys(u)
      .map((k) => ({
        k,
        n: Number(u[k]?.n) || 0,
        t: Number(u[k]?.t) || 0,
        a: Number(u[k]?.a) || 0,
      }))
      /* 只收录「真的应用过」的：光打开详情看过的不进常用榜 */
      .filter((e) => e.a > 0)
      .sort((a, b) => b.a - a.a || b.t - a.t);

    const seen = new Set<string>();
    const items: any[] = [];
    for (const e of entries) {
      const g = familyOfPostScript(e.k);
      if (!g || seen.has(g.key)) continue;
      seen.add(g.key);
      /*
       * 带上该家族全部 face 的 ps 名：删除「常用」时必须整族一起删，
       * 只删用得最多的那一个，同族别的字重还留着计数，卡片会立刻再冒出来。
       */
      items.push({
        ...slimFamily(g),
        used: e.a,
        lastUsed: e.t,
        psList: g.faces
          .map((f) => (f.postScriptName || "").toLowerCase())
          .filter(Boolean),
      });
      if (items.length >= limit) break;
    }
    json(res, { ok: true, total: seen.size, items });
    return;
  }

  /* 家族列表（前端主用） */
  if (url.pathname === "/api/families") {
    const q = parseQuery(url);
    const hits = families.filter((g) => matchesFamily(g, q));
    hits.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
    const page = hits.slice(q.offset, q.offset + q.limit);
    json(res, {
      total: hits.length,
      offset: q.offset,
      limit: q.limit,
      faceTotal: idx.stats.parsedFaces,
      items: page.map(slimFamily),
    });
    return;
  }

  /* face 列表（保留，用于调试和按 face 查） */
  if (url.pathname === "/api/fonts") {
    const q = parseQuery(url);
    const hits = idx.faces.filter((f) => matches(f, q));
    hits.sort((a, b) => {
      const an = (a.familyZh || a.family).toLowerCase();
      const bn = (b.familyZh || b.family).toLowerCase();
      return an.localeCompare(bn, "zh-Hans-CN") || a.weightClass - b.weightClass;
    });
    const page = hits.slice(q.offset, q.offset + q.limit);
    json(res, {
      total: hits.length,
      offset: q.offset,
      limit: q.limit,
      items: page.map(slim),
    });
    return;
  }

  /* 单个 face 详情：同家族字重 + 相似字体 + 内容重复 */
  const detail = url.pathname.match(/^\/api\/fonts\/([0-9a-f]{12})$/);
  if (detail) {
    const f = faceById.get(detail[1]);
    if (!f) return json(res, { error: "not found" }, 404);

    const familyKey = familyKeyOf(f.family, f.postScriptName);
    const group = families.find((g) => g.key === familyKey);

    /* 是否由本工具安装：比对台账里的文件路径 */
    const record = readLedger().records.find(
      (r) => r.status === "installed" && r.filePath.toLowerCase() === f.filePath.toLowerCase()
    );

    /* 文件内容完全相同的其它 face */
    const partners = (dupPartnerOf.get(f.id) ?? [])
      .map((id) => faceById.get(id))
      .filter((x): x is FontFace => !!x);

    return json(res, {
      ...f,
      familyKey,
      installedRecordId: record ? record.id : null,
      siblings: group ? group.faces.map((x) => slimSibling(x, group)) : [slim(f)],
      similar: similarFor(f, 6),
      fileDupes: partners.map(slimWithPath),
    });
  }

  /* SVG 预览 */
  const preview = url.pathname.match(/^\/api\/fonts\/([0-9a-f]{12})\/preview\.svg$/);
  if (preview) {
    const f = idx.faces.find((x) => x.id === preview[1]);
    if (!f) return json(res, { error: "not found" }, 404);

    const text = (url.searchParams.get("text") ?? "").slice(0, 40);
    const size = Math.min(
      200,
      Math.max(8, Number(url.searchParams.get("size") ?? 32) || 32)
    );
    const maxWidth = Math.min(2000, Math.max(100, Number(url.searchParams.get("w") ?? 620) || 620));

    const svg = renderCached(f.filePath, f.collectionIndex, {
      text: text || undefined,
      fontSize: size,
      padding: 0,
      color: url.searchParams.get("color") ?? "#16161a",
      maxWidth,
    });

    if (!svg) {
      // 返回 404 而不是一张"预览不可用"的图：
      // 前端 img 的 onerror 才能触发，从而换成 HTML 文字兜底（尤其字体名那一行）
      res.writeHead(404, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("preview unavailable");
      return;
    }

    res.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    });
    res.end(svg);
    return;
  }

  /* 其余走静态资源 */
  serveStatic(res, url.pathname);
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

/*
 * 最后一道防线。
 *
 * 服务是常驻进程、面板依赖它，任何漏网的异步异常都不该让进程直接消失
 * —— 退出后虽然 CEP 会重新拉起，但要重扫 781 个 face。
 * 这里只记录不退出：本地单用户工具，可用性优先；日志里能拿到完整堆栈。
 */
process.on("unhandledRejection", (e: any) => {
  console.error("[unhandledRejection]", e?.stack ?? e?.message ?? e);
});
process.on("uncaughtException", (e: any) => {
  console.error("[uncaughtException]", e?.stack ?? e?.message ?? e);
});

function listen(port: number, attempt = 0): void {
  const server = http.createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e: any) {
      if (!res.headersSent) json(res, { error: e.message }, 500);
    }
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      // 不用 port+1 漂移：CEP 面板写死了 47615，端口变了就连不上。
      // 端口被占 = 已经有一个实例在跑，直接安静退出。
      console.log(`端口 ${port} 已被占用，FontDeck 服务可能已在运行。本次启动退出。`);
      process.exit(0);
    }
    console.error("服务启动失败:", err.message);
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    const idx = loadIndex();

    /* 空闲检查：没人用就自己退，面板下次打开会自动拉起 */
    const idleTimer = setInterval(() => {
      const idle = Date.now() - lastActivity;
      if (idle > IDLE_TIMEOUT_MS) {
        console.log(`空闲 ${Math.round(idle / 60000)} 分钟，服务退出。下次打开面板会自动重启。`);
        process.exit(0);
      }
    }, 60_000);
    idleTimer.unref();
    console.log("");
    console.log(`FontDeck 服务已启动`);
    console.log(`  地址   http://${HOST}:${port}`);
    console.log(`  字体   ${idx.stats.parsedFaces} 个 face / ${families.length} 个家族`);
    console.log(`  用户级 ${idx.stats.byScope.user} / 系统级 ${idx.stats.byScope.system}`);
    console.log(`  UI     http://${HOST}:${port}/`);
    console.log("");

    // 端口文件供 Electron / CEP 发现服务
    try {
      const dir = path.join(process.env.LOCALAPPDATA ?? ROOT, "FontDeck");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "port.json"),
        JSON.stringify({ port, host: HOST, pid: process.pid, at: new Date().toISOString() }, null, 1)
      );
    } catch {
      /* 端口文件写不了不影响服务 */
    }
  });
}

listen(PREFERRED_PORT);
