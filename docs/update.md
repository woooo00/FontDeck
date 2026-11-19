# 自动更新

## 现在的状态

已完成：**更新检测 + 面板内提醒 + 可下载的发行包**（不自动替换文件）。

- 面板启动 8 秒后查一次，之后每 6 小时一次
- 发现新版本 → 底部滑入卡片，显示版本号 / 日期 / 更新说明
- 三个出口：`稍后`（本次不再烦，下次启动还会问）、`跳过这个版本`（永久不再提示这个版本）、`去下载`（开浏览器到 Release 页）
- 网络不通时**完全静默**，只在控制台留一行日志 —— 用户没点任何按钮，不该被打扰

Release 里放的是真能装的包（自带 Node 和 Python 运行时），
详见下面「打包产物长什么样」。

控制台手动触发：`__fdCheckUpdate(true)`

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
4. 发 Release：

   ```bash
   gh release create v1.1.0 --title "1.1.0 · 说明" \
       --notes-file build/release-notes.md \
       build/dist/FontDeck-1.1.0.zip
   ```

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

**面板里点"去下载"只打开 Release 页面**，不会自动下载替换。要变成一键更新，
需要补一段：下载 zip → 校验 → 解压到 `app\<ver>` → 改 `current` → 重启服务。
指针机制已经就位，剩下的是下载与校验本身，以及失败时把 `current` 写回去。

另外两个已知缺口：

- 目前只发 zip + `install.cmd`，没有真正的安装器（无开始菜单项、无卸载入口）
- `install.cmd` 不做完整性校验，包损坏时只能靠 xcopy 的 errorlevel 看出来

## 一个已知的坑

GitHub 在国内经常直连超时。探测放在前端是刻意的：CEP 的 Chromium 走系统代理，而这里的 Node 进程不读系统代理设置。所以「浏览器能开 GitHub、Node 超时」是常态。

如果同事/客户机器上开了代理也上不去，就把 `api` 指向一个镜像地址（返回同结构 JSON），再在 Release 里放一个国内可达的下载链接。
