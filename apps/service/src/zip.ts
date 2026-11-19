/**
 * 最小 ZIP 读取器。
 *
 * 为什么自己写：更新包需要解压，而 Node 没有内置 unzip。为这一个动作引入
 * adm-zip / yauzl 要重新过一遍依赖与打包流程，体积和风险都不划算 ——
 * 我们自己产出的 zip 只用 store / deflate，格式固定，一百行足够。
 *
 * 不支持：ZIP64、加密、分卷。我们的包 390MB / 3600 个文件，碰不到这些边界；
 * 真碰上了会明确报错，而不是读出半个文件。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export type ZipEntry = {
  /** zip 内部的相对路径，已统一成正斜杠 */
  name: string;
  /** 目录条目的名字以 / 结尾，data 为空 */
  dir: boolean;
  data: Buffer;
};

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function findEocd(buf: Buffer): number {
  // EOCD 在末尾，后面可能跟最长 65535 字节的注释
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

export function readZip(buf: Buffer): ZipEntry[] {
  if (buf.length < 22) throw new Error("不是有效的 zip：文件太小");

  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("不是有效的 zip：找不到目录结尾");

  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (cdOffset + cdSize > buf.length) throw new Error("zip 目录越界，文件可能不完整");
  if (cdOffset === 0xffffffff || total === 0xffff) {
    throw new Error("不支持 ZIP64 格式的包");
  }

  const out: ZipEntry[] = [];
  let p = cdOffset;

  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length) throw new Error("zip 目录被截断");
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) throw new Error("zip 目录签名不匹配");

    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);

    const name = buf
      .subarray(p + 46, p + 46 + nameLen)
      .toString("utf8")
      .replace(/\\/g, "/");

    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) {
      out.push({ name, dir: true, data: Buffer.alloc(0) });
      continue;
    }

    if (localOff + 30 > buf.length) throw new Error("zip 条目越界: " + name);
    if (buf.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error("zip 本地头签名不匹配: " + name);

    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) throw new Error("zip 数据被截断: " + name);

    const raw = buf.subarray(dataStart, dataEnd);
    let data: Buffer;
    if (method === 0) {
      data = Buffer.from(raw);
    } else if (method === 8) {
      data = zlib.inflateRawSync(raw);
    } else {
      throw new Error("不支持的压缩方式 " + method + ": " + name);
    }

    if (rawSize !== 0 && data.length !== rawSize) {
      throw new Error("解压后长度不符: " + name);
    }

    out.push({ name, dir: false, data });
  }

  return out;
}

/**
 * 把条目安全地铺到磁盘。
 *
 * 路径要防穿越：zip 里的名字是外部输入（哪怕是我们自己打的包，
 * 也要假设它可能被替换过），"../../x.dll" 这种必须拒绝。
 */
export function extractTo(
  entries: ZipEntry[],
  destDir: string,
  filter?: (name: string) => boolean,
  stripPrefix = ""
): number {
  const root = path.resolve(destDir);
  let count = 0;

  for (const e of entries) {
    if (filter && !filter(e.name)) continue;

    /* 包顶层通常有一层目录（FontDeck-1.1.1/），落盘时要剥掉，
       否则文件会解到 destDir/FontDeck-1.1.1/... 下 */
    let rel = e.name;
    if (stripPrefix && rel.startsWith(stripPrefix)) rel = rel.slice(stripPrefix.length);
    if (!rel) continue;

    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error("包内路径越界，已拒绝: " + e.name);
    }

    if (e.dir) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, e.data);
    count++;
  }

  return count;
}
