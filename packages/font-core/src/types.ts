/** FontDeck 字体数据模型 */

export type FontScope = "user" | "system" | "extra";

/** 字体健康状态——「文件在目录里」不等于「字体装好了」 */
export type FontHealth =
  | "ok"              // 已注册，文件在，可正常使用
  | "unregistered"    // 文件在字体目录，但注册表没登记（装了一半）
  | "missing-file"    // 注册表有登记，但文件已不存在（僵尸项）
  | "suspicious";     // 文件异常小 / 解析失败，疑为残片或子集

export type FontCategory =
  | "serif"
  | "sans-serif"
  | "monospace"
  | "script"
  | "display"
  | "symbol"
  | "unknown";

export interface VariationAxis {
  tag: string;
  name: string;
  min: number;
  default: number;
  max: number;
}

export interface FontFace {
  /** 稳定 ID：文件路径 + 集合索引 的哈希 */
  id: string;
  postScriptName: string;
  /** 优选家族名（preferredFamily，不带字重后缀） */
  family: string;
  familyZh?: string;
  subfamily: string;
  subfamilyZh?: string;
  fullName: string;

  filePath: string;
  fileName: string;
  /** .ttc 集合内的索引，单文件为 0 */
  collectionIndex: number;
  format: string;
  fileSize: number;
  mtimeMs: number;

  weightClass: number;
  isItalic: boolean;
  isFixedPitch: boolean;

  hasCJK: boolean;
  hasLatin: boolean;
  glyphCount: number;

  isVariable: boolean;
  variationAxes: VariationAxis[];

  scope: FontScope;
  registered: boolean;
  regName?: string;
  health: FontHealth;

  category: FontCategory;
  /** 去重指纹（大小 + 头部哈希） */
  fingerprint: string;
  /** 若与其它 face 重复，指向对方的 id */
  duplicateOf?: string;
}

export interface ScanStats {
  scannedFiles: number;
  parsedFaces: number;
  skipped: { file: string; reason: string }[];
  errors: { file: string; error: string }[];
  byScope: Record<FontScope, number>;
  byHealth: Record<FontHealth, number>;
  duplicates: number;
  durationMs: number;
}

export interface FontIndex {
  version: number;
  generatedAt: string;
  machine: {
    userFontDir: string;
    systemFontDir: string;
  };
  faces: FontFace[];
  stats: ScanStats;
}
