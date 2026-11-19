/*
 * 模拟 CEP 面板拉起服务的方式，验证：
 *   1) detached + windowsHide 能真正把服务拉起来
 *   2) 拉起它的进程退出后，服务依然存活
 *
 * 这段逻辑与 apps/cep/js/boot.js 里的 spawnSilently() 保持一致。
 */
const cp = require("node:child_process");
const fs = require("node:fs");

const ROOT = "C:\\Users\\6\\WorkBuddy\\2026-11-09-14-23-57\\fontdeck";
const NODE_EXE = "C:\\Users\\6\\.workbuddy\\binaries\\node\\versions\\22.22.2-6\\node.exe";
const TSX = ROOT + "\\node_modules\\tsx\\dist\\cli.mjs";
const ENTRY = ROOT + "\\apps\\service\\src\\main.ts";

for (const p of [NODE_EXE, TSX, ENTRY]) {
  if (!fs.existsSync(p)) {
    console.error("缺少文件:", p);
    process.exit(1);
  }
}

const child = cp.spawn(NODE_EXE, [TSX, ENTRY], {
  cwd: ROOT,
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});

child.unref();
console.log("已拉起服务，pid =", child.pid);
console.log("父进程即将退出，用它来验证子进程能否独立存活。");
