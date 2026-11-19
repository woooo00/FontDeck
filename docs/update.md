# 自动更新

## 现在的状态

已完成：**更新检测 + 面板内提醒**（不下载、不替换任何文件）。

- 面板启动 8 秒后查一次，之后每 6 小时一次
- 发现新版本 → 底部滑入卡片，显示版本号 / 日期 / 更新说明
- 三个出口：`稍后`（本次不再烦，下次启动还会问）、`跳过这个版本`（永久不再提示这个版本）、`去下载`（开浏览器到 Release 页）
- 网络不通时**完全静默**，只在控制台留一行日志 —— 用户没点任何按钮，不该被打扰

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

1. 改 `package.json` 的 `version`（**唯一真源**，面板显示的就是它），例如 `1.1.0`
2. 准备安装包 `fontdeck-setup-1.1.0.exe` 或 `fontdeck-1.1.0.zip`
3. 建 tag `v1.1.0`，在 GitHub 上发 Release，把安装包作为 asset 上传
4. Release 说明（body）会被原样显示在提醒卡片里，前 320 字可见，所以**开头就写用户能看懂的变化**，别写 commit 列表

`tag_name` 有没有前缀 `v` 都行，比较时会去掉。

## 三层更新，生效代价不同

| 层 | 位置 | 换完多久生效 |
|---|---|---|
| UI（`apps/web`） | 由本地服务托管 | **刷新面板即可**，AI 不用重开 |
| 服务端（`apps/service`、`packages`） | Node 进程 | 重启服务（约 2 秒），面板会自愈重连 |
| 面板壳（`apps/cep`） | `%APPDATA%\Adobe\CEP\extensions\com.fontdeck.panel` | **必须完全退出 Illustrator 再开**，CEP 做不到热替换 |

面板壳一年改不了几次，所以自动更新优先覆盖前两层。

## 还没做（下一步）

**下载安装**目前只到"提醒 + 打开 Release 页"，没有自动下载替换。要做完整链路，课前改造有三件：

1. **路径去硬编码**：`launcher.pyw` 和 `apps/cep/js/boot.js` 里写死了项目绝对路径和 node 路径。必须改成基于自身位置推导，否则装到 `%LOCALAPPDATA%` 下就全错。
2. **运行时打包**：现在的形态依赖本机 `node.exe` + `tsx` + 100MB `node_modules`，**别人机器装不了**。需要：esbuild 把服务端 bundle 成 JS、裁剪依赖、随包带 `node.exe`（约 87MB）。
3. **版本化安装目录**：`%LOCALAPPDATA%\FontDeck\app\<ver>\` + 一个 `current` 指针，保留上一版用于回滚；`data\` 留在外面跨版本共享。

这三件做完，才能做"下载 → 校验 SHA256 → 解压到新版本目录 → 切指针 → 重启服务 → 提示重开 AI"。

## 一个已知的坑

GitHub 在国内经常直连超时。探测放在前端是刻意的：CEP 的 Chromium 走系统代理，而这里的 Node 进程不读系统代理设置。所以「浏览器能开 GitHub、Node 超时」是常态。

如果同事/客户机器上开了代理也上不去，就把 `api` 指向一个镜像地址（返回同结构 JSON），再在 Release 里放一个国内可达的下载链接。
