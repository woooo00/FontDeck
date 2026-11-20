/**
 * 更新下载与安装。
 *
 * 为什么下载放在服务端，而不是面板里 fetch：
 * GitHub 的 Release 资产域名（release-assets.githubusercontent.com）不返回
 * Access-Control-Allow-Origin，Chromium 里 fetch 直接被拦 —— 这一点实测过，
 * 不是猜测。版本检查能过是因为 api.github.com 带 CORS，资产下载不带。
 *
 * 服务端下载还有个附带好处：几十 MB 直接落盘，不在 CEP 的渲染进程里
 * 堆一个大 ArrayBuffer。
 *
 * 代价是 Node 不走系统代理（它只认环境变量），而国内访问 GitHub 基本都要代理。
 * 所以这里要自己把代理找出来：环境变量 → 注册表（WinINet 设置）→ 直连。
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import tls from "node:tls";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";

import koffi from "koffi";

import { extractTo, readZip } from "./zip.js";

/* ------------------------------------------------------------------ 安装位置 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const FD_HOME = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "FontDeck") : "";
const FD_APP_DIR = FD_HOME ? path.join(FD_HOME, "app") : "";
const CEP_PANEL_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, "Adobe", "CEP", "extensions", "com.fontdeck.panel")
  : "";

/**
 * 当前进程是不是跑在「安装版」里。
 *
 * 开发时服务是从源码目录起的，这种情况下写 current 会把用户的面板悄悄
 * 切到安装版，之后再也不读源码 —— 对开发是破坏性的。非安装目录直接拒绝。
 */
export function isInstalledCopy(): boolean {
  if (!FD_APP_DIR) return false;
  const root = path.resolve(ROOT).toLowerCase();
  const base = path.resolve(FD_APP_DIR).toLowerCase();
  return root.startsWith(base + path.sep);
}

export type Phase = "idle" | "downloading" | "installing" | "done" | "error";

export type UpdateState = {
  phase: Phase;
  version: string;
  received: number;
  total: number;
  /** 出错时的中文说明，直接给用户看 */
  error: string;
  appDir: string;
  panelUpdated: boolean;
  panelError: string;
  /** 走过去的是直连还是代理，排障用 */
  via: string;
  startedAt: number;
};

const state: UpdateState = {
  phase: "idle",
  version: "",
  received: 0,
  total: 0,
  error: "",
  appDir: "",
  panelUpdated: false,
  panelError: "",
  via: "",
  startedAt: 0,
};

export function getUpdateState(): UpdateState {
  return { ...state };
}

export function isBusy(): boolean {
  return state.phase === "downloading" || state.phase === "installing";
}

/* ------------------------------------------------------------------ 代理 */

function normProxy(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (!/^[a-z]+:\/\//i.test(s)) s = "http://" + s;
  try {
    const u = new URL(s);
    if (!u.hostname) return "";
    return u.protocol + "//" + u.hostname + (u.port ? ":" + u.port : "");
  } catch {
    return "";
  }
}

/**
 * 从 WinINet 设置里读系统代理。
 *
 * 不用 reg.exe：这台机器（以及部分企业环境）直接封了它。走 koffi 调
 * advapi32 更稳，项目里读字体注册表已经是这个路子。
 */
function readRegistryProxy(): string {
  try {
    const advapi32 = koffi.load("advapi32.dll");

    const RegOpenKeyExW = advapi32.func(
      "long __stdcall RegOpenKeyExW(uintptr_t hKey, str16 lpSubKey, uint32_t ulOptions, uint32_t samDesired, _Out_ uintptr_t *phkResult)"
    );
    const RegQueryValueExW = advapi32.func(
      "long __stdcall RegQueryValueExW(uintptr_t hKey, str16 lpValueName, void *lpReserved, _Out_ uint32_t *lpType, _Out_ void *lpData, _Inout_ uint32_t *lpcbData)"
    );
    const RegCloseKey = advapi32.func("long __stdcall RegCloseKey(uintptr_t hKey)");

    const HKCU = 0x80000001n;
    const KEY_READ = 0x20019;
    const SUBKEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

    const hKeyBuf = [0n];
    if (RegOpenKeyExW(HKCU, SUBKEY, 0, KEY_READ, hKeyBuf) !== 0) return "";
    const hKey = hKeyBuf[0];

    try {
      const readDword = (name: string): number => {
        const data = Buffer.alloc(4);
        const cb = [4];
        const typeOut = [0];
        if (RegQueryValueExW(hKey, name, null, typeOut, data, cb) !== 0) return 0;
        return data.readUInt32LE(0);
      };

      const readString = (name: string): string => {
        const data = Buffer.alloc(4096);
        const cb = [4096];
        const typeOut = [0];
        if (RegQueryValueExW(hKey, name, null, typeOut, data, cb) !== 0) return "";
        /* REG_SZ 是 UTF-16LE，末尾可能带 \0 */
        return data.subarray(0, cb[0]).toString("utf16le").replace(/\0+$/, "");
      };

      if (!readDword("ProxyEnable")) return "";

      const server = readString("ProxyServer");
      if (!server) return "";

      /* 可能是 "127.0.0.1:7890"，也可能是 "http=..;https=.." */
      if (server.indexOf("=") >= 0) {
        const parts = server.split(";");
        let httpsPart = "";
        let httpPart = "";
        for (const p of parts) {
          const eq = p.indexOf("=");
          if (eq < 0) continue;
          const k = p.slice(0, eq).trim().toLowerCase();
          const v = p.slice(eq + 1).trim();
          if (k === "https") httpsPart = v;
          else if (k === "http") httpPart = v;
        }
        return normProxy(httpsPart || httpPart);
      }
      return normProxy(server);
    } finally {
      try {
        RegCloseKey(hKey);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* 读不到就当没有，直连兜底 */
    return "";
  }
}

function resolveProxy(): { url: string; source: string } {
  const env =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy;
  if (env) return { url: normProxy(env), source: "env" };

  /* 明确要求不走代理时，尊重它 */
  if (process.env.FONTDECK_NO_PROXY === "1") return { url: "", source: "direct" };

  const reg = readRegistryProxy();
  if (reg) return { url: reg, source: "registry" };

  return { url: "", source: "direct" };
}

/* ------------------------------------------------------------------ HTTP */

/** 通过代理打通一条到目标主机的 TLS 隧道 */
function openTunnel(proxyUrl: string, host: string, port: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const req = http.request({
      host: p.hostname,
      port: p.port ? Number(p.port) : 80,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      timeout: 15000,
    });

    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error("代理拒绝连接（HTTP " + res.statusCode + "）"));
        return;
      }
      const t = tls.connect({ socket, servername: host }, () => resolve(t));
      t.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("连接代理超时"));
    });
    req.on("error", (e) => reject(new Error("连不上代理 " + p.host + "：" + e.message)));
    req.end();
  });
}

/** 复用一个已经建好的隧道的 Agent —— 一次下载只用一个连接，不做池化 */
class TunnelAgent extends https.Agent {
  private sock: tls.TLSSocket | null;
  constructor(sock: tls.TLSSocket) {
    super({ keepAlive: false, maxSockets: 1 });
    this.sock = sock;
  }
  createConnection(
    _opts: http.RequestOptions,
    cb?: (err: Error | null, stream: Duplex) => void
  ): Duplex | null {
    const s = this.sock;
    this.sock = null;
    // 正常路径 s 必有值且只取用一次（keepAlive:false / maxSockets:1）
    if (cb) cb(null, s as Duplex);
    return s;
  }
}

type Res = { stream: NodeJS.ReadableStream; status: number; headers: Record<string, any> };

function fetchStream(urlStr: string, proxyUrl: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === "https:";
    const port = u.port ? Number(u.port) : isHttps ? 443 : 80;

    const headers: Record<string, string> = {
      "User-Agent": "FontDeck-Updater",
      Accept: "*/*",
    };

    const done = (res: http.IncomingMessage) => {
      resolve({ stream: res, status: res.statusCode ?? 0, headers: res.headers });
    };

    if (!isHttps) {
      /* 明文目标：让代理转发绝对 URL 即可，不用隧道 */
      const opts: any = {
        host: u.hostname,
        port,
        path: u.pathname + u.search,
        method: "GET",
        headers,
        timeout: 20000,
      };
      if (proxyUrl) {
        const p = new URL(proxyUrl);
        opts.host = p.hostname;
        opts.port = p.port ? Number(p.port) : 80;
        opts.path = urlStr;
        opts.headers = { ...headers, Host: u.host };
      }
      const req = http.request(opts, done);
      req.on("timeout", () => req.destroy(new Error("请求超时")));
      req.on("error", reject);
      req.end();
      return;
    }

    if (!proxyUrl) {
      const req = https.request(
        {
          host: u.hostname,
          port,
          path: u.pathname + u.search,
          method: "GET",
          headers,
          timeout: 20000,
        },
        done
      );
      req.on("timeout", () => req.destroy(new Error("请求超时")));
      req.on("error", reject);
      req.end();
      return;
    }

    openTunnel(proxyUrl, u.hostname, port)
      .then((sock) => {
        const req = https.request(
          {
            host: u.hostname,
            port,
            path: u.pathname + u.search,
            method: "GET",
            headers,
            agent: new TunnelAgent(sock),
            timeout: 20000,
          },
          done
        );
        req.on("timeout", () => req.destroy(new Error("请求超时")));
        req.on("error", reject);
        req.end();
      })
      .catch(reject);
  });
}

/** 下载到文件，自动跟随重定向。返回走过的跳转次数（便于排障） */
async function downloadToFile(url: string, dest: string, proxyUrl: string): Promise<void> {
  let current = url;

  for (let hop = 0; hop < 6; hop++) {
    const res = await fetchStream(current, proxyUrl);

    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      const next = new URL(String(res.headers.location), current).toString();
      (res.stream as any).resume?.();
      current = next;
      continue;
    }

    if (res.status !== 200) {
      (res.stream as any).resume?.();
      throw new Error("下载失败，服务器返回 HTTP " + res.status);
    }

    const total = Number(res.headers["content-length"] || 0);
    state.total = total;
    state.received = 0;

    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      let received = 0;

      res.stream.on("data", (chunk: Buffer) => {
        received += chunk.length;
        state.received = received;
      });
      res.stream.on("error", (e: Error) => {
        out.destroy();
        reject(e);
      });
      out.on("error", reject);
      out.on("finish", () => resolve());
      res.stream.pipe(out);
    });

    /* 长度对不上说明传输被截断了，装下去就是个坏包 */
    if (state.total && state.received !== state.total) {
      throw new Error("下载不完整（" + state.received + " / " + state.total + " 字节）");
    }
    return;
  }

  throw new Error("重定向次数过多");
}

/* ------------------------------------------------------------------ 安装 */

function applyPackage(zipPath: string, wantVersion: string) {
  const buf = fs.readFileSync(zipPath);
  const entries = readZip(buf);

  const verEntry = entries.find((e) => e.name === "VERSION" || e.name.endsWith("/VERSION"));
  if (!verEntry) throw new Error("更新包里没有 VERSION 文件，可能不是 FontDeck 的包");

  const prefix = verEntry.name === "VERSION" ? "" : verEntry.name.slice(0, -"VERSION".length);
  const ver = verEntry.data.toString("utf8").trim();

  if (wantVersion && ver !== wantVersion) {
    throw new Error("更新包版本是 " + ver + "，与请求的 " + wantVersion + " 不一致");
  }
  if (!/^\d+\.\d+\.\d+$/.test(ver)) throw new Error("版本号格式不合法: " + ver);

  if (!entries.some((e) => e.name.startsWith(prefix + "app/"))) {
    throw new Error("更新包里没有 app 目录");
  }

  fs.mkdirSync(FD_APP_DIR, { recursive: true });

  /* 同名目录已存在时不覆盖：Windows 上改名/删除正在被使用的目录会失败 */
  let target = path.join(FD_APP_DIR, ver);
  if (fs.existsSync(target)) target = path.join(FD_APP_DIR, ver + "-r" + Date.now());

  const tmp = target + ".tmp";
  fs.rmSync(tmp, { recursive: true, force: true });

  /* 剥掉顶层 FontDeck-<ver>/ 和 app/ 两层，让 target 直接是应用根 */
  const files = extractTo(
    entries,
    tmp,
    (n) => n.startsWith(prefix + "app/"),
    prefix + "app/"
  );
  if (files === 0) throw new Error("更新包解压后没有任何文件");

  /* 结构自检：装出一个"返回成功但起不来"的版本，比装失败糟糕得多 */
  for (const rel of ["package.json", "launcher.pyw", "apps/service/src/main.ts"]) {
    if (!fs.existsSync(path.join(tmp, rel))) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error("更新包结构不完整，缺少 " + rel);
    }
  }

  fs.renameSync(tmp, target);

  let panelUpdated = false;
  let panelError = "";
  if (entries.some((e) => e.name.startsWith(prefix + "panel/")) && CEP_PANEL_DIR) {
    try {
      fs.mkdirSync(CEP_PANEL_DIR, { recursive: true });
      extractTo(entries, CEP_PANEL_DIR, (n) => n.startsWith(prefix + "panel/"), prefix + "panel/");
      panelUpdated = true;
    } catch (e: any) {
      panelError = e?.message ?? String(e);
    }
  }

  const curFile = path.join(FD_HOME, "current");
  try {
    if (fs.existsSync(curFile)) {
      const old = fs.readFileSync(curFile, "utf8").trim();
      if (old && path.resolve(old) !== path.resolve(target)) {
        fs.writeFileSync(path.join(FD_HOME, "current.previous"), old + "\n", "utf8");
      }
    }
  } catch {
    /* 备份失败不影响装新版本 */
  }
  fs.writeFileSync(curFile, target + "\n", "utf8");

  return { version: ver, appDir: target, files, panelUpdated, panelError };
}

/* ------------------------------------------------------------------ 任务 */

/**
 * 启动一次更新：下载 → 校验 → 安装。
 *
 * 故意做成"后台跑 + 前端轮询"，而不是一个长连接的 POST：
 * 几百 MB 的请求体挂在 HTTP 上，任何一次网络抖动都会让前端分不清
 * "服务端还在下" 和 "已经卡死"。轮询能随时告诉用户进行到哪一步。
 */
export function startUpdate(version: string, url: string): UpdateState {
  if (isBusy()) return getUpdateState();

  state.phase = "downloading";
  state.version = version;
  state.received = 0;
  state.total = 0;
  state.error = "";
  state.appDir = "";
  state.panelUpdated = false;
  state.panelError = "";
  state.startedAt = Date.now();

  const proxy = resolveProxy();
  state.via = proxy.url ? proxy.url.replace(/\/\/.*@/, "//") + " (" + proxy.source + ")" : "直连";

  const dlDir = path.join(FD_HOME, "downloads");
  const tmpZip = path.join(dlDir, "FontDeck-" + version + ".zip");

  (async () => {
    try {
      fs.mkdirSync(dlDir, { recursive: true });

      await downloadToFile(url, tmpZip, proxy.url);

      state.phase = "installing";
      const out = applyPackage(tmpZip, version);

      state.appDir = out.appDir;
      state.panelUpdated = out.panelUpdated;
      state.panelError = out.panelError;
      state.phase = "done";

      /* 装完把包删掉，别在用户磁盘上留 40MB 垃圾 */
      try {
        fs.unlinkSync(tmpZip);
      } catch {
        /* ignore */
      }
    } catch (e: any) {
      state.phase = "error";
      state.error = e?.message ?? String(e);
      try {
        fs.unlinkSync(tmpZip);
      } catch {
        /* ignore */
      }
    }
  })();

  return getUpdateState();
}
