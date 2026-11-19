/** 全量预览可用性体检：找出无法提取轮廓的字体 */
import fs from "node:fs";
import path from "node:path";
import { renderTextSvg } from "../packages/font-core/src/preview.js";

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const faces: any[] = idx.faces.filter((f: any) => f.health !== "missing-file");

let ok = 0;
const failed: any[] = [];
const t0 = Date.now();

for (const f of faces) {
  const text = f.hasCJK ? "永和九年 Aa" : "Aa Bb 123";
  let svg: string | null = null;
  try {
    svg = renderTextSvg(f.filePath, f.collectionIndex, {
      text,
      fontSize: 32,
      padding: 0,
    });
  } catch (e: any) {
    failed.push({ ...f, reason: "throw: " + e.message });
    continue;
  }
  if (svg) ok++;
  else failed.push({ ...f, reason: "returned null" });
}

const ms = Date.now() - t0;
console.log(`总计 ${faces.length}，成功 ${ok}，失败 ${failed.length}，耗时 ${ms}ms`);
console.log(`平均 ${(ms / faces.length).toFixed(1)}ms/个`);
console.log();

const byFormat: Record<string, number> = {};
const byFamily = new Map<string, any[]>();
for (const f of failed) {
  byFormat[f.format] = (byFormat[f.format] ?? 0) + 1;
  const key = f.familyZh || f.family;
  const arr = byFamily.get(key) ?? [];
  arr.push(f);
  byFamily.set(key, arr);
}
console.log("按格式:", byFormat);
console.log(`涉及 ${byFamily.size} 个家族`);
console.log();
for (const [fam, arr] of [...byFamily.entries()].slice(0, 12)) {
  console.log(`  ${fam}  (${arr.length})  ${path.basename(arr[0].filePath)}`);
}

fs.writeFileSync(
  "data/preview-failures.json",
  JSON.stringify(failed.map((f) => ({
    id: f.id,
    family: f.family,
    familyZh: f.familyZh,
    postScriptName: f.postScriptName,
    format: f.format,
    file: f.filePath,
    reason: f.reason,
  })), null, 1),
  "utf-8"
);
console.log("\n明细: data/preview-failures.json");
