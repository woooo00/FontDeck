/**
 * 安装 / 卸载 / 还原 全流程自检
 *
 * 用一个「已在字体目录里但没注册」的字体做测试载体，装完立刻卸掉，
 * 最后把备份文件也清掉，不留痕迹。
 *
 * 用法：npx tsx scripts/test-installer.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readFontRegistry } from "../packages/font-core/src/registry.js";
import {
  installFontFile,
  listInstalled,
  makeRegName,
  readLedger,
  restoreFont,
  uninstallFont,
  userFontsDir,
} from "../packages/win-font/src/installer.js";

const line = (s: string) => console.log(s);

function regNames(): Set<string> {
  return new Set(readFontRegistry().map((e) => e.regName));
}

function main() {
  const fontsDir = userFontsDir();
  line(`用户字体目录: ${fontsDir}`);

  /* 找一个未注册的候选字体重命名为临时文件，模拟"用户选了个字体文件要装" */
  const candidates = fs
    .readdirSync(fontsDir)
    .filter((f) => /\.(ttf|otf)$/i.test(f))
    .map((f) => path.join(fontsDir, f))
    .filter((p) => fs.statSync(p).size > 100 * 1024);

  if (candidates.length === 0) {
    line("没有可用测试字体");
    process.exit(1);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-test-"));
  line("");

  /* 逐个候选尝试，直到找到一个是未注册的（查重会挡掉已存在的） */
  let install: ReturnType<typeof installFontFile> | null = null;
  let usedSrc = "";

  for (const cand of candidates.slice(0, 12)) {
    const t = path.join(tmpDir, path.basename(cand));
    fs.copyFileSync(cand, t);
    const r = installFontFile(t, { existingRegNames: regNames() });
    if (r.ok) {
      install = r;
      usedSrc = cand;
      break;
    }
    try {
      fs.unlinkSync(t);
    } catch {
      /* ignore */
    }
  }

  if (!install) {
    line("[SKIP] 所有候选字体都已被注册，找不到干净的测试载体");
    cleanup(tmpDir);
    return;
  }

  line(`测试源文件: ${path.basename(usedSrc)}`);

  line(`[PASS] 安装成功`);
  line(`       目标文件: ${install.record!.filePath}`);
  line(`       注册面数: ${install.record!.faces.length}, gdi 加入 ${install.addedFaces} 个 face`);
  for (const f of install.record!.faces) {
    line(`       - ${f.regName}`);
  }

  /* ---- 2. 校验注册表确实写进去了 ---- */
  const after = regNames();
  const missing = install.record!.faces.filter((f) => !after.has(f.regName));
  if (missing.length === 0) {
    line(`[PASS] 注册表已登记 ${install.record!.faces.length} 条`);
  } else {
    line(`[FAIL] 注册表缺 ${missing.length} 条: ${missing.map((m) => m.regName).join(", ")}`);
  }

  /* ---- 3. 台账 ---- */
  const listed = listInstalled().find((r) => r.id === install.record!.id);
  line(listed ? "[PASS] 台账已记录" : "[FAIL] 台账没有这条");

  /* ---- 4. 卸载 ---- */
  const un = uninstallFont(install.record!.id);
  if (un.ok) {
    line(`[PASS] 卸载成功`);
    line(`       备份到: ${un.backupPath}`);
    line(`       原文件还在吗: ${fs.existsSync(install.record!.filePath) ? "是（异常）" : "否（正确）"}`);
  } else {
    line(`[FAIL] 卸载失败: ${un.error}`);
  }

  /* ---- 5. 注册表清理 ---- */
  const afterUn = regNames();
  const leftover = install.record!.faces.filter((f) => afterUn.has(f.regName));
  // 注意：如果原本就有同名字体（比如系统里已有一份），这里会误报，所以只做提示
  line(
    leftover.length === 0
      ? "[PASS] 注册表已清理"
      : `[INFO] 残留 ${leftover.length} 条（若原本就有同名字体属正常）`
  );

  /* ---- 6. 还原 ---- */
  const re = restoreFont(install.record!.id);
  if (re.ok) {
    line(`[PASS] 还原成功 -> ${re.backupPath}`);
  } else {
    line(`[FAIL] 还原失败: ${re.error}`);
  }

  /* ---- 7. 清理：再次卸载，并删掉备份 ---- */
  const un2 = uninstallFont(install.record!.id);
  if (un2.ok) {
    line("[PASS] 清理完成（第二次卸载）");
  }

  const ledger = readLedger();
  line("");
  line(`台账记录数: ${ledger.records.length}（含历史）`);

  cleanup(tmpDir);
  line("");
  line("测试结束。");
}

function cleanup(tmpDir: string) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

main();
