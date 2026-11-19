/**
 * 生成相似度引擎的可视化验证页。
 * 每个字体一张卡：自己的字形 + top-5 相似字体（带分数和字形），便于肉眼判断合不合理。
 */
import fs from "node:fs";
import { renderTextSvg } from "../packages/font-core/src/preview.js";

const index = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const sim = JSON.parse(fs.readFileSync("data/similarity.json", "utf-8"));

const faceById = new Map<string, any>(index.faces.map((f: any) => [f.id, f]));

function svgFor(face: any, text: string, size: number): string {
  const s = renderTextSvg(face.filePath, face.collectionIndex, {
    text,
    fontSize: size,
    padding: 4,
    color: "#16161a",
  });
  return s ?? '<div class="bad">预览不可用</div>';
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/* 挑几个有代表性的字体展示 */
const SHOW = ["MicrosoftYaHei", "SimSun", "KaiTi", "AlibabaPuHuiTiR", "SourceHanSansCNBold", "DengXian"];

const cards: string[] = [];
for (const ps of SHOW) {
  const item = Object.entries(sim.items).find(([, v]: any) => v.ps === ps);
  if (!item) continue;
  const [id, data] = item as [string, any];
  const face = faceById.get(id);
  if (!face) continue;

  const sampleText = data.samples.join(" ");
  const neighbors = (data.neighbors || []).slice(0, 5);

  const rows = neighbors
    .map((n: any, i: number) => {
      const nf = faceById.get(n.id);
      if (!nf) return "";
      const barW = Math.round(n.score * 100);
      return `
      <div class="row">
        <div class="rank">${i + 1}</div>
        <div class="glyph">${svgFor(nf, data.samples[0], 34)}</div>
        <div class="meta">
          <div class="name">${esc(nf.familyZh || nf.family)} <span class="ps">${esc(nf.postScriptName)}</span></div>
          <div class="bar"><i style="width:${barW}%"></i><b>${n.score.toFixed(3)}</b></div>
        </div>
      </div>`;
    })
    .join("");

  cards.push(`
  <section class="card">
    <header>
      <div class="title">${esc(face.familyZh || face.family)}</div>
      <div class="sub">${esc(face.postScriptName)} · ${data.glyphs} 字形</div>
    </header>
    <div class="self">${svgFor(face, sampleText, 44)}</div>
    <div class="rows">${rows}</div>
  </section>`);
}

/* 重复检测 */
const byHash = new Map<string, any[]>();
for (const [, v] of Object.entries(sim.items) as any) {
  if (!v.fileHash) continue;
  const arr = byHash.get(v.fileHash) ?? [];
  arr.push(v);
  byHash.set(v.fileHash, arr);
}
const dups = [...byHash.values()].filter((g) => g.length > 1);

const dupRows = dups
  .map((g) => {
    const names = g
      .map((x) => {
        const f = faceById.get(Object.keys(sim.items).find((k) => sim.items[k] === x) ?? "");
        const path = f ? f.filePath.split("\\").slice(-1)[0] : "";
        return `<span class="pill">${esc(x.ps)}<i>${esc(path)}</i></span>`;
      })
      .join("");
    return `<div class="duprow">${names}</div>`;
  })
  .join("");

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>FontDeck 字形相似度</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:28px 32px 60px;background:#f6f6f7;color:#16161a;
       font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;font-size:13px}
  h1{font-size:19px;margin:0 0 4px;letter-spacing:-0.01em}
  .lede{color:#8b8b96;font-size:12px;margin:0 0 22px;line-height:1.7}
  .stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:24px}
  .stat{background:#fff;border:1px solid #e6e6ea;border-radius:9px;padding:11px 15px;min-width:118px}
  .stat b{display:block;font-size:19px;font-variant-numeric:tabular-nums;letter-spacing:-0.02em}
  .stat span{font-size:11px;color:#8b8b96}
  h2{font-size:14px;margin:30px 0 12px;padding-bottom:7px;border-bottom:1px solid #e6e6ea}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(460px,1fr));gap:14px}
  .card{background:#fff;border:1px solid #e6e6ea;border-radius:11px;padding:16px 17px;overflow:hidden}
  .card header{margin-bottom:9px}
  .title{font-size:14px;font-weight:700}
  .sub{font-size:11px;color:#a0a0aa;font-family:Consolas,monospace;margin-top:2px}
  .self{border-bottom:1px solid #f0f0f3;padding:4px 0 9px;margin-bottom:9px;
        white-space:nowrap;overflow:hidden;overflow-x:auto}
  .self svg{max-width:100%;height:auto}
  .row{display:flex;align-items:center;gap:9px;padding:4px 0}
  .rank{width:15px;font-size:10px;color:#c0c0c8;font-variant-numeric:tabular-nums}
  .glyph{width:52px;flex-shrink:0;display:flex;align-items:center;justify-content:center;
         background:#fafafb;border-radius:5px;padding:2px;overflow:hidden}
  .glyph svg{max-width:100%;height:auto}
  .meta{flex:1;min-width:0}
  .name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .ps{font-family:Consolas,monospace;font-size:10px;color:#b0b0b8;margin-left:5px}
  .bar{position:relative;height:4px;background:#f0f0f3;border-radius:2px;margin-top:4px}
  .bar i{position:absolute;left:0;top:0;bottom:0;background:#4f46e5;border-radius:2px;opacity:.75}
  .bar b{position:absolute;right:0;top:-13px;font-size:9px;color:#8b8b96;
         font-variant-numeric:tabular-nums;font-weight:500}
  .duprow{display:flex;gap:7px;flex-wrap:wrap;padding:6px 0;border-bottom:1px solid #f4f4f6}
  .pill{background:#fafafb;border:1px solid #ebebef;border-radius:6px;padding:4px 8px;
        font-size:11px;font-family:Consolas,monospace}
  .pill i{display:block;font-style:normal;font-size:9px;color:#b0b0b8;margin-top:1px}
  .bad{color:#b25d00;font-size:11px}
  .note{background:#fff;border:1px solid #e6e6ea;border-radius:9px;padding:13px 16px;
        color:#5c5c66;font-size:12px;line-height:1.85;margin-top:14px}
  .note b{color:#16161a}
</style></head><body>

<h1>字形相似度引擎 · 验证页</h1>
<p class="lede">
  每个字体取 4 个样本字，按墨迹包围盒归一化后栅格化成 64×64，压成 16×16 密度向量，用余弦相似度比较。<br>
  下面每个卡片是「这个字体最像的 5 个」——你看形状判断一下合不合理。
</p>

<div class="stats">
  <div class="stat"><b>${sim.stats.counted}</b><span>参与计算的字体</span></div>
  <div class="stat"><b>${sim.stats.cjk}</b><span>含中文</span></div>
  <div class="stat"><b>${sim.stats.latin}</b><span>纯西文</span></div>
  <div class="stat"><b>${dups.length}</b><span>重复安装组</span></div>
  <div class="stat"><b>${(sim.stats.cjk * (sim.stats.cjk - 1) / 2 + sim.stats.latin * (sim.stats.latin - 1) / 2).toLocaleString()}</b><span>比较次数</span></div>
</div>

<h2>相似度推荐</h2>
<div class="grid">${cards.join("")}</div>

<h2>重复安装（文件 SHA-256 完全相同）</h2>
<div class="note">
  同一份字体文件装了多份。判据是 <b>文件内容哈希</b>，不是文件名——所以改了名字的同一份文件也能抓出来。
</div>
${dupRows || '<p class="lede">没有发现重复安装。</p>'}

<script>
document.querySelectorAll('.self, .glyph').forEach(function(box){
  var svg = box.querySelector('svg');
  if (svg) { svg.removeAttribute('width'); svg.removeAttribute('height'); }
});
</script>
</body></html>`;

fs.writeFileSync("data/similarity-demo.html", html, "utf-8");
console.log(`已生成 data/similarity-demo.html  ${(html.length / 1024).toFixed(0)} KB`);
console.log(`展示 ${cards.length} 个字体，重复组 ${dups.length} 个`);
