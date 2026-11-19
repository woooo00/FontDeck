/**
 * 家族归一化规则的影响评估。
 *
 * 只做一件事：用三套规则分别分组，把家族数量和「合并幅度最大的组」打出来，
 * 人工检查合并是否合理。规则不确定就不该往产品里塞。
 *
 *   A. 现状：familyZh || family，小写去空白
 *   B. 去款式后缀（Regular/Bold/Light…）+ 尾部数字
 *   C. B + 去地区后缀（SC/TC/HK/CN/JP/KR…）
 *   D. C + 去载体后缀（UI/VF/Std/Pro）
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
  category: string;
}

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const faces: Face[] = idx.faces.filter((f: Face) => !!f.postScriptName);

const STYLE = [
  "regular", "bold", "light", "medium", "italic", "oblique", "book", "heavy",
  "black", "thin", "semibold", "extrabold", "ultralight", "ultrabold",
  "extralight", "demibold", "normal", "roman", "plain",
];
const REGION = ["sc", "tc", "hk", "mo", "tw", "cn", "jp", "kr", "gb"];
const CARRIER = ["vf", "ui", "std", "pro"];

function strip(name: string, tokens: string[], stripDigits: boolean): string {
  let s = (name || "").toLowerCase().trim().replace(/[\s_\-.·]+/g, "");
  if (!s) return "";
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 12) {
    changed = false;
    if (stripDigits) {
      const n = s.replace(/\d+$/, "");
      if (n !== s && n.length >= 3) {
        s = n;
        changed = true;
        continue;
      }
    }
    // 长 token 优先，避免 "semibold" 先被 "bold" 切掉剩 "semi"
    for (const t of [...tokens].sort((a, b) => b.length - a.length)) {
      if (s.endsWith(t) && s.length - t.length >= 3) {
        s = s.slice(0, s.length - t.length);
        changed = true;
        break;
      }
    }
  }
  return s;
}

type Rule = { label: string; key: (f: Face) => string };

const RULES: Rule[] = [
  {
    label: "A 现状（不归一化）",
    key: (f) => (f.familyZh || f.family || f.postScriptName).trim().toLowerCase(),
  },
  {
    label: "B 去款式后缀 + 数字",
    key: (f) =>
      strip(f.familyZh || f.family || f.postScriptName, STYLE, true) ||
      (f.familyZh || f.family).toLowerCase(),
  },
  {
    label: "C = B + 去地区后缀",
    key: (f) =>
      strip(f.familyZh || f.family || f.postScriptName, [...STYLE, ...REGION], true) ||
      (f.familyZh || f.family).toLowerCase(),
  },
  {
    label: "D = C + 去载体后缀",
    key: (f) =>
      strip(
        f.familyZh || f.family || f.postScriptName,
        [...STYLE, ...REGION, ...CARRIER],
        true
      ) || (f.familyZh || f.family).toLowerCase(),
  },
];

for (const rule of RULES) {
  const map = new Map<string, Face[]>();
  for (const f of faces) {
    const k = rule.key(f);
    const arr = map.get(k);
    if (arr) arr.push(f);
    else map.set(k, [f]);
  }
  const sizes = [...map.values()].map((v) => v.length).sort((a, b) => b - a);
  const big = sizes.filter((n) => n >= 8).length;
  console.log(
    `${rule.label.padEnd(22)} 家族 ${String(map.size).padStart(4)} 个` +
      `  |  单家族 face 中位 ${sizes[Math.floor(sizes.length / 2)]}` +
      `  最大 ${sizes[0]}  |  ≥8 个 face 的家族 ${big} 个`
  );
}

/* ---------- 详细对比 C 规则下的合并情况 ---------- */

const baseMap = new Map<string, Face[]>();
const cRule = RULES[2];
for (const f of faces) {
  const k = cRule.key(f);
  const arr = baseMap.get(k);
  if (arr) arr.push(f);
  else baseMap.set(k, [f]);
}

console.log("\n=== C 规则下，face 数最多的 18 个家族 ===");
const sorted = [...baseMap.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [key, list] of sorted.slice(0, 18)) {
  const names = [...new Set(list.map((f) => f.familyZh || f.family))];
  const subs = [...new Set(list.map((f) => f.subfamily))];
  console.log(
    `\n  [${key}] ${list.length} 个 face` +
      (names.length > 4
        ? `  ← ${names.length} 种写法`
        : `  ← ${names.join(" / ")}`)
  );
  if (names.length > 1) console.log(`     写法: ${names.join(" | ")}`);
  console.log(`     字重: ${subs.slice(0, 14).join(", ")}${subs.length > 14 ? " …" : ""}`);
}

/* ---------- 检查危险合并：把明显不同的字体合到一起 ---------- */

console.log("\n=== 需要人工确认的合并（同 key 下家族名差异大） ===");
let suspicious = 0;
for (const [key, list] of sorted) {
  if (list.length < 2) continue;
  const names = [...new Set(list.map((f) => f.familyZh || f.family))];
  if (names.length < 2) continue;
  // 用「去掉非字母数字后是否有公共前缀」粗判
  const norm = names.map((n) => n.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, ""));
  const shortest = norm.reduce((a, b) => (a.length <= b.length ? a : b));
  let common = 0;
  for (let i = 0; i < shortest.length; i++) {
    if (norm.every((n) => n[i] === shortest[i])) common++;
    else break;
  }
  if (common < 4) {
    suspicious++;
    console.log(`  [${key}] ${names.join("  +  ")}`);
  }
}
console.log(`  共 ${suspicious} 组可疑合并`);
