# FontDeck 工程审查（2026-11-17）

审查范围：`apps/` `packages/` `scripts/` 全部源码，排除 `node_modules`。
方法：读代码 + 实测（tsc / benchmark / 攻击面构造），不靠推测。
凡标「已修」的都已跑回归；标「建议」的未改代码，风险与取舍写在条目里。

---

## 0. 结论

| 级别 | 问题 | 状态 |
|---|---|---|
| **P1 安全** | 跨域写操作只校验 Host，任意网页可让本机安装字体 | **已修** |
| **P1 安全** | `Access-Control-Allow-Origin: *` 允许任意网页读取字体清单 | 残余（方案见 S2） |
| **P1 可靠性** | 请求级 promise 无兜底，进程级无异常钩子 | **已修** |
| **P2 可维护性** | `tsc --noEmit` 27 处报错，类型检查形同虚设 | **已修（0 错误）** |
| **P2 可维护性** | `package.json` 的 test 是占位符，无任何自动化关卡 | **已修** |
| **P2 可维护性** | 3 个 1400~2000 行巨型单文件 | 方案见 M3 |
| **P3 性能** | 字体比对 8~16s | 已实测，**明确不做**（理由见 §4） |

一句话结论：**功能逻辑没问题，问题集中在「边界」——网络边界、进程边界、文件边界、模块边界。**

---

## 1. 代码地图

| 文件 | 行数 | 职责 | 风险点 |
|---|---:|---|---|
| `apps/web/app.js` | 2014 | 面板全部前端逻辑 | 单文件、19 处 `innerHTML` |
| `apps/service/src/main.ts` | 1493 | HTTP 服务 + 13 条路由 + 报告生成 | 单文件、if 链路由 |
| `packages/ocr/worker.py` | 1425 | 常驻 OCR/渲染进程 | 单文件、无可测边界 |
| `apps/web/style.css` | 1331 | 面板样式 | — |
| `apps/cep/host/host.jsx` | 1149 | ExtendScript 宿主 | 原生崩溃高风险区 |

合计 80 个文件 / 19 610 行。前 5 个文件占 38%。

---

## 2. S1 跨域写入（P1，已修）

### 证据

`apps/service/src/main.ts:1269`（修改前）：

```ts
if (req.method === "OPTIONS") {              // 无条件 204，允许任意来源
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",      // 连自定义头都放开
    ...
if (req.method === "POST") {
  const host = (req.headers.host ?? "").split(":")[0];
  if (host !== "127.0.0.1" && host !== "localhost") ...   // ← 这条挡不住 CSRF
```

**为什么 Host 校验无效**：浏览器发起跨域请求时，`Host` 是**目标地址**（恒为
`127.0.0.1:47615`），与请求来源无关。所以这段代码只在直接拿 socket 打
`Host: evil.com` 时生效，对「恶意网页 fetch 本机端口」完全无效。

### 影响链

1. 用户浏览任意网页 → 该页 JS 执行 `fetch('http://127.0.0.1:47615/api/install-raw', {method:'POST', body: 恶意ttf})`
2. `main.ts:1197` 读 200MB body → 写 `data/uploads/` → `installFontFile()`
3. `installer.ts:139` 写 HKCU 注册表 + 复制字体到用户字体目录
4. 字体解析器（FreeType）处理不可信二进制 → 命中字体解析漏洞即为提权面

同时 `/api/install`（`main.ts:1182`）收客户端给的**任意本机路径**，虽然被扩展名
白名单 + `parseFontFile` 收窄，但仍可让攻击者把本机任意位置的字体装进注册表。

### 修复

只用两条规则，零改动调用方：

1. **`OPTIONS` 只对白名单 Origin 返回 204**，其余 403
   （白名单：空、`null`（CEP 是 `file://`）、`http://127.0.0.1[:port]`、`http://localhost[:port]`）
2. **`POST` 只接受 `application/json` / `application/octet-stream`**，其余 415

有效性推理：
- 想带 `application/json` 打进来 → 浏览器必先发 preflight → 被规则 1 拦掉，**实际请求不会发出**
- 想绕过 preflight → 只能用 `text/plain` / `form-urlencoded` / `multipart` → 被规则 2 拦掉

### 残余风险（S2，未修）

`json()` 仍写死 `Access-Control-Allow-Origin: *`（`main.ts:747/1415/1424`），
意味着任意网页可以**读取** GET 响应：`/api/installed`（已装字体）、`/api/fonts`、
`/api/stats` —— 足以做设备指纹。`/api/feedback/report` 只写不读，泄露面小。

方案：把 `*` 改成回显白名单 Origin。**本轮不做的原因**：`json()` 拿不到 `req`，
要改签名 + 同步 3 处静态资源响应头，而 CEP 面板一旦拿不到正确 CORS 头会直接白屏，
我无法在当前环境实机验证面板渲染，风险和收益不成比例。建议在能实机点开面板的
时段做，改完立刻回归 + 目视确认。

### S3 ExtendScript 注入（评估为低风险）

`apps/web/app.js:588`

```js
var safe = String(psName).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
evalJsx('fdApplyFont("' + safe + '")', 30000)
```

顺序正确（先转义反斜杠再转义引号），但**未处理换行**。字体 PostScript 名受规范
限制，实际不可达；`fdRecoverApply`（`app.js:1823`）用的是双重 `JSON.stringify`，
编码正确。建议后续统一改成「JSON 字符串当参数 + JSX 侧 `eval` 解析」，彻底断链。

---

## 3. R1 请求级异常兜底（P1，已修）

### 证据

`main.ts:1265`（修改前）

```ts
function handle(req, res) {
  ...
  handlePost(req, res, url);   // async 函数，返回值没人接
```

`handlePost` 是 `async`（`main.ts:788`），外层 try/catch 只能捕同步异常，
promise 泄漏成 `unhandledRejection`。

**诚实说明**：`handlePost` 内部整体包了 try/catch（`main.ts:1251`），所以
**当前没有已证实的触发路径**，这不是在修一个正在发生的崩溃。历史日志里出现过
「服务连续三次启动」，经核查是测试会话回收进程所致，与本条无关。加这层是
防御性加固：Node ≥15 默认 `--unhandled-rejections=throw`，一旦哪天有人把
`handlePost` 的 try/catch 拆细或新增 await 分支，未捕获的 reject 会直接杀进程。

### 修复

```ts
void handlePost(req, res, url).catch((e) => {
  if (!res.headersSent) json(res, { ok: false, error: e?.message ?? "internal" }, 500);
});

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", ...));
process.on("uncaughtException",  (e) => console.error("[uncaughtException]", ...));
```

取舍：`uncaughtException` 后进程状态可能不一致，Node 官方建议退出。这里选择
「记录不退出」——本地单用户工具，退出要重扫 781 个 face，可用性优先；
堆栈完整落进 `data/service.log`，足以定位。

---

## 4. 性能：实测后决定**不做**

字体比对是最大耗时（俄语 18 行 16.4s，三行英文 12.8s）。逐层实测：

| 假设 | 实测 | 结论 |
|---|---|---|
| `ImageFont.truetype` 重复解析是热点 | 单次 **0.58ms**；776×3 次 ≈ 1.4s | 加缓存只省 **0.9s（5%）**，不值得引入缓存状态 |
| `render_line` 是热点 | **2.34ms/次**，`line_feature` 再 1.13ms | 3.47ms × 776 × 3 ≈ **8.1s**，确认是主项 |
| 线程池并行能拿 2x+ | 4 线程 **1.44x**、8 线程 **1.49x**（20 核机器） | PIL/cv2 释放 GIL 不足，收益 < 复杂度成本 |
| `/api/fonts` 全表扫描慢 | 781 faces filter+sort **< 10ms** | 不是问题，不优化 |

**明确不做并行**的理由：1.5x 意味着 8.1s → 5.4s，但要给 `compare_line_fonts`
引入线程池、候选级异常隔离、以及「OCR worker 本来单请求串行」的并发语义变化。
在没有用户抱怨速度的前提下，这是负收益的复杂度。

真正有效但**本轮也不做**的方向（需要算法验证，会改排名）：
先只比 1 行做初筛（776×1），取前 300 再补其余行，预计 8.1s → 4.8s（-40%）。
之前踩过「只比 2 行把正确答案筛掉」的坑，必须逐案回归才敢上。

---

## 5. M 可维护性

### M1 tsc 归零（已修）

修改前 `tsc --noEmit` **27 处报错**，全部是 `Cannot find namespace 'koffi'`。
根因：koffi 的 `index.d.ts` 只 `export function load()` 与默认对象，
**没有导出** `IKoffiLib` / `KoffiFunction`，而代码按命名空间引用。

修法（纯类型层，运行时零影响）：

```ts
type KoffiLib = ReturnType<typeof koffi.load>;
type KoffiFunction = (...args: any[]) => any;
```

结果：**27 → 0**。

### M2 自动化关卡（已修）

`package.json` 原来是 `"test": "echo \"Error: no test specified\" && exit 1"` ——
等于没有任何关卡。现在：

```json
"start":      "tsx apps/service/src/main.ts",
"typecheck":  "tsc --noEmit -p tsconfig.json",
"test":       "python scripts/verify-release.py",
```

### M3 巨型文件拆分（建议，未做）

不建议一次性重写。按「改动频率 × 风险」排序：

1. **`main.ts`（1493 行）→ 路由表 + 模块**
   把 13 段 `if (url.pathname === ...)` 抽成 `routes/` 下每域一个文件
   （`fonts.ts` / `recover.ts` / `install.ts` / `feedback.ts`），
   `main.ts` 只留 `createServer` + 分发 + 静态资源。
   同时抽 `readJson(req, limit)` 统一做「读 body + 解析 + 400」，
   替代现在 6 处裸 `JSON.parse`。风险低（纯搬移），建议先做。

2. **`worker.py`（1425 行）→ 4 个模块 + pytest**
   `geometry.py`（render_geometry/find_row_bands/split_units）、
   `ocr.py`（build_engine/recognize_*）、`fontmatch.py`（line_feature/stroke_weight/compare_line_fonts）、
   `worker.py` 只留协议循环。
   纯函数里 `find_row_bands` / `line_stats` / `split_units` / `stroke_weight`
   最适合单测（无模型依赖），能把「俄语/装饰字/倒转」这些历史回归固化成测试，
   而不是依赖 `FD-*.json` 这种真实日志做 e2e。

3. **`app.js`（2014 行）→ ES module**
   面板本来就由本地服务以 http 提供，`<script type="module">` 可用
   （CEP 的 Chromium 99 支持）。按 `api.js` / `render.js` / `recover.js` / `install.js` 拆。
   **风险最高**（CEP 环境能力差异），放最后，且要能实机点面板。

### M4 测试缺口

现有：`scripts/verify-release.py`（6 稿回放 + 4 接口）、2 个 JSX mock 测试。
缺：Python 纯函数单测、TS 单元测试、前端任何测试。
建议优先补 Python 纯函数（M3-2 一起做），因为识别链路的历史 bug 全在这里。

### M5 依赖清理（建议）

- `tesseract.js`：**代码零引用**（只在注释里提过被淘汰），但它是重量级依赖
- `wasm-feature-detect`：**代码零引用**
- 建议从 `dependencies` 移除；注意 `node_modules` 不会自动清理，需 `npm prune`。
  本轮不动 package.json 的 dependencies，避免在无法验证网络安装的环境里引入不确定性。

---

## 6. 本轮落地清单

| 文件 | 改动 |
|---|---|
| `apps/service/src/main.ts` | Origin 白名单 + OPTIONS 403；POST Content-Type 白名单 415；`void handlePost().catch()`；`process.on(unhandledRejection/uncaughtException)`；flipcheck 静默 catch 补日志 |
| `packages/font-core/src/registry.ts` | koffi 类型别名，修 5 处类型错误 |
| `packages/win-font/src/win32.ts` | koffi 类型别名，修 20 处类型错误 |
| `scripts/check-preview-coverage.ts` | 隐式 any 显式标注，修 1 处 |
| `package.json` | 补 `start` / `typecheck` / `test` / `probe:flip` |
| `docs/engineering-review-2026-11-17.md` | 本文 |

**未改动**：识别算法、字体比对权重、恢复校准、任何 JSX。所以识别结果不会变。

## 7. 验证方式

```bash
# 1) 类型检查（应输出空，退出码 0）
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json

# 2) 安全回归：伪造来源的 preflight 必须 403
curl -s -o /dev/null -w "%{http_code}\n" -X OPTIONS http://127.0.0.1:47615/api/install \
  -H "Origin: https://evil.example" -H "Access-Control-Request-Method: POST"
# 期望 403（修改前是 204）

# 3) 安全回归：简单请求绕过必须 415
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:47615/api/uninstall \
  -H "Content-Type: text/plain" --data "x"
# 期望 415（修改前会真的执行卸载逻辑）

# 4) 正常调用不受影响
curl -s -X POST http://127.0.0.1:47615/api/feedback/report \
  -H "Content-Type: application/json" --data '{"issues":[],"context":{}}' | head -c 80
# 期望 {"ok":true,...}

# 5) 功能回归（10 项）
python scripts/verify-release.py
```

## 8. 后续路线

1. **S2 CORS 回显**（需要能实机看面板的时段）
2. **M3-1 拆 main.ts 路由 + readJson**（低风险，收益立竿见影）
3. **M3-2 拆 worker.py + pytest 纯函数单测**（把历史 bug 固化成测试）
4. M5 依赖清理
5. M3-3 拆 app.js（最后，风险最高）
6. 若要性能：先做「1 行初筛 + 补行」并逐案验证排名不变
