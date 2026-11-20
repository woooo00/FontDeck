/**
 * OCR 引擎（Node 侧）：管理常驻 Python 子进程。
 *
 * 为什么是 Python：
 * 中文准确率代差明显。实测同样一张「永和九年岁在癸丑」，
 * tesseract.js 出「水和九年岁在奖丑」，RapidOCR（PaddleOCR 的 ONNX 版）逐字 97.7%。
 * 代价是架构上多一层子进程，值得。
 *
 * 为什么常驻：
 * 模型加载 0.3s，逐字新起进程的话 20 个字就是 6 秒。常驻后每字约 6ms。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface OcrResult {
  text: string;
  score: number;
  error?: string;
  /** 传入时的框，原样带回，方便调用方对齐 */
  box?: number[];
  /** 原稿是深底白字时 worker 会反相，这里回报以便排查 */
  polarity?: "dark" | "light";
}

/** 裁剪识别用：像素框 [左, 上, 右, 下] */
export type PixelBox = [number, number, number, number];

/**
 * Python 解释器优先级：
 *   1) 环境变量（排障时强制指定）
 *   2) 随包带的便携运行时 —— 安装版走这条，别人的机器上只有这份
 *   3) 本机开发环境（直接在源码目录里跑时用）
 *   4) 系统 PATH 里的 python（最后兜底，通常会因为缺 rapidocr 起不来）
 *
 * 顺序不能反：安装版机器上并不存在第 3 条那个路径，先探到它就等于每次
 * 启动都要走一遍失败分支。
 */
const APP_ROOT = path.resolve(__dirname, "..", "..", "..");
const PYTHON_CANDIDATES = [
  process.env.FONTDECK_PYTHON,
  /* 安装版：<FontDeck>/runtime 与 <FontDeck>/app/<ver> 并列 */
  path.join(APP_ROOT, "..", "..", "runtime", "python", "python.exe"),
  /* 开发/源码目录：runtime 就在项目根下 */
  path.join(APP_ROOT, "runtime", "python", "python.exe"),
  "C:\\Users\\6\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe",
  "python",
].filter(Boolean) as string[];

function resolvePython(): string | null {
  for (const p of PYTHON_CANDIDATES) {
    if (p === "python") return p;
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function resolveWorker(): string {
  // worker.py 和本文件在同一目录（src/ 与 worker.py 同级）
  const beside = path.join(__dirname, "worker.py");
  if (fs.existsSync(beside)) return beside;
  return path.join(__dirname, "..", "worker.py");
}

type Pending = {
  resolve: (v: OcrResult[]) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export class OcrEngine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private seq = 1;
  private pending = new Map<number, Pending>();
  private ready = false;
  private starting: Promise<void> | null = null;
  private failures = 0;

  get isReady(): boolean {
    return this.ready;
  }

  /** 启动并等待模型就绪。并发调用只会真正启动一次。 */
  async start(): Promise<void> {
    if (this.ready) return;
    if (this.starting) return this.starting;

    this.starting = new Promise<void>((resolve, reject) => {
      const py = resolvePython();
      if (!py) {
        reject(new Error("找不到 Python 解释器（可设 FONTDECK_PYTHON 指定）"));
        return;
      }

      const worker = resolveWorker();
      if (!fs.existsSync(worker)) {
        reject(new Error(`找不到 OCR 脚本：${worker}`));
        return;
      }

      const proc = spawn(py, ["-u", worker], {
        // -u 关掉缓冲，否则响应会卡在管道里
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.proc = proc as ChildProcessWithoutNullStreams;

      const failTimer = setTimeout(() => {
        if (!this.ready) {
          reject(new Error("OCR 引擎启动超时（30s）"));
        }
      }, 30000);

      proc.stdout.setEncoding("utf-8");
      proc.stdout.on("data", (chunk: string) => {
        this.buf += chunk;
        let idx: number;
        while ((idx = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, idx).trim();
          this.buf = this.buf.slice(idx + 1);
          if (line) this.onLine(line, resolve, reject, failTimer);
        }
      });

      proc.stderr.setEncoding("utf-8");
      proc.stderr.on("data", (s: string) => {
        const msg = String(s).trim();
        if (!msg) return;
        // Python 的告警很多，只有真错误才该冒出来
        if (/Error|Traceback|Exception/.test(msg)) {
          console.error("[ocr]", msg.split("\n").slice(-3).join(" | "));
        }
      });

      proc.on("exit", (code) => {
        this.ready = false;
        this.proc = null;
        this.starting = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`OCR 进程退出（code=${code}）`));
        }
        this.pending.clear();
      });
    }).catch((e) => {
      this.starting = null;
      throw e;
    });

    return this.starting;
  }

  private onLine(
    line: string,
    resolve: (() => void) | null,
    reject: ((e: Error) => void) | null,
    failTimer: NodeJS.Timeout
  ): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    /* 启动握手 */
    if (msg.ready === true) {
      this.ready = true;
      clearTimeout(failTimer);
      resolve?.();
      return;
    }
    if (msg.error && msg.id === 0) {
      clearTimeout(failTimer);
      reject?.(new Error(msg.error));
      return;
    }

    /* 识别结果 */
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);

    if (msg.error) {
      p.reject(new Error(msg.error));
      return;
    }
    p.resolve(msg.results ?? []);
  }

  /** 批量识别。一次通信处理多个字，省掉往返开销 */
  async recognizeMany(pngBase64: string[]): Promise<OcrResult[]> {
    if (pngBase64.length === 0) return [];
    if (!this.ready) await this.start();
    if (!this.proc) throw new Error("OCR 进程不可用");

    const id = this.seq++;

    return new Promise<OcrResult[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failures++;
        reject(new Error("OCR 识别超时（15s）"));
      }, 15000);

      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(JSON.stringify({ id, items: pngBase64 }) + "\n");
    });
  }

  async recognizeOne(pngBase64: string): Promise<OcrResult> {
    const [r] = await this.recognizeMany([pngBase64]);
    return r ?? { text: "", score: 0 };
  }

  /**
   * 从一张大图里按框裁剪再逐字识别。
   *
   * 走这条而不是「服务端自己切图再发 base64」：省掉一次编解码往返，
   * 而且图像增强（深底反相、补白边、补方形）都在 Python 侧用 OpenCV 做，
   * 比在 Node 里另外装图像库干净。
   */
  async recognizeCrops(
    pngPath: string,
    boxes: PixelBox[],
    pad = 3,
    dumpDir = ""
  ): Promise<OcrResult[]> {
    if (boxes.length === 0) return [];
    if (!this.ready) await this.start();
    if (!this.proc) throw new Error("OCR 进程不可用");

    const id = this.seq++;
    /* 单字超时按 1ms 估算太激，但几十个字也不该超过 30s */
    const timeout = Math.max(15000, boxes.length * 400);

    return new Promise<OcrResult[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failures++;
        reject(new Error(`裁剪识别超时（${timeout}ms）`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(
        JSON.stringify({ id, png: pngPath, boxes, pad, dump: dumpDir }) + "\n"
      );
    });
  }

  /**
   * 整行识别。逐字切框对西文不成立（字母不等宽、空格无轮廓），
   * 把整行图直接交给行识别器才能拿到带空格的完整句子。
   */
  async recognizeLines(pngPath: string, boxes: PixelBox[], pad = 3, vertical = false): Promise<OcrResult[]> {
    if (boxes.length === 0) return [];
    if (!this.ready) await this.start();
    if (!this.proc) throw new Error("OCR 进程不可用");

    const id = this.seq++;
    /*
     * 超时按行数放宽到 6s/行：18 行俄语在冷启动（ONNX 模型首次加载）
     * 下实测要 50s，原来 3s/行 = 54s 只剩 4s 余量，机器一忙就擦边 500。
     */
    const timeout = Math.max(60000, boxes.length * 6000);

    return new Promise<OcrResult[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failures++;
        reject(new Error(`整行识别超时（${timeout}ms）`));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(
        JSON.stringify({ id, cmd: "line", png: pngPath, boxes, pad, vertical }) + "\n"
      );
    });
  }

  /**
   * 「整块文字被旋转 180°」的低置信度自检。
   *
   * 只把渲染图翻 180° 重跑一次整行 OCR，返回分数和文本，**不改变主链路
   * 的任何识别结果**。服务侧只在原图平均分极低时调用，正常稿零开销。
   * 任意角度的旋转摆正是冻结项，这里只处理离散、精确可逆的 180°。
   */
  async flipCheck(
    pngPath: string,
    boxes: number[][],
    outPath: string,
    vertical = false
  ): Promise<{ lines: OcrResult[]; avg: number; png: string }> {
    if (boxes.length === 0) return { lines: [], avg: 0, png: "" };
    if (!this.ready) await this.start();
    if (!this.proc) throw new Error("OCR 进程不可用");

    const id = this.seq++;
    const timeout = Math.max(60000, boxes.length * 6000);
    const raw = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failures++;
        reject(new Error(`倒转自检超时（${timeout}ms）`));
      }, timeout);
      this.pending.set(id, { resolve: (v: any) => resolve(v), reject, timer });
      this.proc!.stdin.write(
        JSON.stringify({
          id,
          cmd: "flipcheck",
          png: pngPath,
          boxes,
          out: outPath,
          vertical,
        }) + "\n"
      );
    });
    const info = Array.isArray(raw) ? raw[0] : raw;
    return {
      lines: Array.isArray(info?.lines) ? info.lines : [],
      avg: Number(info?.avg ?? 0),
      png: String(info?.png ?? ""),
    };
  }

  /**
   * 按墨迹空隙把一行拆成 n 段。
   *
   * 和「自动检测样式变化」不是一回事：这里不从像素推断哪里换了字体，
   * 只按用户给的段数，在接近等分位置找**真实空白列**下刀。空白列必然
   * 存在，所以每段都是完整字形，不会切断笔画。
   */
  async splitLine(
    pngPath: string,
    box: number[],
    n: number,
    vertical = false
  ): Promise<Array<{ l: number; t: number; r: number; b: number }>> {
    if (!this.ready) await this.start();
    if (!this.proc) throw new Error("OCR 进程不可用");

    const id = this.seq++;
    const raw = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failures++;
        reject(new Error("行拆分超时（15s）"));
      }, 15000);
      this.pending.set(id, { resolve: (v: any) => resolve(v), reject, timer });
      this.proc!.stdin.write(
        JSON.stringify({ id, cmd: "splitline", png: pngPath, box, n, vertical }) + "\n"
      );
    });
    const info = Array.isArray(raw) ? raw[0] : raw;
    return Array.isArray(info?.segments) ? info.segments : [];
  }

  /**
   * 用整行形状比对候选字体，返回与 candidates 同 id 的相似度。
   *
   * `slices` 是逐字/粘连切片：整行在长文本上分辨率不够（19 个字符挤进
   * 1024 列，每个只摊到 3 个网格列），前几名会挤在 2% 的窄带里。
   * 传切片后 Python 侧改用「2~3 个字符铺满 64 列」的高分辨率比对。
   */
  async compareLineFonts(
    pngPath: string,
    targets: Array<{ box: number[] | null; text: string; weight?: number }>,
    candidates: Array<{ id: string; path: string; index: number }>,
    slices?: Array<{ box: number[]; text: string }>,
    vertical = false
  ): Promise<Array<{ id: string; score: number; weightFit?: number; widthRatio?: number }>> {
    if (targets.length === 0 || candidates.length === 0) return [];
    if (!this.ready) await this.start();
    if (!this.proc) throw new Error("OCR 进程不可用");

    const id = this.seq++;
    const raw = await new Promise<any>((resolve, reject) => {
      /* 长文本（俄语 18 行）字体比对要 20~40 秒，30 秒会偶发 500。
         这里放到 180 秒，前端有进度条，用户能看见还在跑。 */
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("整行字体比对超时（180s）"));
      }, 180000);
      this.pending.set(id, { resolve: (v: any) => resolve(v), reject, timer });
      this.proc!.stdin.write(
        JSON.stringify({
          id,
          cmd: "linefont",
          png: pngPath,
          targets,
          candidates,
          slices: slices ?? [],
          vertical,
        }) + "\n"
      );
    });
    const info = Array.isArray(raw) ? raw[0] : raw;
    return info?.scores ?? [];
  }

  /**
   * 字体垂直度量。
   *
   * `descent`：行框底比基线低多少（em）—— Illustrator 的 visibleBounds 下边
   * 就是行框底，直接拿它对齐原稿墨迹底会让整行按 descender 上移。
   * `inkBottom`：这行字在该字体下的实际墨迹底比基线低多少（em，负数表示墨迹在基线之上）。
   * 两者相减就是「行框底 → 墨迹底」的补偿量，且随字体变化，所以必须逐个字体问。
   * `inkHeight`：渲染的墨迹高 / 字号（em），竖排字号按「单字墨迹高 ÷ 它」闭环。
   */
  async fontMetrics(
    fonts: Array<[string, number]>,
    text: string
  ): Promise<
    Array<{ path: string; index: number; descent: number; inkBottom: number; inkHeight: number }>
  > {
    if (!fonts.length) return [];
    if (!this.ready) await this.start();
    if (!this.proc) throw new Error("OCR 进程不可用");

    const id = this.seq++;
    const raw = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("字体度量超时（10s）"));
      }, 10000);
      this.pending.set(id, { resolve: (v: any) => resolve(v), reject, timer });
      this.proc!.stdin.write(
        JSON.stringify({ id, cmd: "metrics", fonts, text }) + "\n"
      );
    });
    const info = Array.isArray(raw) ? raw[0] : raw;
    return Array.isArray(info?.metrics) ? info.metrics : [];
  }

  /**
   * 按 Illustrator 回传的路径几何渲染位图。
   *
   * 存在的理由：原先让 AI 侧 doc.exportFile 导 PNG，在真实文档上会卡死
   * （导出期占用 UI 线程，evalScript 回调不返回）。改由 Python 画，
   * 顺带能精确算出每个轮廓的像素包围盒 —— 那是聚类要用的真值。
   */
  async renderGeometry(
    shapes: Array<{ c: number; p: number[][] }>,
    w: number,
    h: number,
    outPath: string,
    ss = 3,
    orientation: "h" | "v" = "h"
  ): Promise<{
    png: string;
    w: number;
    h: number;
    shapes: number[][];
    bands: number[][];
    /** 渲染时的方向；bands 语义由它决定（h: y 区间，v: x 区间） */
    orientation: "h" | "v";
    inkRatio: number;
    /** 倾斜稿摆正时记录逆变换；未摆正为 null */
    skew: {
      angle: number;
      cx: number;
      cy: number;
      dx: number;
      dy: number;
      w0: number;
      h0: number;
    } | null;
  }> {
    if (shapes.length === 0) throw new Error("没有轮廓数据");
    if (!this.ready) await this.start();
    if (!this.proc) throw new Error("OCR 进程不可用");

    const id = this.seq++;

    const raw = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("几何渲染超时（20s）"));
      }, 20000);

      /*
       * 复用 pending 表，但返回形状不是 results 数组的语义，
       * 这里用一个透传包装，和 vectorizeCrops 同样的处理。
       */
      this.pending.set(id, {
        resolve: (v: any) => resolve(v),
        reject,
        timer,
      });

      this.proc!.stdin.write(
        JSON.stringify({ id, cmd: "render", shapes, w, h, out: outPath, ss, orientation }) + "\n"
      );
    });

    const info = Array.isArray(raw) ? raw[0] : raw;
    if (!info || !info.png) throw new Error("渲染没有返回结果");
    return info;
  }

  /**
   * 按框取图并转成 256 维密度向量（16×16 墨迹占比）。
   * 返回的字符串是 base64 编码的 256 字节，和 Node 侧渲染候选字体得到的向量同构。
   */
  async vectorizeCrops(
    pngPath: string,
    boxes: PixelBox[],
    pad = 3
  ): Promise<(string | null)[]> {
    if (boxes.length === 0) return [];
    if (!this.ready) await this.start();
    if (!this.proc) throw new Error("OCR 进程不可用");

    const id = this.seq++;
    const timeout = Math.max(15000, boxes.length * 400);

    const raw = await new Promise<any[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.failures++;
        reject(new Error(`向量化超时（${timeout}ms）`));
      }, timeout);

      /* 复用 pending 表，但结果形状不同，这里用一个适配包装 */
      this.pending.set(id, {
        resolve: (v: any) => resolve(v as any),
        reject,
        timer,
      });
      this.proc!.stdin.write(
        JSON.stringify({ id, cmd: "vector", png: pngPath, boxes, pad }) + "\n"
      );
    });

    return raw.map((r: any) => (r && r.vector ? String(r.vector) : null));
  }

  /** 空闲回收时调用，别把 Python 进程留成僵尸 */
  stop(): void {
    this.ready = false;
    this.starting = null;
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
  }
}

let singleton: OcrEngine | null = null;

export function getOcrEngine(): OcrEngine {
  if (!singleton) singleton = new OcrEngine();
  return singleton;
}
