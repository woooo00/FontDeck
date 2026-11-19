# FontDeck

Illustrator 的字体管理面板：按语言/衬线/字重浏览本机字体，把字体文件按用户级安装
（不需要管理员权限），以及**把转曲后的文字认回字体**。

面板跑在 Illustrator 的 CEP 环境里，重活（字体扫描、OCR、轮廓渲染、字体匹配）
放在本地 Node 服务进程里 —— CEP 是 Chromium 沙盒，写不了注册表、也放不进系统字体目录。

## 目录

```
apps/
  cep/          CEP 面板壳（manifest / bridge / host.jsx）
  service/      本地 HTTP 服务（127.0.0.1:47615）
  web/          面板 UI，由服务托管（改界面不用重装面板）
packages/
  font-core/    字体扫描、解析、预览、相似度
  ocr/          RapidOCR 常驻进程 + 字体比对（Python）
  recover/      转曲识别编排：聚类成字 → 逐字/整行 OCR
  win-font/     用户级字体安装/卸载（koffi 调 Win32）
scripts/        一次性探针与自检脚本
docs/           工程记录
```

## 架构要点

- **面板壳只是壳**：`%APPDATA%\Adobe\CEP\extensions\com.fontdeck.panel` 里的
  index/boot/bridge 负责探活、拉起服务、把 iframe 的 ExtendScript 请求转给顶层页。
  真正的界面由服务在 `http://127.0.0.1:47615` 托管，所以改 UI 只要刷新面板。
- **服务由 pythonw 静默拉起**：`launcher.pyw` 用 GUI 子系统进程起 Node，
  全链路不产生控制台窗口。服务脱离父进程的 Job 对象，Illustrator 关掉也不会带走它。
- **OCR 走 Python 常驻进程**：中文准确率比 tesseract.js 高一个代差（实测
  「永和九年岁在癸丑」→ tesseract 认成「水和九年岁在奖丑」，RapidOCR 逐字 97.7%）。
  模型只加载一次，之后每个字约 6ms。
- **转曲识别不导出图片**：让 Illustrator 导出 PNG 会卡住 UI 线程、evalScript
  回调不返回。改成回传路径几何，服务端自己渲染。

## 开发环境跑起来

需要：Node 22、Python 3.13（带 `rapidocr-onnxruntime`、`opencv-python`、
`fonttools`、`pillow`）、Illustrator。

```bash
npm ci

# 1) 起服务（前台，方便看日志）
npx tsx apps/service/src/main.ts

# 2) 装面板壳（只需一次）
#    把 apps/cep 整个目录复制到：
#    %APPDATA%\Adobe\CEP\extensions\com.fontdeck.panel
#    未签名扩展需要打开 CEP 的 PlayerDebugMode

# 3) 重开 Illustrator，窗口 → 扩展 → FontDeck
```

`launcher.pyw` 与 `apps/cep/js/boot.js` 里的路径目前是写死的绝对路径，
换机器要改（这一点会在做发行包时一并改掉）。

## 更新

面板会在启动后检查 GitHub Releases 并提示新版本，配置见 [docs/update.md](docs/update.md)。

## 许可

内部工具，未开源授权。
