/**
 * 构建全量字形相似度索引。
 *
 * 输出 data/similarity.json：
 *   - 每个字体的密度向量（base64，落盘用）
 *   - 字形指纹（用于重复检测）
 *   - top-N 最相似的其他字体（已按分数排序）
 *
 * 分组比较：有 CJK 的和有 CJK 的比，纯西文的和纯西文的比。
 * 跨组比没有意义（「永」和「R」本来就不同）。
 */
import fs from "node:fs";
import crypto from "node:crypto";
import {
  BLOCKS,
  GRID,
  signatureForFace,
  signatureSimilarity,
  faceFingerprint,
  densityToBase64,
  type FontSignature,
} from "../packages/font-core/src/similarity.js";

interface Face {
  id: string;
  filePath: string;
  collectionIndex: number;
  postScriptName: string;
  family: string;
  familyZh?: string;
  hasCJK: boolean;
  glyphCount: number;
  health: string;
  scope: string;
  weightClass: number;
  subfamily: string;
}

/** 字形数太少的是网页抓下来的子集碎片，代表不了整款字体，不参与相似度 */
const MIN_GLYPHS = 500;
/** 每个字体保留几个邻居 */
const TOP_N = 8;

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const all: Face[] = idx.faces;

const candidates = all.filter(
  (f) => f.health === "ok" && f.glyphCount >= MIN_GLYPHS && f.postScriptName
);

console.log(`总 face ${all.length}，参与相似度计算 ${candidates.length}`);
console.log(`  (排除：健康状态非 ok、字形数 < ${MIN_GLYPHS}、无 PostScript 名)`);

/* ---------- 1. 算签名 ---------- */

const byId = new Map(candidates.map((f) => [f.id, f]));

const t0 = Date.now();
const sigs = new Map<string, FontSignature>();
const fps = new Map<string, string>();
const fileHashes = new Map<string, string>(); // filePath -> sha256
let failed = 0;

function fileHash(p: string): string | null {
  const cached = fileHashes.get(p);
  if (cached) return cached;
  try {
    const h = crypto.createHash("sha256");
    h.update(fs.readFileSync(p));
    const hex = h.digest("hex");
    fileHashes.set(p, hex);
    return hex;
  } catch {
    return null;
  }
}

for (let i = 0; i < candidates.length; i++) {
  const f = candidates[i];
  const sig = signatureForFace(f.filePath, f.collectionIndex, f.hasCJK);
  if (!sig) {
    failed++;
    continue;
  }
  sigs.set(f.id, sig);
  const fp = faceFingerprint(f.filePath, f.collectionIndex);
  if (fp) fps.set(f.id, fp);

  if ((i + 1) % 100 === 0) {
    process.stdout.write(`  已处理 ${i + 1}/${candidates.length}\r`);
  }
}
console.log(`\n签名完成 ${sigs.size} 个，失败 ${failed} 个，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

/* ---------- 2. 重复检测：文件哈希优先，字形指纹辅助 ---------- */

/*
 * 用文件 SHA-256 而不是字形指纹做主判据。
 * 字形指纹会误报：微软那批 LeelawadeeUI / NirmalaUI / SegoeUI 共享拉丁字形，
 * 只比样本字会把它们判成同款，但它们是不同字体。
 * 文件哈希是「同一份数据」的严格定义，不会错。
 */
const byHash = new Map<string, string[]>();
for (const id of sigs.keys()) {
  const f = byId.get(id);
  if (!f) continue;
  const h = fileHash(f.filePath);
  if (!h) continue;
  const arr = byHash.get(h) ?? [];
  arr.push(id);
  byHash.set(h, arr);
}

const dupHashGroups = [...byHash.values()].filter((g) => g.length > 1);
console.log(`文件内容完全相同（SHA-256 一致）的组：${dupHashGroups.length} 组`);

const dupFpGroups = (() => {
  const m = new Map<string, string[]>();
  for (const [id, fp] of fps) {
    const arr = m.get(fp) ?? [];
    arr.push(id);
    m.set(fp, arr);
  }
  return [...m.values()].filter((g) => g.length > 1);
})();
console.log(`字形指纹相同的组（辅助参考）：${dupFpGroups.length} 组`);

/* ---------- 3. 组内两两比较 ---------- */

const t1 = Date.now();
const items: Record<string, any> = {};
for (const [id, sig] of sigs) {
  items[id] = {
    ps: byId.get(id)!.postScriptName,
    family: byId.get(id)!.familyZh || byId.get(id)!.family,
    sub: byId.get(id)!.subfamily,
    weight: byId.get(id)!.weightClass,
    cjk: byId.get(id)!.hasCJK,
    samples: sig.samples,
    density: densityToBase64(sig.density, sig.samples.length),
    fingerprint: fps.get(id) ?? null,
    glyphs: byId.get(id)!.glyphCount,
    fileHash: fileHash(byId.get(id)!.filePath),
    neighbors: [] as { id: string; score: number }[],
  };
}

const cjkIds = [...sigs.keys()].filter((id) => byId.get(id)!.hasCJK);
const latinIds = [...sigs.keys()].filter((id) => !byId.get(id)!.hasCJK);
console.log(`\n分组：CJK ${cjkIds.length} 个，西文 ${latinIds.length} 个`);
console.log(`比较次数：CJK ${(cjkIds.length * (cjkIds.length - 1)) / 2}，西文 ${(latinIds.length * (latinIds.length - 1)) / 2}`);

function compareGroup(ids: string[]) {
  for (let i = 0; i < ids.length; i++) {
    const a = sigs.get(ids[i])!;
    const list: { id: string; score: number }[] = [];
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      const b = sigs.get(ids[j])!;
      const s = signatureSimilarity(a, b, 0); // 纯密度余弦：实测分离度最好
      if (s > 0) list.push({ id: ids[j], score: s });
    }
    list.sort((x, y) => y.score - x.score);
    items[ids[i]].neighbors = list.slice(0, TOP_N).map((n) => ({
      id: n.id,
      score: Math.round(n.score * 1000) / 1000,
    }));
  }
}

compareGroup(cjkIds);
compareGroup(latinIds);
console.log(`比较耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);

/* ---------- 4. 落盘 ---------- */

const out = {
  generatedAt: new Date().toISOString(),
  grid: GRID,
  blocks: BLOCKS,
  iouWeight: 0,
  samples: { cjk: sigs.get(cjkIds[0])?.samples ?? [], latin: sigs.get(latinIds[0])?.samples ?? [] },
  stats: {
    total: all.length,
    counted: sigs.size,
    failed,
    cjk: cjkIds.length,
    latin: latinIds.length,
    dupFileHashGroups: dupHashGroups.length,
    dupFingerprintGroups: dupFpGroups.length,
  },
  items,
};

fs.writeFileSync("data/similarity.json", JSON.stringify(out), "utf-8");
const size = fs.statSync("data/similarity.json").size;
console.log(`\n已写入 data/similarity.json  ${(size / 1024).toFixed(0)} KB`);
console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

/* ---------- 5. 抽样验证 ---------- */

console.log("\n抽样：几个字体的最近邻");
for (const ps of ["MicrosoftYaHei", "SimSun", "DengXian", "KaiTi"]) {
  const f = candidates.find((x) => x.postScriptName === ps);
  if (!f) continue;
  const it = items[f.id];
  if (!it) continue;
  const names = it.neighbors
    .slice(0, 4)
    .map((n: any) => `${items[n.id]?.ps ?? n.id} ${n.score.toFixed(3)}`)
    .join("  |  ");
  console.log(`  ${ps}`);
  console.log(`     ${names}`);
}
