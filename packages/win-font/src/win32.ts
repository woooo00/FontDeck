/**
 * Win32 调用封装（写字体用）
 *
 * 只做三件事：写注册表、挂载/卸载字体资源、通知系统刷新。
 * 全部走 koffi 直调，不碰 reg.exe（本机被封）。
 */
import koffi from "koffi";

/*
 * koffi 的官方 d.ts 没有导出库句柄 / 函数指针的类型名，`KoffiLib`
 * 这种命名空间写法会让 tsc 报错（实测全项目 27 处）。用官方 load() 反推
 * 一个本地别名，纯类型层，运行时行为完全不变。
 */
type KoffiLib = ReturnType<typeof koffi.load>;
type KoffiFunction = (...args: any[]) => any;

const HKEY_CURRENT_USER = 0x80000001n;
const FONTS_SUBKEY = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";

const KEY_SET_VALUE = 0x0002;
const REG_SZ = 1;

const HWND_BROADCAST = 0xffffn;
const WM_FONTCHANGE = 0x001d;
const SMTO_ABORTIFHUNG = 0x0002;

const ERROR_SUCCESS = 0;

let advapi32: KoffiLib | null = null;
let gdi32: KoffiLib | null = null;
let user32: KoffiLib | null = null;

let fns: {
  RegCreateKeyExW: KoffiFunction;
  RegSetValueExW: KoffiFunction;
  RegDeleteValueW: KoffiFunction;
  RegCloseKey: KoffiFunction;
  RegOpenKeyExW: KoffiFunction;
  AddFontResourceW: KoffiFunction;
  RemoveFontResourceW: KoffiFunction;
  SendMessageTimeoutW: KoffiFunction;
} | null = null;

function ensureLoaded() {
  if (fns) return fns;

  advapi32 = koffi.load("advapi32.dll");
  gdi32 = koffi.load("gdi32.dll");
  user32 = koffi.load("user32.dll");

  fns = {
    RegOpenKeyExW: advapi32.func(
      "long __stdcall RegOpenKeyExW(uintptr_t hKey, str16 lpSubKey, uint32_t ulOptions, uint32_t samDesired, _Out_ uintptr_t *phkResult)"
    ) as KoffiFunction,
    RegCreateKeyExW: advapi32.func(
      "long __stdcall RegCreateKeyExW(uintptr_t hKey, str16 lpSubKey, uint32_t Reserved, void *lpClass, uint32_t dwOptions, uint32_t samDesired, void *lpSecurityAttributes, _Out_ uintptr_t *phkResult, _Out_ uint32_t *lpdwDisposition)"
    ) as KoffiFunction,
    RegSetValueExW: advapi32.func(
      "long __stdcall RegSetValueExW(uintptr_t hKey, str16 lpValueName, uint32_t Reserved, uint32_t dwType, void *lpData, uint32_t cbData)"
    ) as KoffiFunction,
    RegDeleteValueW: advapi32.func(
      "long __stdcall RegDeleteValueW(uintptr_t hKey, str16 lpValueName)"
    ) as KoffiFunction,
    RegCloseKey: advapi32.func(
      "long __stdcall RegCloseKey(uintptr_t hKey)"
    ) as KoffiFunction,
    AddFontResourceW: gdi32.func(
      "int __stdcall AddFontResourceW(str16 lpFileName)"
    ) as KoffiFunction,
    RemoveFontResourceW: gdi32.func(
      "int __stdcall RemoveFontResourceW(str16 lpFileName)"
    ) as KoffiFunction,
    SendMessageTimeoutW: user32.func(
      "intptr_t __stdcall SendMessageTimeoutW(uintptr_t hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam, uint32_t fuFlags, uint32_t uTimeout, _Out_ uintptr_t *lpdwResult)"
    ) as KoffiFunction,
  };
  return fns;
}

/* ------------------------------------------------------------------ */
/* 注册表                                                              */
/* ------------------------------------------------------------------ */

/** 打开（或创建）HKCU 下的字体键，返回句柄 */
function openFontsKey(access: number): bigint {
  const { RegCreateKeyExW } = ensureLoaded();
  const hBuf = [0n];
  const disp = [0];
  const rc = RegCreateKeyExW(
    HKEY_CURRENT_USER,
    FONTS_SUBKEY,
    0,
    null,
    0,
    access,
    null,
    hBuf,
    disp
  );
  if (rc !== ERROR_SUCCESS) {
    throw new Error(`打开注册表字体键失败，返回码 ${rc}`);
  }
  return hBuf[0];
}

/** 写一条字体登记：值名 = 注册名，值 = 字体完整路径 */
export function writeFontRegistryValue(regName: string, filePath: string): void {
  const { RegSetValueExW, RegCloseKey } = ensureLoaded();
  const hKey = openFontsKey(KEY_SET_VALUE);
  try {
    const data = Buffer.from(filePath + "\0", "utf16le");
    const rc = RegSetValueExW(
      hKey,
      regName,
      0,
      REG_SZ,
      data,
      data.length
    );
    if (rc !== ERROR_SUCCESS) {
      throw new Error(`写入注册表值「${regName}」失败，返回码 ${rc}`);
    }
  } finally {
    RegCloseKey(hKey);
  }
}

/** 删除字体登记。值不存在时返回 false，不抛错。 */
export function deleteFontRegistryValue(regName: string): boolean {
  const { RegDeleteValueW, RegCloseKey } = ensureLoaded();
  const hKey = openFontsKey(KEY_SET_VALUE);
  try {
    const rc = RegDeleteValueW(hKey, regName);
    return rc === ERROR_SUCCESS;
  } finally {
    RegCloseKey(hKey);
  }
}

/* ------------------------------------------------------------------ */
/* 字体资源                                                            */
/* ------------------------------------------------------------------ */

/** 把字体挂进当前会话，返回实际加入的 face 数 */
export function addFontResource(filePath: string): number {
  const { AddFontResourceW } = ensureLoaded();
  return Number(AddFontResourceW(filePath));
}

export function removeFontResource(filePath: string): number {
  const { RemoveFontResourceW } = ensureLoaded();
  return Number(RemoveFontResourceW(filePath));
}

/** 通知所有窗口字体列表变了，让运行中的程序（含 Illustrator）刷新 */
export function broadcastFontChange(): void {
  const { SendMessageTimeoutW } = ensureLoaded();
  const out = [0n];
  try {
    SendMessageTimeoutW(
      HWND_BROADCAST,
      WM_FONTCHANGE,
      0n,
      0n,
      SMTO_ABORTIFHUNG,
      1000,
      out
    );
  } catch {
    // 广播失败不影响字体本身已挂载的事实
  }
}
