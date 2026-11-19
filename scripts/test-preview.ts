/** 预览渲染冒烟测试 */
import fs from "node:fs";
import { renderTextSvg } from "../packages/font-core/src/preview.js";

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));

const picks: [string, (f: any) => boolean][] = [
  ["中文字体", (f) => f.familyZh === "阿里巴巴普惠体"],
  ["系统中文", (f) => f.postScriptName === "DengXian-Light"],
  ["变量字体", (f) => f.isVariable && f.hasCJK],
  ["西文衬线", (f) => f.category === "serif" && f.hasLatin && !f.hasCJK],
  ["等宽", (f) => f.isFixedPitch && f.hasLatin],
];

for (const [label, pred] of picks) {
  const f = idx.faces.find(pred);
  if (!f) {
    console.log(`${label}: 未找到样例`);
    continue;
  }
  const t0 = Date.now();
  const svg = renderTextSvg(f.filePath, f.collectionIndex, {
    text: "永和九年 Aa 123",
    fontSize: 44,
  });
  const ms = Date.now() - t0;
  console.log(
    `${label.padEnd(8)} ${f.postScriptName.padEnd(26)} ${svg ? `${svg.length} bytes` : "FAILED"}  ${ms}ms`
  );
  if (svg) fs.writeFileSync(`data/_preview_${f.id}.svg`, svg, "utf-8");
}
