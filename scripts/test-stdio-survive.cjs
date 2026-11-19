/*
 * 用真实服务做存活实验：分别用 ignore / fd 两种 stdio 拉起，
 * 父进程退出后等一段时间，看服务还在不在。
 *
 * 用法：node scripts/test-stdio-survive.cjs <ignore|fd>
 */
const cp = require("node:child_process");
const fs = require("node:fs");

const MODE = process.argv[2] || "ignore";
const ROOT = "C:\\Users\\6\\WorkBuddy\\2026-11-09-14-23-57\\fontdeck";
const NODE_EXE = "C:\\Users\\6\\.workbuddy\\binaries\\node\\versions\\22.22.2-6\\node.exe";
const TSX = ROOT + "\\node_modules\\tsx\\dist\\cli.mjs";
const ENTRY = ROOT + "\\apps\\service\\src\\main.ts";

let stdio = "ignore";
if (MODE === "fd") {
  const fd = fs.openSync(ROOT + "\\data\\service.log", "a");
  stdio = ["ignore", fd, fd];
  console.log("stdio 模式：文件句柄");
} else {
  console.log("stdio 模式：ignore");
}

const child = cp.spawn(NODE_EXE, [TSX, ENTRY], {
  cwd: ROOT,
  detached: true,
  stdio: stdio,
  windowsHide: true,
});
child.unref();
console.log("已拉起服务 pid =", child.pid, "，父进程现在退出。");
