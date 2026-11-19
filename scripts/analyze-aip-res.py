"""看 .rsrc 里的资源类型，确认 30MB 装的是什么。"""
import pefile

PATH = r"F:\BaiduNetdiskDownload\字醒正式版\字醒Windows版本\字醒-v2.3.18-Windows-x64\字醒-v2.3.18-Windows-x64\字醒.aip"
pe = pefile.PE(PATH, fast_load=False)

TYPES = {
    1: "CURSOR", 2: "BITMAP", 3: "ICON", 4: "MENU", 5: "DIALOG",
    6: "STRING", 9: "ACCELERATOR", 10: "RCDATA", 11: "MESSAGETABLE",
    12: "GROUP_CURSOR", 14: "GROUP_ICON", 16: "VERSION", 19: "PLUGPLAY",
    20: "VXD", 21: "ANICURSOR", 22: "ANIICON", 23: "HTML", 24: "MANIFEST",
}

print("资源树")
print("=" * 60)
if not hasattr(pe, "DIRECTORY_ENTRY_RESOURCE"):
    print("无资源目录")
    raise SystemExit

total = 0
for entry in pe.DIRECTORY_ENTRY_RESOURCE.entries:
    tid = entry.id if entry.id is not None else None
    tname = entry.name.string.decode("utf-8", "replace") if entry.name else TYPES.get(tid, str(tid))
    print("\n类型:", tid, "=>", tname)
    for sub in entry.directory.entries:
        for lang in sub.directory.entries:
            d = lang.data.struct
            size = d.Size / 1024 / 1024
            total += d.Size
            label = ""
            if entry.name is None and tid not in TYPES:
                label = "  (自定义类型)"
            print("   资源 ID %-6s  大小 %8.2f MB%s" % (sub.id, size, label))

print("\n" + "=" * 60)
print("资源总大小: %.2f MB / 文件 %.2f MB" % (total / 1048576, len(pe.__data__) / 1048576))

# 版本信息
print("\n版本信息")
print("=" * 60)
try:
    for fi in pe.FileInfo:
        for entry in fi:
            if entry.Key.decode() == "StringFileInfo":
                for st in entry.StringTable:
                    for k, v in st.entries.items():
                        print("  %-18s %s" % (k.decode("utf-8", "replace"), v.decode("utf-8", "replace")[:70]))
except Exception as e:
    print("  读取失败:", e)
