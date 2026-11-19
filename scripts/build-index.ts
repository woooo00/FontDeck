/**
 * 建立字体索引
 * 用法：npx tsx scripts/build-index.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scanFonts } from "../packages/font-core/src/scan.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outFile = path.join(root, "data", "index.json");

let lastTick = 0;

const index = scanFonts({
  onProgress(done, total, current) {
    const now = Date.now();
    if (now - lastTick < 120 && done !== total) return;
    lastTick = now;
    process.stdout.write(`\r扫描 ${done}/${total}  ${current.slice(0, 40).padEnd(40)}`);
  },
});

process.stdout.write("\r" + " ".repeat(70) + "\r");

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(index, null, 1), "utf-8");

const s = index.stats;
console.log("扫描完成");
console.log("─".repeat(52));
console.log(`文件数        ${s.scannedFiles}`);
console.log(`解析 face 数  ${s.parsedFaces}`);
console.log(`  用户级      ${s.byScope.user}`);
console.log(`  系统级      ${s.byScope.system}`);
console.log(`健康状态`);
console.log(`  正常        ${s.byHealth.ok}`);
console.log(`  未注册      ${s.byHealth.unregistered}`);
console.log(`  文件丢失    ${s.byHealth["missing-file"]}`);
console.log(`  疑似残片    ${s.byHealth.suspicious}`);
console.log(`重复字体      ${s.duplicates}`);
console.log(`解析失败      ${s.errors.length}`);
console.log(`跳过          ${s.skipped.length}`);
console.log(`耗时          ${s.durationMs} ms`);
console.log(`输出          ${outFile}`);

if (s.errors.length) {
  console.log("\n解析失败明细:");
  for (const e of s.errors.slice(0, 8)) {
    console.log(`  ${path.basename(e.file)}: ${e.error.slice(0, 70)}`);
  }
}
