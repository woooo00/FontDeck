/** 生成字体预览 demo 页面（按家族分组，SVG 内联，零外部请求） */
import fs from "node:fs";
import { renderTextSvg } from "../packages/font-core/src/preview.js";

const idx = JSON.parse(fs.readFileSync("data/index.json", "utf-8"));
const allFaces: any[] = idx.faces;

function esc(s: string) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ---------- 按家族分组 ---------- */
interface Family {
  name: string;
  nameZh?: string;
  faces: any[];
  rep: any;
}

const byKey = new Map<string, Family>();
for (const f of allFaces) {
  if (f.health === "missing-file") continue;
  if (!f.postScriptName) continue;
  // 重复 face 不进家族分组，否则同一个字体会出现两张卡
  if (f.duplicateOf) continue;
  const key = (f.familyZh || f.family || f.postScriptName).trim().toLowerCase();
  let fam = byKey.get(key);
  if (!fam) {
    fam = { name: f.family, nameZh: f.familyZh, faces: [], rep: f };
    byKey.set(key, fam);
  }
  fam.faces.push(f);
}

/* 代表 face：优先已注册、非重复、非残片，其次字形最多 */
function score(f: any) {
  let s = 0;
  if (f.health === "ok") s += 100;
  if (f.health === "suspicious") s -= 50;
  if (f.health === "unregistered") s -= 20;
  if (f.registered) s += 30;
  if (!f.duplicateOf) s += 10;
  return s;
}

const families = [...byKey.values()].map((f) => {
  const sorted = [...f.faces].sort((a, b) => score(b) - score(a) || b.glyphCount - a.glyphCount);
  return { ...f, rep: sorted[0], faces: sorted };
});

/* ---------- 挑选展示 ---------- */
function pickFamilies(): Family[] {
  const out: Family[] = [];
  const used = new Set<string>();
  const groups: [string, (f: Family) => boolean, number][] = [
    ["中文字体", (f) => f.rep.hasCJK, 12],
    ["西文衬线", (f) => !f.rep.hasCJK && f.rep.category === "serif", 7],
    ["西文无衬线", (f) => !f.rep.hasCJK && f.rep.category === "sans-serif", 9],
    ["手写装饰", (f) => f.rep.category === "script" || f.rep.category === "display", 6],
    ["等宽", (f) => f.rep.isFixedPitch && !f.rep.hasCJK, 3],
    ["可变字体", (f) => f.rep.isVariable, 4],
  ];
  for (const [, pred, n] of groups) {
    let taken = 0;
    for (const fam of families) {
      if (taken >= n || out.length >= 48) break;
      const key = fam.name.toLowerCase();
      if (used.has(key)) continue;
      if (!pred(fam)) continue;
      used.add(key);
      out.push(fam);
      taken++;
    }
  }
  return out;
}

const picked = pickFamilies();

/* ---------- 生成卡片 ---------- */
const cards = picked.map((fam) => {
  const f = fam.rep;
  const displayName = (fam.nameZh || fam.name).trim();
  // 不截断字符串：宽度交给 renderTextSvg 的 autoFit 处理，长名字会自动缩小字号
  const truncated = displayName;

  const nameSvg = renderTextSvg(f.filePath, f.collectionIndex, {
    text: truncated,
    fontSize: 32,
    padding: 0,
    color: "#16161a",
    maxWidth: 460,
  });

  const sampleText = f.hasCJK ? "永和九年 岁在癸丑" : "Aa Bb Cc 0123";
  const sampleSvg = renderTextSvg(f.filePath, f.collectionIndex, {
    text: sampleText,
    fontSize: 16,
    padding: 0,
    color: "#71717d",
    maxWidth: 460,
  });

  const badges: string[] = [];
  if (fam.faces.length > 1) badges.push(`<span class="badge weight">${fam.faces.length} 字重</span>`);
  if (f.isVariable) badges.push(`<span class="badge var">可变</span>`);
  if (f.health === "unregistered") badges.push(`<span class="badge warn">未注册</span>`);
  if (f.health === "suspicious") badges.push(`<span class="badge warn">疑似残片</span>`);
  if (f.scope === "system") badges.push(`<span class="badge sys">系统</span>`);

  const nameBlock = nameSvg
    ? nameSvg
    : `<div class="text-fallback big">${esc(truncated)}</div>`;

  const sampleBlock = sampleSvg
    ? sampleSvg
    : `<div class="text-fallback small">预览不可用 · 该字体轮廓无法提取</div>`;

  const meta = [
    `${f.weightClass}`,
    f.category === "unknown" ? null : f.category,
    f.format.toUpperCase(),
    `${Math.round(f.fileSize / 1024)} KB`,
  ].filter(Boolean);

  return `
  <article class="card">
    <div class="badges">${badges.join("")}</div>
    <div class="preview name">${nameBlock}</div>
    <div class="preview sample">${sampleBlock}</div>
    <footer class="card-foot">
      <span class="ps">${esc(f.postScriptName)}</span>
      <span class="meta">${meta.join(" · ")}</span>
    </footer>
  </article>`;
});

const s = idx.stats;

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>FontDeck · 字体预览</title>
<style>
  :root {
    --bg: #f5f5f6;
    --card: #fff;
    --line: #e6e6e9;
    --ink: #16161a;
    --muted: #8b8b96;
    --accent: #4f46e5;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .page { max-width: 1200px; margin: 0 auto; padding: 52px 36px 88px; }
  .eyebrow {
    font-size: 11px; letter-spacing: .16em; text-transform: uppercase;
    color: var(--accent); font-weight: 700; margin-bottom: 12px;
  }
  h1 { font-size: 36px; margin: 0 0 12px; letter-spacing: -.025em; font-weight: 700; }
  .lede { color: var(--muted); font-size: 14px; margin: 0 0 28px; line-height: 1.75; max-width: 700px; }
  .stats {
    display: flex; gap: 34px; flex-wrap: wrap;
    padding: 20px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
  }
  .stat .n { font-size: 23px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
  .stat .l { font-size: 11px; color: var(--muted); letter-spacing: .05em; margin-top: 3px; }
  .grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(348px, 1fr));
    gap: 14px; margin-top: 34px;
  }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 15px 18px 13px; display: flex; flex-direction: column;
    min-height: 168px;
    transition: box-shadow .18s ease, transform .18s ease, border-color .18s ease;
  }
  .card:hover {
    box-shadow: 0 8px 28px rgba(18,18,30,.075);
    border-color: #d4d4da; transform: translateY(-1px);
  }
  .badges { display: flex; gap: 5px; flex-wrap: wrap; min-height: 19px; margin-bottom: 9px; }
  .badge {
    font-size: 10px; padding: 1px 6px; border-radius: 4px;
    font-weight: 600; letter-spacing: .02em; line-height: 1.7;
  }
  .badge.weight { background: #f0f0f3; color: #5c5c66; }
  .badge.var { background: #eef0ff; color: #4f46e5; }
  .badge.warn { background: #fff3e0; color: #b25d00; }
  .badge.sys { background: #f0f0f3; color: #9a9aa4; }
  .preview { overflow: hidden; }
  .preview.name { margin-bottom: 7px; min-height: 42px; display: flex; align-items: center; }
  .preview.sample { min-height: 24px; display: flex; align-items: center; }
  .preview svg { display: block; max-width: 100%; height: auto; }
  .text-fallback.big { font-size: 25px; font-weight: 600; letter-spacing: -.01em; }
  .text-fallback.small { font-size: 11.5px; color: #b0b0b8; font-style: italic; }
  .card-foot {
    margin-top: auto; padding-top: 11px; border-top: 1px dashed #ececf0;
    display: flex; justify-content: space-between; gap: 10px;
    font-size: 10.5px; color: var(--muted);
  }
  .ps { font-family: Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { flex: none; font-variant-numeric: tabular-nums; }
  footer.bottom {
    margin-top: 60px; padding-top: 22px; border-top: 1px solid var(--line);
    font-size: 12px; color: var(--muted); line-height: 1.8;
  }
</style>
</head>
<body>
<div class="page">
  <header>
    <div class="eyebrow">FontDeck · Preview Prototype</div>
    <h1>字体预览</h1>
    <p class="lede">
      卡片里的字形不是字体渲染出来的，是服务端从字体文件里直接提取的矢量轮廓。
      页面本身没有加载任何字体文件——中文字体动辄 10–20MB，只有这样几百个字体才能同时出现在一屏而不卡。
    </p>
    <div class="stats">
      <div class="stat"><div class="n">${s.parsedFaces}</div><div class="l">字体总数</div></div>
      <div class="stat"><div class="n">${s.byScope.user}</div><div class="l">用户级</div></div>
      <div class="stat"><div class="n">${s.byScope.system}</div><div class="l">系统级</div></div>
      <div class="stat"><div class="n">${s.byHealth.unregistered}</div><div class="l">未注册</div></div>
      <div class="stat"><div class="n">${s.duplicates}</div><div class="l">重复</div></div>
      <div class="stat"><div class="n">${s.durationMs}<span style="font-size:13px;font-weight:400"> ms</span></div><div class="l">索引耗时</div></div>
    </div>
  </header>

  <div class="grid">
    ${cards.join("\n")}
  </div>

  <footer class="bottom">
    展示 ${picked.length} 个字体家族（索引内共 ${families.length} 个家族 / ${s.parsedFaces} 个 face）。
    全部为静态内联 SVG，无外部请求。<br>
    标记说明：<b>未注册</b> = 文件在字体目录但系统没登记；<b>疑似残片</b> = 文件异常小；<b>N 字重</b> = 该家族包含多个字重文件。
  </footer>
</div>
</body>
</html>`;

fs.writeFileSync("data/demo.html", html, "utf-8");
console.log(`已生成 data/demo.html`);
console.log(`展示 ${picked.length} 个家族 / 索引内 ${families.length} 个家族`);
console.log(`HTML ${(html.length / 1024).toFixed(0)} KB`);
