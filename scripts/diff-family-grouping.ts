/**
 * 对比新旧家族归键：列全每个「合并」和每个「拆分」，逐条人工确认。
 * 只输出差异，不给结论 —— 结论由人看数据后定。
 */
import fs from "node:fs";
import { familyKeyOf } from "../packages/font-core/src/family.js";

interface Face {
  id: string;
  postScriptName: string;
  family: string;
  familyZh?: string;
  subfamily: string;
  hasCJK: boolean;
  glyphCount: number;
}

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const faces: Face[] = idx.faces.filter((f: Face) => !!f.postScriptName);

const oldKey = (f: Face) =>
  (f.familyZh || f.family || f.postScriptName).trim().toLowerCase();
const newKey = (f: Face) => familyKeyOf(f.family, f.postScriptName);

const oldGroups = new Map<string, Face[]>();
const newGroups = new Map<string, Face[]>();
for (const f of faces) {
  for (const [map, k] of [
    [oldGroups, oldKey(f)],
    [newGroups, newKey(f)],
  ] as [Map<string, Face[]>, string][]) {
    const arr = map.get(k);
    if (arr) arr.push(f);
    else map.set(k, [f]);
  }
}

console.log(`旧方案 ${oldGroups.size} 个家族，新方案 ${newGroups.size} 个家族`);

/* ---------- 合并：多个旧 key 进入同一个新 key ---------- */

console.log("\n===== 合并（原本分开，现在归一家） =====");
let mergeCount = 0;
const merges: string[] = [];
for (const [nk, list] of newGroups) {
  const oldKeys = new Set(list.map(oldKey));
  if (oldKeys.size < 2) continue;
  mergeCount++;
  const detail = [...oldKeys]
    .map((ok) => {
      const sub = list
        .filter((f) => oldKey(f) === ok)
        .map((f) => f.subfamily);
      return `"${ok}"[${sub.join(",")}]`;
    })
    .join("  +  ");
  merges.push(`  [${nk}]  ${detail}`);
}
console.log(merges.sort().join("\n"));
console.log(`  合计 ${mergeCount} 组`);

/* ---------- 拆分：同一个旧 key 被分到多个新 key ---------- */

console.log("\n===== 拆分（原本一家，现在分开） =====");
let splitCount = 0;
const splits: string[] = [];
for (const [ok, list] of oldGroups) {
  const nks = new Set(list.map(newKey));
  if (nks.size < 2) continue;
  splitCount++;
  const detail = [...nks]
    .map((nk) => {
      const sub = list.filter((f) => newKey(f) === nk).map((f) => f.subfamily);
      return `[${nk}][${sub.join(",")}]`;
    })
    .join("  |  ");
  splits.push(`  "${ok}"  →  ${detail}`);
}
console.log(splits.sort().join("\n") || "  （无）");
console.log(`  合计 ${splitCount} 组`);

/* ---------- 合并后的家族大小 ---------- */

const sizes = [...newGroups.values()].map((v) => v.length).sort((a, b) => b - a);
console.log(
  `\n新方案家族规模：中位 ${sizes[Math.floor(sizes.length / 2)]}，最大 ${sizes[0]}，单 face 家族 ${sizes.filter((n) => n === 1).length} 个`
);
console.log("\n新方案下 face 数最多的 12 个家族：");
[...newGroups.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 12)
  .forEach(([k, list]) => {
    const names = [...new Set(list.map((f) => f.familyZh || f.family))];
    console.log(`  [${k}] ${list.length} 个  ← ${names.slice(0, 4).join(" / ")}${names.length > 4 ? " …" : ""}`);
  });
