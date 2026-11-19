FontDeck {VER}
=============

Illustrator 字体库面板：浏览本机字体、按语言/衬线/字重筛选、用户级安装字体，
以及把转曲后的文字认回它原本用的字体。


安装
----

1. 把整个压缩包解压到一个普通文件夹（不要在压缩包里直接双击，那样会缺文件）。
2. 双击 install.cmd，看着窗口跑完。
3. 完全退出 Illustrator（不是只关掉面板窗口），再重新打开。
4. 菜单 窗口 > 扩展功能 > FontDeck 字体库。

安装脚本不需要管理员权限。它只往这两个地方写东西：

    %LOCALAPPDATA%\FontDeck\            程序本体（约 450 MB）
    %APPDATA%\Adobe\CEP\extensions\     面板外壳（约 200 KB）

其中 %LOCALAPPDATA%\FontDeck\runtime\ 是所有版本共享的运行时（Node + Python），
升级时不会重复占用磁盘；app\ 下每个版本一个目录，约 40 MB。


首次打开要等几秒
----------------

第一次启动要扫描本机字体并建索引，视字体数量大概 5 到 20 秒。
之后就是秒开。扫描结果存在 data\index.json，删掉它会触发重新扫描。


如果面板打不开
--------------

先看 %LOCALAPPDATA%\FontDeck\app\<版本>\data\service.log，服务端的问题都在里面。

常见情况：

  面板一直显示"正在连接字体服务"
      多半是端口 47615 被别的东西占了。命令行执行
          netstat -ano | findstr :47615
      找到 PID，用任务管理器结束它，再重开面板。

  服务起来了但立刻退出
      检查杀毒软件有没有拦 node.exe / python.exe。
      本程序会调用 Python 做文字识别，部分安全软件会把 onnxruntime 判成可疑行为。

  面板能开，但转曲识别报错
      转曲识别依赖随包的 Python 运行时。如果安装时 runtime 目录被跳过或复制不完整，
      重新跑一次 install.cmd 即可。


卸载
----

1. 关掉 Illustrator。
2. 删除 %LOCALAPPDATA%\FontDeck
3. 删除 %APPDATA%\Adobe\CEP\extensions\com.fontdeck.panel

卸载不会动你安装过的字体，也不会动任何稿件文件。


升级
----

面板检测到新版本会从右下角弹一张卡片，点"去下载"会打开 GitHub Release 页面。
下载后覆盖安装即可 —— 安装脚本会切换版本指针，旧版本目录留着，出问题能退回。

手动升级：解压新包，双击 install.cmd，再重开 Illustrator。


数据与隐私
----------

本程序只读本机字体文件，不联网上传任何内容。
唯一的网络请求是检查 GitHub 上的新版本（可在 data\update.json 里把 check 改成 false 关掉）。

"恢复转曲"功能会在 %LOCALAPPDATA%\FontDeck\recover\ 下留识别过程用的临时图片，
启动器会自动清理超过 7 天的旧图片。


版本
----

{VER}
