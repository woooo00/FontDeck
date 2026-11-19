/**
 * Windows 字体注册表读取（HKCU + HKLM）
 *
 * 为什么不用 winreg：它内部调 reg.exe，本机企业策略封了。
 * koffi 直接调 advapi32，已验证可用（P0-D 6/6 通过）。
 */
import koffi from "koffi";

/*
 * koffi 的官方 d.ts 只导出 load() 等函数，库句柄和函数指针的类型名
 * （IKoffiLib / KoffiFunction）没有 export，所以 koffi.IKoffiLib 这种
 * 命名空间写法会让 tsc 报 "Cannot find namespace 'koffi'"（实测 27 处）。
 * 这里用官方导出反推，把类型检查恢复成可用状态 —— 纯类型层，不影响运行时。
 */
type KoffiLib = ReturnType<typeof koffi.load>;
type KoffiFunction = (...args: any[]) => any;

const HKEY_CURRENT_USER = 0x80000001n;
const HKEY_LOCAL_MACHINE = 0x80000002n;
const KEY_READ = 0x20019;

const ERROR_SUCCESS = 0;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;

const REG_SZ = 1;
const REG_EXPAND_SZ = 2;

const FONTS_SUBKEY = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";

let advapi32: KoffiLib | null = null;
let fns: {
  RegOpenKeyExW: KoffiFunction;
  RegEnumValueW: KoffiFunction;
  RegCloseKey: KoffiFunction;
} | null = null;

function ensureLoaded() {
  if (fns) return fns;
  advapi32 = koffi.load("advapi32.dll");
  fns = {
    RegOpenKeyExW: advapi32.func(
      "long __stdcall RegOpenKeyExW(uintptr_t hKey, str16 lpSubKey, uint32_t ulOptions, uint32_t samDesired, _Out_ uintptr_t *phkResult)"
    ) as KoffiFunction,
    RegEnumValueW: advapi32.func(
      "long __stdcall RegEnumValueW(uintptr_t hKey, uint32_t dwIndex, _Out_ void *lpValueName, _Inout_ uint32_t *lpcchValueName, void *lpReserved, _Out_ uint32_t *lpType, _Out_ void *lpData, _Inout_ uint32_t *lpcbData)"
    ) as KoffiFunction,
    RegCloseKey: advapi32.func(
      "long __stdcall RegCloseKey(uintptr_t hKey)"
    ) as KoffiFunction,
  };
  return fns;
}

export interface RegistryFontEntry {
  /** 注册表值名，形如 "阿里巴巴普惠体-R (TrueType)" */
  regName: string;
  /** 原始值：可能是完整路径，也可能是纯文件名 */
  rawValue: string;
  hive: "HKCU" | "HKLM";
}

/** 规范化路径：统一反斜杠 + 小写。注册表里存在正反斜杠混用的情况。 */
export function normalizePath(p: string): string {
  return p.trim().replace(/\//g, "\\").toLowerCase();
}

/** 注册表值是否只是文件名（不含路径分隔符） */
export function isBareName(p: string): boolean {
  return !/[\\/]/.test(p.trim());
}

function readHive(hive: "HKCU" | "HKLM"): RegistryFontEntry[] {
  const { RegOpenKeyExW, RegEnumValueW, RegCloseKey } = ensureLoaded();
  const root = hive === "HKCU" ? HKEY_CURRENT_USER : HKEY_LOCAL_MACHINE;

  const hKeyBuf = [0n];
  const rcOpen = RegOpenKeyExW(root, FONTS_SUBKEY, 0, KEY_READ, hKeyBuf);
  if (rcOpen !== ERROR_SUCCESS) {
    throw new Error(`RegOpenKeyExW(${hive}) 失败，返回 ${rcOpen}`);
  }

  const out: RegistryFontEntry[] = [];
  const hKey = hKeyBuf[0];

  const NAME_CHARS = 1024;
  const DATA_BYTES = 8192;
  const nameBuf = Buffer.alloc(NAME_CHARS * 2);
  const dataBuf = Buffer.alloc(DATA_BYTES);
  const nameLen = [NAME_CHARS];
  const dataLen = [DATA_BYTES];
  const typeOut = [0];

  try {
    for (let i = 0; ; i++) {
      nameLen[0] = NAME_CHARS;
      dataLen[0] = DATA_BYTES;

      const rc = RegEnumValueW(
        hKey,
        i,
        nameBuf,
        nameLen,
        null,
        typeOut,
        dataBuf,
        dataLen
      );

      if (rc === ERROR_NO_MORE_ITEMS) break;
      if (rc === ERROR_MORE_DATA) continue; // 值太大，跳过
      if (rc !== ERROR_SUCCESS) break;

      const chars = nameLen[0];
      const regName = nameBuf
        .toString("utf16le", 0, chars * 2)
        .replace(/\0+$/, "");

      const t = typeOut[0];
      if (t !== REG_SZ && t !== REG_EXPAND_SZ) continue;

      const bytes = dataLen[0];
      const rawValue = dataBuf
        .toString("utf16le", 0, bytes)
        .replace(/\0+$/, "");

      if (!rawValue) continue;
      out.push({ regName, rawValue, hive });
    }
  } finally {
    RegCloseKey(hKey);
  }

  return out;
}

export function readFontRegistry(): RegistryFontEntry[] {
  const entries: RegistryFontEntry[] = [];
  for (const hive of ["HKCU", "HKLM"] as const) {
    try {
      entries.push(...readHive(hive));
    } catch {
      // 单个 hive 读失败不影响另一个
    }
  }
  return entries;
}

/**
 * 把注册表条目建成两套索引，供文件匹配：
 * - byFullPath: 完整路径（规范化）
 * - byBareName: 纯文件名（小写）
 */
export interface RegistryLookup {
  byFullPath: Map<string, RegistryFontEntry>;
  byBareName: Map<string, RegistryFontEntry>;
  all: RegistryFontEntry[];
}

export function buildRegistryLookup(
  entries: RegistryFontEntry[]
): RegistryLookup {
  const byFullPath = new Map<string, RegistryFontEntry>();
  const byBareName = new Map<string, RegistryFontEntry>();

  for (const e of entries) {
    if (isBareName(e.rawValue)) {
      byBareName.set(e.rawValue.trim().toLowerCase(), e);
    } else {
      byFullPath.set(normalizePath(e.rawValue), e);
    }
  }

  return { byFullPath, byBareName, all: entries };
}

/** 判断某个字体文件是否已在系统中登记 */
export function findRegistration(
  lookup: RegistryLookup,
  filePath: string
): RegistryFontEntry | undefined {
  const full = lookup.byFullPath.get(normalizePath(filePath));
  if (full) return full;
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase();
  if (name) return lookup.byBareName.get(name);
  return undefined;
}
