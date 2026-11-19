/**
 * 生成服务端直读的轻量索引 data/neighbors.json。
 *
 * similarity.json 有 1MB 的密度向量，是给「重算」用的，服务端不需要。
 * 这里做两件事并落成一个小文件：
 *
 *   byId       每个字体的 top-8 相似家族（服务端零计算，直接查表）
 *   dupGroups  文件内容完全相同的分组（SHA-256），覆盖全部 face
 *
 * 两个关键取舍：
 *
 * 1) 邻居必须排除同家族并去重到「家族」级别。
 *    Montserrat 一款字体有 29 个 face，不排除的话它的 top-8 全是自己的字重，
 *    而自己的字重已经在详情页的「字重列表」里了，再推荐一遍毫无意义。
 *    所以要的是「另外 8 个家族里最像的」。
 *
 * 2) 重复检测用文件哈希，不用字形指纹。
 *    微软那批 LeelawadeeUI / NirmalaUI / SegoeUI 共享拉丁字形，
 *    只比样本字会把它们判成同款，但它们是不同字体。哈希不会错。
 */
import fs from "node:fs";
import crypto from "node:crypto";

import {
  densityFromBase64,
  signatureSimilarity,
  type FontSignature,
} from "../packages/font-core/src/similarity.js";
import { familyKeyOf } from "../packages/font-core/src/family.js";

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const sim = JSON.parse(fs.readFileSync("data/similarity.json", "utf-8"));

const faces: {
  id: string;
  filePath: string;
  collectionIndex: number;
  postScriptName: string;
  family: string;
  familyZh?: string;
  hasCJK: boolean;
  health: string;
}[] = idx.faces;

/** 每个字体保留几个不同家族的邻居 */
const TOP_N = 8;

/* ------------------------------------------------------------------ */
/* 1. 邻居：从已落盘的密度向量重算，按家族过滤去重                        */
/* ------------------------------------------------------------------ */

interface Entry {
  id: string;
  familyKey: string;
  family: string;
  familyZh?: string;
  cjk: boolean;
  score: number;
  sig: FontSignature;
}

const entries: Entry[] = [];
for (const [id, item] of Object.entries<any>(sim.items)) {
  if (!item.density || !item.samples?.length) continue;
  const density = densityFromBase64(item.density, item.samples.length);
  const f = faces.find((x) => x.id === id);
  entries.push({
    id,
    familyKey: familyKeyOf(item.family || item.ps, item.ps),
    family: f?.family ?? item.family ?? "",
    familyZh: f?.familyZh,
    cjk: !!item.cjk,
    score: 0,
    sig: { samples: item.samples, density, valid: density.filter(Boolean).length },
  });
}
console.log(`载入 ${entries.length} 个签名，每个含 ${entries[0]?.sig.samples.length ?? 0} 个样本字`);

const t0 = Date.now();
const byId: Record<string, { id: string; s: number }[]> = {};

for (const a of entries) {
  // 只在同语种内比较：拿「永」跟「R」比没有意义
  const pool = entries.filter((b) => b.id !== a.id && b.cjk === a.cjk);

  // 同一家族只留分数最高的那个代表
  const bestPerFamily = new Map<string, { id: string; s: number }>();

  for (const b of pool) {
    const s = signatureSimilarity(a.sig, b.sig, 0);
    if (s <= 0) continue;
    const cur = bestPerFamily.get(b.familyKey);
    if (!cur || s > cur.s) bestPerFamily.set(b.familyKey, { id: b.id, s });
  }

  const list = [...bestPerFamily.entries()]
    .filter(([fk]) => fk !== a.familyKey)
    .map(([, v]) => ({ id: v.id, s: Math.round(v.s * 1000) / 1000 }))
    .sort((x, y) => y.s - x.s)
    .slice(0, TOP_N);

  if (list.length) byId[a.id] = list;
}

const withNeighbors = Object.keys(byId).length;
console.log(
  `邻居计算完成：${withNeighbors} 个字体有推荐，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`
);

/* ------------------------------------------------------------------ */
/* 2. 文件哈希：按 face 算，不能按文件算                                 */
/* ------------------------------------------------------------------ */

/*
 * .ttc 集合字体一个文件装着十几个 face（Avenir 那个 ttc 装了 12 个），
 * 只按文件哈希会把它们全部判成「互相重复」——那是误报，它们本来就是不同的字重。
 * 所以 key 带上集合索引：同一个 ttc 里不同 face 各自独立，
 * 但同一个 ttc 被复制成两份时，对应 face 依然能配上。
 */
const hashByPath = new Map<string, string>();
function fileHash(p: string): string | null {
  const cached = hashByPath.get(p);
  if (cached) return cached;
  try {
    const h = crypto.createHash("sha256");
    h.update(fs.readFileSync(p));
    const hex = h.digest("hex");
    hashByPath.set(p, hex);
    return hex;
  } catch {
    return null;
  }
}

const t1 = Date.now();
const hashById: Record<string, string> = {};
const byHash = new Map<string, string[]>();
let hashed = 0;

for (const f of faces) {
  if (f.health === "missing-file") continue;
  const fileH = fileHash(f.filePath);
  if (!fileH) continue;
  const faceKey = f.collectionIndex > 0 ? `${fileH}#${f.collectionIndex}` : fileH;
  hashById[f.id] = faceKey;
  const arr = byHash.get(faceKey);
  if (arr) arr.push(f.id);
  else byHash.set(faceKey, [f.id]);
  hashed++;
}
console.log(`哈希 ${hashed} 个 face 的文件，耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);

const dupGroups = [...byHash.values()].filter((g) => g.length > 1);
console.log(
  `文件内容完全相同：${dupGroups.length} 组，涉及 ${dupGroups.reduce((s, g) => s + g.length, 0)} 个 face`
);

/* ------------------------------------------------------------------ */
/* 3. 落盘                                                            */
/* ------------------------------------------------------------------ */

const out = {
  generatedAt: new Date().toISOString(),
  stats: {
    similar: withNeighbors,
    hashed,
    dupGroups: dupGroups.length,
  },
  byId,
  hashById,
  dupGroups,
};

fs.writeFileSync("data/neighbors.json", JSON.stringify(out), "utf-8");
const size = fs.statSync("data/neighbors.json").size;
console.log(`已写入 data/neighbors.json  ${(size / 1024).toFixed(0)} KB`);

/* ------------------------------------------------------------------ */
/* 4. 抽样自查                                                        */
/* ------------------------------------------------------------------ */

const byIdMap = new Map(faces.map((f) => [f.id, f]));
const nameOf = (id: string) => {
  const f = byIdMap.get(id);
  return f ? f.postScriptName : id;
};

console.log("\n抽样：几个字体的最近邻（应全部是不同家族）");
for (const ps of ["SimSun", "KaiTi", "MicrosoftYaHei", "Montserrat-Regular", "DengXian"]) {
  const f = faces.find((x) => x.postScriptName === ps);
  if (!f) continue;
  const list = byId[f.id];
  if (!list) {
    console.log(`  ${ps} → 无推荐`);
    continue;
  }
  console.log(`  ${ps}`);
  console.log(
    "     " +
      list.map((n) => `${nameOf(n.id)} ${n.s.toFixed(3)}`).join("  |  ")
  );
}

console.log("\n重复组（同名不同文件的才是真正值得看的）：");
for (const g of dupGroups.slice(0, 6)) {
  const info = g.map((id) => {
    const f = byIdMap.get(id)!;
    return `${f.postScriptName}(${f.filePath.split("\\").pop()})`;
  });
  console.log("  " + info.join("  =  "));
}
