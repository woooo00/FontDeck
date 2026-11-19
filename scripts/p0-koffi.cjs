/**
 * FontDeck P0-D：验证 koffi 能否在本机加载并调用 Win32 API
 * 测四件事：
 *   1. koffi 模块能否加载（企业策略可能拦原生模块）
 *   2. advapi32 读 HKCU 字体项数量（应约 311）
 *   3. advapi32 写 + 删一个临时注册表值
 *   4. gdi32 AddFontResourceW / RemoveFontResourceW 能否临时注册字体
 *
 * 用法：node scripts/p0-koffi.cjs
 */
"use strict";

const HKEY_CURRENT_USER = 0x80000001n;
const KEY_READ = 0x20019;
const KEY_WRITE = 0x20006;
const KEY_ALL_ACCESS = 0xf003f;
const REG_SZ = 1;

const FONTS_KEY = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";

function main() {
  const results = [];

  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}: ${detail}`);
  }

  /* ---------- 1. 加载 koffi ---------- */
  let koffi;
  try {
    koffi = require("koffi");
    record("koffi 加载", true, `版本 ${koffi.version || "unknown"}`);
  } catch (e) {
    record("koffi 加载", false, e.message);
    finish(results);
    return;
  }

  /* ---------- 2. advapi32 绑定 ---------- */
  let advapi32, gdi32;
  try {
    advapi32 = koffi.load("advapi32.dll");
    gdi32 = koffi.load("gdi32.dll");
    record("DLL 加载", true, "advapi32.dll + gdi32.dll");
  } catch (e) {
    record("DLL 加载", false, e.message);
    finish(results);
    return;
  }

  let RegOpenKeyExW, RegQueryInfoKeyW, RegCloseKey, RegCreateKeyExW, RegSetValueExW, RegDeleteValueW;
  try {
    RegOpenKeyExW = advapi32.func(
      "long __stdcall RegOpenKeyExW(uintptr_t hKey, str16 lpSubKey, uint32_t ulOptions, uint32_t samDesired, _Out_ uintptr_t *phkResult)"
    );
    RegQueryInfoKeyW = advapi32.func(
      "long __stdcall RegQueryInfoKeyW(uintptr_t hKey, void *lpClass, void *lpcchClass, void *lpReserved, _Out_ uint32_t *lpcSubKeys, void *lpcbMaxSubKeyLen, void *lpcbMaxClassLen, _Out_ uint32_t *lpcValues, void *lpcbMaxValueNameLen, void *lpcbMaxValueLen, void *lpcbSecurityDescriptor, void *lpftLastWriteTime)"
    );
    RegCloseKey = advapi32.func("long __stdcall RegCloseKey(uintptr_t hKey)");
    RegCreateKeyExW = advapi32.func(
      "long __stdcall RegCreateKeyExW(uintptr_t hKey, str16 lpSubKey, uint32_t Reserved, void *lpClass, uint32_t dwOptions, uint32_t samDesired, void *lpSecurityAttributes, _Out_ uintptr_t *phkResult, _Out_ uint32_t *lpdwDisposition)"
    );
    RegSetValueExW = advapi32.func(
      "long __stdcall RegSetValueExW(uintptr_t hKey, str16 lpValueName, uint32_t Reserved, uint32_t dwType, void *lpData, uint32_t cbData)"
    );
    RegDeleteValueW = advapi32.func(
      "long __stdcall RegDeleteValueW(uintptr_t hKey, str16 lpValueName)"
    );
    record("API 绑定", true, "6 个 advapi32 函数");
  } catch (e) {
    record("API 绑定", false, e.message);
    finish(results);
    return;
  }

  /* ---------- 3. 读 HKCU 字体项数量 ---------- */
  const hKeyBuf = [0n];
  let rc = 0;
  try {
    rc = RegOpenKeyExW(HKEY_CURRENT_USER, FONTS_KEY, 0, KEY_READ, hKeyBuf);
    if (rc !== 0) throw new Error(`RegOpenKeyExW 返回 ${rc}`);
    const subKeys = [0];
    const values = [0];
    rc = RegQueryInfoKeyW(hKeyBuf[0], null, null, null, subKeys, null, null, values, null, null, null, null);
    if (rc !== 0) throw new Error(`RegQueryInfoKeyW 返回 ${rc}`);
    record("读 HKCU 字体项", true, `子键 ${subKeys[0]} 个，值 ${values[0]} 条`);
  } catch (e) {
    record("读 HKCU 字体项", false, e.message);
  } finally {
    if (hKeyBuf[0]) RegCloseKey(hKeyBuf[0]);
  }

  /* ---------- 4. 写 + 删临时注册表值 ---------- */
  const tmpKeyBuf = [0n];
  const disp = [0];
  const TEST_KEY = "SOFTWARE\\FontDeck\\P0Test";
  const TEST_NAME = "probe";
  let wrote = false;
  try {
    rc = RegCreateKeyExW(HKEY_CURRENT_USER, TEST_KEY, 0, null, 0, KEY_ALL_ACCESS, null, tmpKeyBuf, disp);
    if (rc !== 0) throw new Error(`RegCreateKeyExW 返回 ${rc}`);

    const value = "fontdeck-p0";
    const data = Buffer.from(value + "\0", "utf16le");
    rc = RegSetValueExW(tmpKeyBuf[0], TEST_NAME, 0, REG_SZ, data, data.length);
    if (rc !== 0) throw new Error(`RegSetValueExW 返回 ${rc}`);
    wrote = true;

    rc = RegDeleteValueW(tmpKeyBuf[0], TEST_NAME);
    if (rc !== 0) throw new Error(`RegDeleteValueW 返回 ${rc}`);
    record("写 / 删注册表值", true, `HKCU\\${TEST_KEY} 可写可删`);
  } catch (e) {
    record("写 / 删注册表值", false, e.message);
  } finally {
    if (tmpKeyBuf[0]) RegCloseKey(tmpKeyBuf[0]);
    if (wrote) console.log("       （临时值已清理）");
  }

  /* ---------- 5. AddFontResourceW 临时注册字体 ---------- */
  try {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(process.env.LOCALAPPDATA, "Microsoft", "Windows", "Fonts");
    const cand = fs.readdirSync(dir)
      .filter((f) => /\.(ttf|otf)$/i.test(f))
      .map((f) => path.join(dir, f))
      .find((p) => {
        try { return fs.statSync(p).size > 50000; } catch { return false; }
      });

    if (!cand) throw new Error("用户字体目录里没找到可用测试字体");

    const AddFontResourceW = gdi32.func("int __stdcall AddFontResourceW(str16 lpFileName)");
    const RemoveFontResourceW = gdi32.func("int __stdcall RemoveFontResourceW(str16 lpFileName)");

    const added = AddFontResourceW(cand);
    if (added <= 0) throw new Error(`AddFontResourceW 返回 ${added}`);
    const removed = RemoveFontResourceW(cand);
    record("AddFontResourceW", true,
      `添加 ${added} 个 face，撤销 ${removed} 个（测试文件：${path.basename(cand)}）`);
  } catch (e) {
    record("AddFontResourceW", false, e.message);
  }

  finish(results);
}

function finish(results) {
  const pass = results.filter((r) => r.ok).length;
  console.log("\n" + "=".repeat(52));
  console.log(`结果：${pass}/${results.length} 项通过`);
  if (pass === results.length) {
    console.log("结论：可以走 koffi 方案，不需要 PowerShell 兜底。");
  } else {
    console.log("结论：有失败项，需要评估 PowerShell 兜底方案。");
  }
  console.log("=".repeat(52));

  const out = require("path").join(__dirname, "..", "docs", "p0d-result.json");
  require("fs").writeFileSync(out, JSON.stringify({ results, at: new Date().toISOString() }, null, 1), "utf-8");
}

try {
  main();
} catch (e) {
  console.error("[FATAL]", e);
  process.exitCode = 1;
}
