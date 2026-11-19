/**
 * 诊断现状分组到底哪里错了。
 *
 * 归一化只是手段，真正要回答的是：现在这 327 个家族里，哪些本该是一家人却被拆开了？
 * 用「去掉款式/地区 token 后的英文家族名」作为基准，反查跨 key 的拆分。
 */
import fs from "node:fs";

interface Face {
  id: string;
  postScriptName: string;
  family: string;
  familyZh?: string;
  subfamily: string;
  hasCJK: boolean;
  glyphCount: number;
  health: string;
}

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const faces: Face[] = idx.faces.filter((f: Face) => !!f.postScriptName);

/* ---------------- token 归一化 ---------------- */

const STYLE_TOKENS = new Set([
  "regular", "bold", "light", "medium", "italic", "oblique", "book", "heavy",
  "black", "thin", "semibold", "extrabold", "ultralight", "ultrabold",
  "extralight", "demibold", "normal", "roman", "plain", "display", "text",
]);
const REGION_TOKENS = new Set(["sc", "tc", "hk", "mo", "tw", "cn", "jp", "kr", "gb"]);
const CARRIER_TOKENS = new Set(["vf", "ui", "std", "pro", "var"]);

/** 按分隔符 + 驼峰边界切成 token，保留原始大小写以便还原显示名 */
function tokenize(name: string): string[] {
  const spaced = name
    // 小写→大写 处切
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    // 缩写紧跟驼峰处切：SCRegular → SC Regular
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[\s_\-.·]+/g, " ")
    .trim();
  return spaced ? spaced.split(" ") : [];
}

function stripTokens(tokens: string[], drop: Set<string>): string[] {
  const out = [...tokens];
  while (out.length > 1) {
    const last = out[out.length - 1];
    const low = last.toLowerCase();
    // 纯数字尾巴（如 "Avenir 45 Book" 的 45）
    if (/^\d+$/.test(low)) {
      out.pop();
      continue;
    }
    if (drop.has(low)) {
      out.pop();
      continue;
    }
    break;
  }
  return out;
}

function normKey(tokens: string[]): string {
  return tokens.join("").toLowerCase();
}

/* ---------------- A：现状 key ---------------- */

const currentKey = (f: Face) =>
  (f.familyZh || f.family || f.postScriptName).trim().toLowerCase();

/* ---------------- B：英文名 token 归一化后的 key ---------------- */

function englishKey(f: Face, mode: "style" | "style+region+carrier"): string {
  const toks = tokenize(f.family || f.postScriptName);
  const drop =
    mode === "style"
      ? STYLE_TOKENS
      : new Set([...STYLE_TOKENS, ...REGION_TOKENS, ...CARRIER_TOKENS]);
  return normKey(stripTokens(toks, drop));
}

/* ---------------- 反查：同一英文家族被拆到几个现状 key ---------------- */

function analyze(mode: "style" | "style+region+carrier", label: string) {
  const byEnglish = new Map<string, Face[]>();
  for (const f of faces) {
    const k = englishKey(f, mode);
    if (!k) continue;
    const arr = byEnglish.get(k);
    if (arr) arr.push(f);
    else byEnglish.set(k, [f]);
  }

  const splits: { english: string; keys: Map<string, Face[]> }[] = [];
  for (const [k, list] of byEnglish) {
    const keys = new Map<string, Face[]>();
    for (const f of list) {
      const ck = currentKey(f);
      const arr = keys.get(ck);
      if (arr) arr.push(f);
      else keys.set(ck, [f]);
    }
    if (keys.size > 1) splits.push({ english: k, keys });
  }

  console.log(`\n### ${label}`);
  console.log(`同一英文家族被拆成多个现有 key 的：${splits.length} 组`);
  const totalExtra = splits.reduce((s, x) => s + x.keys.size - 1, 0);
  console.log(`若合并可减少家族数：${totalExtra} 个（327 → ${327 - totalExtra}）`);

  splits.sort((a, b) => b.keys.size - a.keys.size);
  for (const s of splits.slice(0, 25)) {
    const parts = [...s.keys.entries()].map(
      ([k, list]) => `${k}[${list.length}:${list.map((f) => f.subfamily).join("/")}]`
    );
    console.log(`  ${s.english}`);
    console.log(`     ${parts.join("  |  ")}`);
  }
  if (splits.length > 25) console.log(`  ...还有 ${splits.length - 25} 组`);
}

analyze("style", "B 只去款式 token");
analyze("style+region+carrier", "C 去款式 + 地区 + 载体 token");

/* ---------------- 反向检查：归一化是否把不同字体合到一起 ---------------- */

console.log("\n### 反向检查：归一化后同 key 但英文名不同的（潜在误合）");
const byKey = new Map<string, Set<string>>();
for (const f of faces) {
  const k = englishKey(f, "style+region+carrier");
  if (!k) continue;
  const set = byKey.get(k) ?? new Set<string>();
  set.add(f.family);
  byKey.set(k, set);
}
let n = 0;
for (const [k, names] of byKey) {
  if (names.size > 1) {
    n++;
    console.log(`  [${k}] ${[...names].join("  +  ")}`);
  }
}
console.log(`  共 ${n} 组`);
