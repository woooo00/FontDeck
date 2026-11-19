/**
 * 验证 Node ↔ Python OCR 常驻进程通路。
 *
 * 检查三件事：
 *   1. 子进程能起来、模型能加载
 *   2. 批量识别能拿到正确结果
 *   3. 连续调用时每一次的耗时（第一次含加载，之后应该是毫秒级）
 */
import fs from "node:fs";
import path from "node:path";
import { getOcrEngine } from "../packages/ocr/src/client.js";

const DIR = "data/ocr-char";
const manifest: { png: string; truth: string; font: string }[] = JSON.parse(
  fs.readFileSync(path.join(DIR, "manifest.json"), "utf-8")
);

async function main() {
  const engine = getOcrEngine();

  const t0 = Date.now();
  await engine.start();
  console.log(`引擎就绪 ${Date.now() - t0}ms\n`);

  /* ---- 批量：全部 44 个字一次发过去 ---- */
  const batch = manifest.slice(0, 44);
  const b64 = batch.map((m) => fs.readFileSync(m.png).toString("base64"));

  const t1 = Date.now();
  const results = await engine.recognizeMany(b64);
  const batchCost = Date.now() - t1;

  let ok = 0;
  const fails: string[] = [];
  for (let i = 0; i < batch.length; i++) {
    const got = results[i]?.text ?? "";
    if (got === batch[i].truth) ok++;
    else fails.push(`${batch[i].truth}→${got || "空"}(${(results[i]?.score ?? 0).toFixed(2)})`);
  }

  console.log(`批量识别 ${batch.length} 字：${ok}/${batch.length} = ${((100 * ok) / batch.length).toFixed(1)}%  总耗时 ${batchCost}ms  均 ${(batchCost / batch.length).toFixed(1)}ms/字`);
  if (fails.length) console.log(`认错：${fails.join("  ")}`);

  /* ---- 单字：验证连续调用的稳定性 ---- */
  console.log("\n连续单次调用（含往返开销）：");
  for (const m of batch.slice(0, 5)) {
    const t = Date.now();
    const r = await engine.recognizeOne(fs.readFileSync(m.png).toString("base64"));
    console.log(
      `  「${m.truth}」→「${r.text || "空"}」 ${(r.score ?? 0).toFixed(2)}  ${Date.now() - t}ms`
    );
  }

  /* ---- 空输入 / 坏输入不该崩 ---- */
  console.log("\n健壮性：");
  const empty = await engine.recognizeOne("");
  console.log(`  空 base64 → text="${empty.text}" error=${empty.error ?? "无"}（不崩即合格）`);

  const garbage = await engine.recognizeOne(Buffer.from("not a png").toString("base64"));
  console.log(`  非图片数据 → text="${garbage.text}" error=${garbage.error ?? "无"}`);

  engine.stop();
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
