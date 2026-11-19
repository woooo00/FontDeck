/**
 * 验证相似度引擎：把一个字的位图打印成 ASCII，肉眼确认形状对不对；
 * 再算几组已知关系的字体相似度，看分数是否合理。
 */
import fs from "node:fs";
import {
  BLOCKS,
  signatureForFace,
  signatureSimilarity,
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
}

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const faces: Face[] = idx.faces;

function pick(pred: (f: Face) => boolean, label: string): Face | undefined {
  const f = faces.find(pred);
  if (!f) console.log(`  (找不到 ${label})`);
  return f;
}

/* 挑几个有代表性的中文字体。必须 glyphCount 够大——
   机器上有一批网页抓下来的子集字体（只有几十个字形），它们代表不了整款字体。 */
const MIN_GLYPHS = 1000;
const cjkOk = (f: Face) => f.hasCJK && f.glyphCount >= MIN_GLYPHS;

const targets: { face: Face | undefined; label: string }[] = [
  { face: pick((f) => cjkOk(f) && /^MicrosoftYaHei$/i.test(f.postScriptName), "微软雅黑 Regular"), label: "雅黑R" },
  { face: pick((f) => cjkOk(f) && /^MicrosoftYaHei-Bold$/i.test(f.postScriptName), "微软雅黑 Bold"), label: "雅黑B" },
  { face: pick((f) => cjkOk(f) && /^DengXian$/i.test(f.postScriptName), "等线 Regular"), label: "等线R" },
  { face: pick((f) => cjkOk(f) && /^DengXian-Bold$/i.test(f.postScriptName), "等线 Bold"), label: "等线B" },
  { face: pick((f) => cjkOk(f) && /^SourceHanSansCNBold|^SourceHanSansCN-Bold$/i.test(f.postScriptName), "思源黑 Bold"), label: "思源B" },
  { face: pick((f) => cjkOk(f) && /^SimSun$/i.test(f.postScriptName), "宋体 SimSun"), label: "宋体" },
  { face: pick((f) => cjkOk(f) && /KaiTi|simkai/i.test(f.postScriptName), "楷体"), label: "楷体" },
];

function printMask(d: Float32Array | null, title: string) {
  if (!d) {
    console.log(title + " => 无数据");
    return;
  }
  console.log(title);
  for (let y = 0; y < BLOCKS; y++) {
    let line = "";
    for (let x = 0; x < BLOCKS; x++) {
      const v = d[y * BLOCKS + x];
      line += v > 0.5 ? "█" : v > 0.25 ? "▓" : v > 0.05 ? "░" : "·";
    }
    console.log("  " + line);
  }
  console.log("");
}

const sigs: { label: string; sig: FontSignature }[] = [];

for (const t of targets) {
  if (!t.face) continue;
  const sig = signatureForFace(t.face.filePath, t.face.collectionIndex, t.face.hasCJK);
  if (!sig) {
    console.log(`${t.label}: 生成签名失败`);
    continue;
  }
  sigs.push({ label: t.label, sig });
  console.log(
    `${t.label}  [${t.face.postScriptName}]  有效字形 ${sig.valid}/${sig.samples.length}`
  );
}

console.log("");
/* 打印前两个字体的「永」位图，肉眼检查 */
for (const s of sigs.slice(0, 2)) {
  printMask(s.sig.density[0], `【${s.label}】的「${s.sig.samples[0]}」`);
}

/* 相似度矩阵 */
console.log("相似度矩阵");
const names = sigs.map((s) => s.label);
const pad = 10;
console.log(" ".repeat(pad) + names.map((n) => n.padEnd(pad)).join(""));
for (let i = 0; i < sigs.length; i++) {
  let row = names[i].padEnd(pad);
  for (let j = 0; j < sigs.length; j++) {
    const v = signatureSimilarity(sigs[i].sig, sigs[j].sig);
    row += (i === j ? "—" : v.toFixed(3)).padEnd(pad);
  }
  console.log(row);
}
