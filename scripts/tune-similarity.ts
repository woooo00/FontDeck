/**
 * 扫 IoU 权重，找同款/同族/跨族三档分得最开的组合。
 *
 * 分组：
 *   同款   —— 同一字体不同字重（雅黑R-雅黑B、等线R-等线B）
 *   同族   —— 都是黑体但不是同款（雅黑/等线/思源之间）
 *   跨族   —— 黑体 vs 宋体、vs 楷体
 *
 * 好的权重应该让 同款 > 同族 > 跨族，且三档之间留出明显间隔。
 */
import fs from "node:fs";
import {
  signatureForFace,
  signatureSimilarity,
  type FontSignature,
} from "../packages/font-core/src/similarity.js";

interface Face {
  filePath: string;
  collectionIndex: number;
  postScriptName: string;
  hasCJK: boolean;
  glyphCount: number;
}

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const faces: Face[] = idx.faces;

const cjkOk = (f: Face) => f.hasCJK && f.glyphCount >= 1000;

function find(re: RegExp): Face | undefined {
  return faces.find((f) => cjkOk(f) && re.test(f.postScriptName));
}

const groups: Record<string, Face | undefined> = {
  yaheiR: find(/^MicrosoftYaHei$/i),
  yaheiB: find(/^MicrosoftYaHei-Bold$/i),
  dengR: find(/^DengXian$/i),
  dengB: find(/^DengXian-Bold$/i),
  sourceB: find(/^SourceHanSansCNBold|^SourceHanSansCN-Bold$/i),
  simsun: find(/^SimSun$/i),
  kaiti: find(/KaiTi|simkai/i),
};

const sigs: Record<string, FontSignature> = {};
for (const [k, f] of Object.entries(groups)) {
  if (!f) {
    console.log(`缺字体: ${k}`);
    continue;
  }
  const s = signatureForFace(f.filePath, f.collectionIndex, f.hasCJK);
  if (s) sigs[k] = s;
}

const sameFont: [string, string][] = [
  ["yaheiR", "yaheiB"],
  ["dengR", "dengB"],
];
const sameStyle: [string, string][] = [
  ["yaheiR", "dengR"],
  ["yaheiR", "sourceB"],
  ["yaheiB", "sourceB"],
  ["dengR", "sourceB"],
];
const crossStyle: [string, string][] = [];
for (const a of ["yaheiR", "yaheiB", "dengR", "dengB", "sourceB"]) {
  for (const b of ["simsun", "kaiti"]) {
    if (sigs[a] && sigs[b]) crossStyle.push([a, b]);
  }
}

function avg(pairs: [string, string][], w: number): number {
  const vals: number[] = [];
  for (const [a, b] of pairs) {
    if (!sigs[a] || !sigs[b]) continue;
    vals.push(signatureSimilarity(sigs[a], sigs[b], w));
  }
  return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : NaN;
}

console.log("iouWeight   同款    同族    跨族   同款-同族  同族-跨族");
console.log("-".repeat(58));
let best = { w: 0, gap: -1 };
for (let w = 0; w <= 1.0001; w += 0.1) {
  const a = avg(sameFont, w);
  const b = avg(sameStyle, w);
  const c = avg(crossStyle, w);
  const gap1 = a - b;
  const gap2 = b - c;
  // 用两个间隔的最小值作为分离度，保证三档都分开
  const score = Math.min(gap1, gap2);
  console.log(
    `${w.toFixed(1)}       ${a.toFixed(3)}  ${b.toFixed(3)}  ${c.toFixed(3)}   ` +
      `${gap1 >= 0 ? "+" : ""}${gap1.toFixed(3)}     ${gap2 >= 0 ? "+" : ""}${gap2.toFixed(3)}`
  );
  if (score > best.gap) best = { w, gap: score };
}

console.log("-".repeat(58));
console.log(`最优权重 iouWeight = ${best.w.toFixed(1)}，最小间隔 ${best.gap.toFixed(3)}`);
