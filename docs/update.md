# 自动更新

## 现在的状态

已完成：**检测 → 提醒 → 自动下载 → 自动安装 → 提示重开**。用户只需要点一次。

- 面板启动 8 秒后查一次，之后每 6 小时一次
- 发现新版本 → 底部滑入卡片，显示版本号 / 日期 / 更新说明
- 点「立即更新」→ 服务端下载增量包（约 17MB）→ 校验解压 → 写版本指针 → 提示重开 Illustrator
- 另有 `稍后`、`跳过这个版本` 两个出口
- 网络不通时**完全静默**，只在控制台留一行日志 —— 用户没点任何按钮，不该被打扰

控制台手动触发：`__fdCheckUpdate(true)`

## 为什么下载在服务端做

一开始想的是面板里直接 `fetch` GitHub 的安装包，下完 POST 给本地服务。实测走不通：

- `api.github.com` 带 CORS 头，所以**版本检查**能过
- Release 资产在 `release-assets.githubusercontent.com`，**不带** `Access-Control-Allow-Origin`，
  Chromium 里 `fetch` 直接 `Failed to fetch`

所以下载改到服务端。代价是 Node 不读系统代理，得自己找：

1. 环境变量 `HTTPS_PROXY` / `HTTP_PROXY`
2. Windows「Internet 选项」的代理（读注册表，用 koffi 调 advapi32；`reg.exe` 在部分环境被封）
3. 都没有就直连

实际走的哪条路会显示在进度行里，排障时一眼能看出来。

下载是 HTTPS 经代理走 `CONNECT` 隧道（`tls.connect({ socket })` + 自定义 Agent），
不是明文转发 —— GitHub 不走明文。

## 安装怎么落地

```
POST /api/update/install {version, url}   → 启动后台任务，立刻返回
GET  /api/update/status                   → 前端轮询：downloading / installing / done / error
POST /api/update/restart                  → 前端显示完提示后调用，老进程退出
```

`restart` 这一步不能省：老进程不退，端口 47615 一直被占，
launcher 探活会认为「已经在跑」，**新版本永远不会被拉起来** ——
用户重开 Illustrator 看到还是旧界面，而且没有任何报错。

装的时候先解压到 `<target>.tmp`，结构自检通过才 rename，最后才写 `current`。
中间任何一步失败，`current` 都不动，用户重开还是旧版本 —— 半途而废的更新比不更新糟糕。

`current.previous` 保留上一版的路径，回滚就是把它写回 `current`。

## 怎么启用

填 `data/update.json`：

```json
{
  "repo": "你的GitHub用户名/fontdeck",
  "api": "",
  "check": true
}
```

| 字段 | 说明 |
|---|---|
| `repo` | `owner/name` 格式。留空 = 不检查更新（静默） |
| `api` | 留空走 `https://api.github.com/repos/<repo>/releases/latest`；填了就直连这个地址，**必须返回同样的结构**（`tag_name` / `body` / `published_at` / `html_url` / `assets[]`），用于镜像或自建 |
| `check` | `false` 关掉检查 |

改完刷新面板即可，不用重启服务（每次请求都重读这个文件）。

## 怎么发布一个版本

1. 改 `package.json` 的 `version`（**服务端唯一真源**，面板显示的就是它）
2. 改 `apps/cep/CSXS/manifest.xml` 三处版本：`ExtensionBundleVersion`、
   `ExtensionList/Extension@Version`、`ExtensionData/Version`（四段式，如 `1.1.0.0`）
   —— CEP 用这个决定要不要重载面板壳，漏改会导致装了新版但面板还是旧的
3. 打包：

   ```bash
   python scripts/build-release.py
   ```

   产物在 `build/dist/FontDeck-<ver>.zip`，约 150 MB（解压后 390 MB）
4. 发 Release（**两个包都要传**）：

   ```bash
   gh release create v1.1.1 --title "1.1.1 · 说明" \
       --notes-file build/release-notes.md \
       build/dist/FontDeck-1.1.1.zip \
       build/dist/FontDeck-1.1.1-update.zip
   ```

   - `FontDeck-X.zip`（150MB）首次安装用，带运行时
   - `FontDeck-X-update.zip`（17MB）面板自动更新下的就是它，只有 app + panel

   少传 update 包，自动更新会退回下载完整包 —— 能装，但每次更新白下 130MB。

   `gh` 在 `C:\Users\6\.workbuddy\binaries\gh\bin\gh.exe`，
   并且**它要求 PATH 里有 git**，否则报 `unable to find git executable`：
   把 `C:\Users\6\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd` 加进 PATH。
5. Release 说明（body）会被原样显示在提醒卡片里，前 320 字可见，所以**开头就写用户能看懂的变化**，别写 commit 列表

`tag_name` 有没有前缀 `v` 都行，比较时会去掉。

## 打包产物长什么样

```
FontDeck-1.1.0/
├── app/               应用代码，约 40 MB（每版本一份）
│   ├── apps/ packages/ data/ node_modules/
│   ├── launcher.pyw
│   └── package.json
├── runtime/           运行时，约 350 MB（所有版本共享）
│   ├── node/node.exe
│   └── python/        便携 Python（含 RapidOCR / onnxruntime / opencv）
├── panel/             CEP 面板壳
├── install.cmd        安装脚本（纯 ASCII，cmd 按系统代码页逐字节解析）
├── README.txt
└── VERSION
```

装完之后：

```
%LOCALAPPDATA%\FontDeck\
├── runtime\           共享，升级不重装
├── app\1.1.0\         每版本一份
├── app\1.0.9\         上一版，留给回滚
├── current            文本文件，内容是当前生效目录的绝对路径
└── current.previous   上一版的路径
```

`boot.js` 启动时读 `current`，所以切换/回滚版本就是改这一行文本。

**为什么 runtime 共享而不是每版一份**：Python 那套 350 MB，
每版复制一份，装三个版本就 1 GB 出去了。共享的代价是升级 runtime 会影响所有版本，
但 runtime（Node + Python + 那几个 wheel）一年也动不了几次。

**为什么不用 pkg / SEA 打成单 exe**：服务依赖 koffi（FFI，调 Win32 装字体）、
@resvg 的 .node、以及一整个 Python 环境。SEA 只能塞一个 JS 入口，
塞不了这些原生资产，还得自己解压到临时目录再改 DLL 搜索路径 ——
比发一个目录复杂，也更容易被杀软拦。

## 路径约束（改代码时要守）

启动链路里不能再出现绝对路径，三种摆法都要能认：

| 场景 | app 根 | runtime 位置 |
|---|---|---|
| 源码目录直接跑 | `<repo>` | `<repo>/runtime`（可能不存在，回退本机） |
| 安装版 | `%LOCALAPPDATA%\FontDeck\app\<ver>` | `%LOCALAPPDATA%\FontDeck\runtime` |

对应 `launcher.pyw:find_node`、`packages/ocr/src/client.ts:PYTHON_CANDIDATES`、
`apps/cep/js/boot.js:PYTHONW` 三处都写了 `<root>/runtime` 和 `<root>/../../runtime` 两个候选。
加新的运行时依赖时，这三处要一起看。

## 三层更新，生效代价不同

| 层 | 位置 | 换完多久生效 |
|---|---|---|
| UI（`apps/web`） | 由本地服务托管 | **刷新面板即可**，AI 不用重开 |
| 服务端（`apps/service`、`packages`） | Node 进程 | 重启服务（约 2 秒），面板会自愈重连 |
| 面板壳（`apps/cep`） | `%APPDATA%\Adobe\CEP\extensions\com.fontdeck.panel` | **必须完全退出 Illustrator 再开**，CEP 做不到热替换 |

面板壳一年改不了几次，所以自动更新优先覆盖前两层。

## 还没做

自动更新已经能用，但还有几个缺口：

- **没有 SHA256 校验**：判断包是否完整靠的是 `content-length` + 解压时的长度自检，
  没有对照发布时生成的哈希。包被中间人替换理论上能过（实际要劫持 GitHub 的 HTTPS）。
- **没有真正的安装器**：只有 zip + `install.cmd`，没有开始菜单项、没有卸载入口。
- **runtime 不会自动更新**：增量包只含 app + panel。以后 Node 或 Python 依赖变了，
  必须发一次完整包让用户手动装。
- **出错后没有自动回滚**：失败时 `current` 不动（等于保持旧版），但如果新版装上去
  起不来，需要人工把 `current.previous` 写回 `current`。

## 一个已知的坑

GitHub 在国内经常直连超时。探测放在前端是刻意的：CEP 的 Chromium 走系统代理，而这里的 Node 进程不读系统代理设置。所以「浏览器能开 GitHub、Node 超时」是常态。

如果同事/客户机器上开了代理也上不去，就把 `api` 指向一个镜像地址（返回同结构 JSON），再在 Release 里放一个国内可达的下载链接。
