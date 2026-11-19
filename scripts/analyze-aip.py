"""
解析 字醒.aip 的 PE 结构：节区、导入表、导出表、关键字符串。
目的是搞清楚这个原生插件的能力边界和技术栈，不涉及反编译或破解。
"""
import sys
import math
import re
import collections
import pefile

PATH = r"F:\BaiduNetdiskDownload\字醒正式版\字醒Windows版本\字醒-v2.3.18-Windows-x64\字醒-v2.3.18-Windows-x64\字醒.aip"

pe = pefile.PE(PATH, fast_load=False)

MACHINE = {0x8664: "x64", 0x14c: "x86", 0xaa64: "ARM64"}
print("=" * 72)
print("基础信息")
print("=" * 72)
print("架构        :", MACHINE.get(pe.FILE_HEADER.Machine, hex(pe.FILE_HEADER.Machine)))
print("类型        :", "DLL" if pe.FILE_HEADER.Characteristics & 0x2000 else "EXE")
print("时间戳      :", pe.FILE_HEADER.TimeDateStamp)
print("节区数      :", pe.FILE_HEADER.NumberOfSections)
print("子系统      :", pe.OPTIONAL_HEADER.Subsystem,
      "(2=GUI, 3=Console)")
print("链接器      :", "%d.%d" % (pe.OPTIONAL_HEADER.MajorLinkerVersion,
                                  pe.OPTIONAL_HEADER.MinorLinkerVersion))
print("文件大小    : %.1f MB" % (len(pe.__data__) / 1024 / 1024))

print()
print("=" * 72)
print("节区分布（熵 > 7.2 通常是压缩/加密/模型数据）")
print("=" * 72)
print("%-10s %12s %12s %8s" % ("名称", "虚拟大小", "原始大小", "熵"))
for s in pe.sections:
    name = s.Name.rstrip(b"\x00").decode("utf-8", "replace")
    raw = s.SizeOfRawData / 1024 / 1024
    ent = s.get_entropy()
    flag = "  <-- 高熵" if ent > 7.2 else ""
    print("%-10s %10.2f MB %10.2f MB %8.3f%s" % (name, s.Misc_VirtualSize / 1048576, raw, ent, flag))

print()
print("=" * 72)
print("导入的 DLL（能力线索）")
print("=" * 72)
if hasattr(pe, "DIRECTORY_ENTRY_IMPORT"):
    for entry in pe.DIRECTORY_ENTRY_IMPORT:
        dll = entry.dll.decode("utf-8", "replace")
        funcs = [imp.name.decode("utf-8", "replace") for imp in entry.imports if imp.name]
        print("%-28s %3d 个函数" % (dll, len(funcs)))
        # 只列有信息量的
        interesting = [f for f in funcs if re.search(
            r"Reg|Font|AddFont|Gdi|Wnd|Window|Process|Thread|Pipe|Socket|Http|WebView|Com|CoCreate",
            f, re.I)]
        for f in interesting[:14]:
            print("      ", f)

print()
print("=" * 72)
print("导出函数")
print("=" * 72)
if hasattr(pe, "DIRECTORY_ENTRY_EXPORT") and pe.DIRECTORY_ENTRY_EXPORT:
    for sym in pe.DIRECTORY_ENTRY_EXPORT.symbols:
        if sym.name:
            print("  ", sym.name.decode("utf-8", "replace"), "ordinal", sym.ordinal)
else:
    print("  无导出表")

print()
print("=" * 72)
print("关键字符串")
print("=" * 72)

data = pe.__data__
ascii_strings = re.findall(rb"[\x20-\x7e]{6,}", data)
text = b"\n".join(ascii_strings).decode("ascii", "replace")
lines = text.split("\n")

def grep(pattern, limit=18, label=None):
    hits = [l for l in lines if re.search(pattern, l, re.I)]
    seen = []
    for h in hits:
        if h not in seen:
            seen.append(h)
    if seen:
        print("\n[" + (label or pattern) + "]  共 %d 条，示例：" % len(seen))
        for h in seen[:limit]:
            print("   ", h.strip()[:110])

grep(r"WebView2|webview", 12, "WebView2")
grep(r"^https?://", 14, "URL")
grep(r"ZiXing|zixing|字醒", 12, "产品标识")
grep(r"\.aip|\.dll$|onnx|leptonica|tesseract|paddle", 16, "依赖组件")
grep(r"SOFTWARE\\|HKEY_|LOCALAPPDATA|APPDATA|ProgramData", 12, "路径/注册表")
grep(r"PluginMain|AIPlugin|SPBasic|AIUnload|sAIPlugin", 12, "AI SDK 符号")
grep(r"\.log|panel\.log|startup\.log|match\.log", 10, "日志文件")
grep(r"localhost|127\.0\.0\.1|pipe\\\\|\\\\\\\\\.\\\\pipe", 10, "进程间通信")

# UTF-16 字符串里的中文文案（UI 文本线索）
utf16 = re.findall(rb"(?:[\x20-\x7e\u4e00-\u9fff][\x00]){4,}", data[:8_000_000])
print("\n[UTF-16 字符串] 共 %d 条，前 10 条示例：" % len(utf16))
for u in utf16[:10]:
    try:
        s = u.decode("utf-16-le", "ignore").strip()
        if len(s) > 3:
            print("   ", s[:80])
    except Exception:
        pass

print()
print("=" * 72)
print("节区熵最高者（推测模型/资源所在）")
print("=" * 72)
top = sorted(pe.sections, key=lambda s: s.SizeOfRawData, reverse=True)[:3]
for s in top:
    name = s.Name.rstrip(b"\x00").decode("utf-8", "replace")
    print("  %-10s 原始 %6.2f MB  熵 %.3f" % (name, s.SizeOfRawData / 1048576, s.get_entropy()))
