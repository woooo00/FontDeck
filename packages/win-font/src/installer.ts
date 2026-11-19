/**
 * 字体安装 / 卸载
 *
 * 设计原则：宁可少做，不可做错。
 * - 只写用户级（HKCU + %LOCALAPPDATA%\Microsoft\Windows\Fonts），不碰系统目录
 * - 卸载只针对「我们自己装过的」（台账记录），系统字体一律只读
 * - 卸载不真删，文件移到 %LOCALAPPDATA%\FontDeck\backup\，可还原
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  addFontResource,
  broadcastFontChange,
  deleteFontRegistryValue,
  removeFontResource,
  writeFontRegistryValue,
} from "./win32.js";
import { parseFontFile } from "../../font-core/src/parse.js";

/* ------------------------------------------------------------------ */
/* 路径                                                                */
/* ------------------------------------------------------------------ */

export function userFontsDir(): string {
  const local =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "Microsoft", "Windows", "Fonts");
}

export function dataDir(): string {
  const local =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "FontDeck");
}

function backupDir(): string {
  return path.join(dataDir(), "backup");
}

function ledgerPath(): string {
  return path.join(dataDir(), "installed.json");
}

/* ------------------------------------------------------------------ */
/* 台账                                                                */
/* ------------------------------------------------------------------ */

export interface InstalledFace {
  postScriptName: string;
  family: string;
  subfamily: string;
  regName: string;
}

export interface InstalledRecord {
  id: string;
  filePath: string;
  fileName: string;
  sourcePath: string;
  installedAt: string;
  fileSize: number;
  faces: InstalledFace[];
  status: "installed" | "uninstalled";
  backupPath?: string;
  uninstalledAt?: string;
}

interface Ledger {
  version: number;
  records: InstalledRecord[];
}

export function readLedger(): Ledger {
  try {
    const raw = fs.readFileSync(ledgerPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.records)) return parsed;
  } catch {
    /* 没有台账是正常状态 */
  }
  return { version: 1, records: [] };
}

function writeLedger(ledger: Ledger): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(ledgerPath(), JSON.stringify(ledger, null, 1), "utf-8");
}

export function listInstalled(): InstalledRecord[] {
  return readLedger().records.filter((r) => r.status === "installed");
}

/* ------------------------------------------------------------------ */
/* 注册名                                                              */
/* ------------------------------------------------------------------ */

/** Windows 字体注册表的显示名：`Family Subfamily (TrueType)` */
export function makeRegName(family: string, subfamily: string): string {
  const f = (family || "").trim();
  const s = (subfamily || "").trim();
  const isRegular = /^(regular|normal|book|roman)$/i.test(s);
  const base = !s || isRegular ? f : `${f} ${s}`;
  return `${base} (TrueType)`;
}

/* ------------------------------------------------------------------ */
/* 安装                                                                */
/* ------------------------------------------------------------------ */

export interface InstallOptions {
  /** 已存在的注册名集合，用于查重 */
  existingRegNames: Set<string>;
  /** 覆盖已存在的同名字体（默认 false） */
  overwrite?: boolean;
}

export interface InstallResult {
  ok: boolean;
  error?: string;
  record?: InstalledRecord;
  addedFaces?: number;
}

function uniqueTargetPath(dir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  let candidate = path.join(dir, fileName);
  let n = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-fd${n}${ext}`);
    n++;
    if (n > 200) throw new Error("重名文件过多，放弃");
  }
  return candidate;
}

export function installFontFile(
  sourcePath: string,
  options: InstallOptions
): InstallResult {
  try {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
      return { ok: false, error: "文件不存在" };
    }

    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) return { ok: false, error: "不是文件" };

    const ext = path.extname(sourcePath).toLowerCase();
    if (![".ttf", ".otf", ".ttc", ".otc"].includes(ext)) {
      return {
        ok: false,
        error: `不支持的格式 ${ext}（仅支持 .ttf .otf .ttc .otc）`,
      };
    }

    const parsed = parseFontFile(sourcePath, "user");
    if (parsed.error || parsed.faces.length === 0) {
      return {
        ok: false,
        error: `字体解析失败：${parsed.error ?? "没有可用的字形"}`,
      };
    }

    const faces = parsed.faces;

    /* 查重：注册名已被别的字体占用就拒绝，避免把系统字体顶掉 */
    const conflicts = faces
      .map((f) => makeRegName(f.family, f.subfamily))
      .filter((name) => options.existingRegNames.has(name));

    if (conflicts.length > 0 && !options.overwrite) {
      return {
        ok: false,
        error: `已存在同名字体：${conflicts.slice(0, 3).join("、")}${
          conflicts.length > 3 ? " 等" : ""
        }`,
      };
    }

    const dir = userFontsDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = uniqueTargetPath(dir, path.basename(sourcePath));

    fs.copyFileSync(sourcePath, target);

    /* 写注册表：一个文件里的每个 face 写一条，都指向同一文件 */
    const written: string[] = [];
    const installedFaces: InstalledFace[] = [];
    try {
      for (const f of faces) {
        const regName = makeRegName(f.family, f.subfamily);
        writeFontRegistryValue(regName, target);
        written.push(regName);
        installedFaces.push({
          postScriptName: f.postScriptName,
          family: f.family,
          subfamily: f.subfamily,
          regName,
        });
      }
    } catch (e: any) {
      /* 注册表写到一半失败：回滚已写的值，删掉复制过去的文件 */
      for (const name of written) {
        try {
          deleteFontRegistryValue(name);
        } catch {
          /* ignore */
        }
      }
      try {
        fs.unlinkSync(target);
      } catch {
        /* ignore */
      }
      return { ok: false, error: `写注册表失败：${e.message}` };
    }

    const addedFaces = addFontResource(target);
    broadcastFontChange();

    const record: InstalledRecord = {
      id: `fd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      filePath: target,
      fileName: path.basename(target),
      sourcePath,
      installedAt: new Date().toISOString(),
      fileSize: stat.size,
      faces: installedFaces,
      status: "installed",
    };

    const ledger = readLedger();
    ledger.records.push(record);
    writeLedger(ledger);

    return { ok: true, record, addedFaces };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* 卸载                                                                */
/* ------------------------------------------------------------------ */

export interface UninstallResult {
  ok: boolean;
  error?: string;
  backupPath?: string;
}

export function uninstallFont(recordId: string): UninstallResult {
  try {
    const ledger = readLedger();
    const record = ledger.records.find(
      (r) => r.id === recordId && r.status === "installed"
    );

    if (!record) {
      return { ok: false, error: "台账里没有这条记录（只允许卸载本工具装过的字体）" };
    }

    /* 安全闸：文件必须位于用户字体目录内，绝不允许动系统目录 */
    const target = path.resolve(record.filePath);
    const fontsDir = path.resolve(userFontsDir());
    if (!target.toLowerCase().startsWith(fontsDir.toLowerCase() + path.sep)) {
      return { ok: false, error: "拒绝操作：该文件不在用户字体目录内" };
    }

    /* 1. 摘掉注册表登记 */
    const removedValues: string[] = [];
    for (const f of record.faces) {
      try {
        if (deleteFontRegistryValue(f.regName)) removedValues.push(f.regName);
      } catch {
        /* 单条失败继续 */
      }
    }

    /* 2. 从当前会话卸载 */
    removeFontResource(record.filePath);

    /* 3. 文件移到备份目录，不真删 */
    let backupPath: string | undefined;
    if (fs.existsSync(record.filePath)) {
      const dir = backupDir();
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      backupPath = path.join(dir, `${stamp}_${record.fileName}`);
      fs.renameSync(record.filePath, backupPath);
    }

    broadcastFontChange();

    record.status = "uninstalled";
    record.backupPath = backupPath;
    record.uninstalledAt = new Date().toISOString();
    writeLedger(ledger);

    return { ok: true, backupPath };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/* ------------------------------------------------------------------ */
/* 还原                                                                */
/* ------------------------------------------------------------------ */

export function restoreFont(recordId: string): UninstallResult {
  try {
    const ledger = readLedger();
    const record = ledger.records.find(
      (r) => r.id === recordId && r.status === "uninstalled"
    );
    if (!record) return { ok: false, error: "找不到可还原的记录" };
    if (!record.backupPath || !fs.existsSync(record.backupPath)) {
      return { ok: false, error: "备份文件已不存在" };
    }

    const dir = userFontsDir();
    fs.mkdirSync(dir, { recursive: true });
    const target = uniqueTargetPath(dir, record.fileName);
    fs.copyFileSync(record.backupPath, target);

    for (const f of record.faces) {
      writeFontRegistryValue(f.regName, target);
    }
    addFontResource(target);
    broadcastFontChange();

    record.filePath = target;
    record.fileName = path.basename(target);
    record.status = "installed";
    record.installedAt = new Date().toISOString();
    delete record.uninstalledAt;
    writeLedger(ledger);

    return { ok: true, backupPath: target };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
