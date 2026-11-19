/** 全量扫描：目录 + 注册表 → 字体索引 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildRegistryLookup,
  findRegistration,
  normalizePath,
  readFontRegistry,
  type RegistryLookup,
} from "./registry.js";
import {
  isIgnoredFile,
  isSupportedFontFile,
  makeFaceId,
  parseFontFile,
} from "./parse.js";
import type { FontFace, FontHealth, FontIndex, ScanStats } from "./types.js";

export interface ScanOptions {
  userFontDir?: string;
  systemFontDir?: string;
  /** 小于该字节数且已注册的字体标记为可疑（残片/子集） */
  suspiciousSize?: number;
  onProgress?: (done: number, total: number, current: string) => void;
}

const DEFAULT_SUSPICIOUS = 20 * 1024;

export function defaultFontDirs() {
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return {
    userFontDir: path.join(localAppData, "Microsoft", "Windows", "Fonts"),
    systemFontDir: path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts"),
  };
}

function listFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

function applyRegistration(
  face: FontFace,
  lookup: RegistryLookup,
  suspiciousSize: number
): void {
  const reg = findRegistration(lookup, face.filePath);
  face.registered = !!reg;
  if (reg) face.regName = reg.regName;

  if (!reg) {
    face.health = "unregistered";
    return;
  }
  if (face.fileSize < suspiciousSize && !face.format.startsWith("woff")) {
    face.health = "suspicious";
    return;
  }
  face.health = "ok";
}

/** 生成"注册表有登记但文件不存在"的僵尸 face */
function collectMissingFiles(
  lookup: RegistryLookup,
  knownPaths: Set<string>
): FontFace[] {
  const out: FontFace[] = [];
  for (const entry of lookup.all) {
    if (!/[\\/]/.test(entry.rawValue)) continue; // 纯文件名无法判断存在性
    const norm = normalizePath(entry.rawValue);
    if (knownPaths.has(norm)) continue;
    if (fs.existsSync(entry.rawValue)) continue;

    out.push({
      id: makeFaceId(entry.rawValue, 0),
      postScriptName: "",
      family: entry.regName.replace(/\s*\((TrueType|OpenType)\)\s*$/i, ""),
      subfamily: "",
      fullName: "",
      filePath: entry.rawValue,
      fileName: path.basename(entry.rawValue),
      collectionIndex: 0,
      format: path.extname(entry.rawValue).replace(".", "") || "unknown",
      fileSize: 0,
      mtimeMs: 0,
      weightClass: 400,
      isItalic: false,
      isFixedPitch: false,
      hasCJK: false,
      hasLatin: false,
      glyphCount: 0,
      isVariable: false,
      variationAxes: [],
      scope: entry.hive === "HKCU" ? "user" : "system",
      registered: true,
      regName: entry.regName,
      health: "missing-file",
      category: "unknown",
      fingerprint: "",
    });
  }
  return out;
}

function dedupe(faces: FontFace[]): number {
  const groups = new Map<string, FontFace[]>();
  for (const f of faces) {
    if (!f.postScriptName) continue;
    const key = f.postScriptName.trim().toLowerCase();
    const arr = groups.get(key);
    if (arr) arr.push(f);
    else groups.set(key, [f]);
  }

  let dupCount = 0;
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    // 保留优先级：已注册 > 系统目录 > 文件更大
    const sorted = [...arr].sort((a, b) => {
      if (a.registered !== b.registered) return a.registered ? -1 : 1;
      if (a.scope !== b.scope) return a.scope === "system" ? -1 : 1;
      return b.fileSize - a.fileSize;
    });
    const keep = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      sorted[i].duplicateOf = keep.id;
      dupCount++;
    }
  }
  return dupCount;
}

export function scanFonts(options: ScanOptions = {}): FontIndex {
  const started = Date.now();
  const dirs = { ...defaultFontDirs(), ...options };
  const userFontDir = options.userFontDir ?? dirs.userFontDir;
  const systemFontDir = options.systemFontDir ?? dirs.systemFontDir;
  const suspiciousSize = options.suspiciousSize ?? DEFAULT_SUSPICIOUS;

  const stats: ScanStats = {
    scannedFiles: 0,
    parsedFaces: 0,
    skipped: [],
    errors: [],
    byScope: { user: 0, system: 0, extra: 0 },
    byHealth: { ok: 0, unregistered: 0, "missing-file": 0, suspicious: 0 },
    duplicates: 0,
    durationMs: 0,
  };

  const registryEntries = readFontRegistry();
  const lookup = buildRegistryLookup(registryEntries);

  const targets: { dir: string; scope: "user" | "system" }[] = [
    { dir: userFontDir, scope: "user" },
    { dir: systemFontDir, scope: "system" },
  ];

  const faces: FontFace[] = [];
  const knownPaths = new Set<string>();
  let done = 0;
  let total = 0;
  for (const t of targets) total += listFiles(t.dir).length;

  for (const { dir, scope } of targets) {
    for (const file of listFiles(dir)) {
      done++;
      const base = path.basename(file);
      knownPaths.add(normalizePath(file));

      if (isIgnoredFile(base)) {
        stats.skipped.push({ file, reason: `ignored ext ${path.extname(base)}` });
        options.onProgress?.(done, total, base);
        continue;
      }
      if (!isSupportedFontFile(base)) {
        stats.skipped.push({ file, reason: "unsupported ext" });
        options.onProgress?.(done, total, base);
        continue;
      }

      stats.scannedFiles++;
      const result = parseFontFile(file, scope);
      if (result.error) {
        stats.errors.push({ file, error: result.error });
      }
      for (const face of result.faces) {
        applyRegistration(face, lookup, suspiciousSize);
        faces.push(face);
      }
      options.onProgress?.(done, total, base);
    }
  }

  // 僵尸项
  const missing = collectMissingFiles(lookup, knownPaths);
  faces.push(...missing);

  stats.duplicates = dedupe(faces);

  for (const f of faces) {
    stats.byScope[f.scope]++;
    stats.byHealth[f.health]++;
  }
  stats.parsedFaces = faces.length;
  stats.durationMs = Date.now() - started;

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    machine: { userFontDir, systemFontDir },
    faces,
    stats,
  };
}
