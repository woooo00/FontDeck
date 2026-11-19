"""Enable CEP PlayerDebugMode, which unsigned extensions need in order to load.

Illustrator only loads an unsigned CEP extension when PlayerDebugMode is "1"
under HKCU\\Software\\Adobe\\CSXS.<n>. Without it the panel still appears in
Window > Extensions, but selecting it opens nothing and writes no error --
a silent failure that is very hard to diagnose from the user side.

Why winreg instead of `reg add`: some company machine images put reg.exe on a
program blacklist. A direct registry API call cannot be blocked that way, and
we already ship a Python interpreter, so this costs nothing extra.

Exit code 0 only if every version key was written.
"""

import sys
import winreg

# CEP version numbers, not Illustrator versions. Writing all of them is
# harmless and saves guessing which CEP build a given host uses.
VERSIONS = ("9", "10", "11", "12", "13")


def enable(version):
    sub = "Software\\Adobe\\CSXS." + version
    key = winreg.CreateKeyEx(
        winreg.HKEY_CURRENT_USER,
        sub,
        0,
        winreg.KEY_SET_VALUE | winreg.KEY_QUERY_VALUE,
    )
    try:
        winreg.SetValueEx(key, "PlayerDebugMode", 0, winreg.REG_SZ, "1")
    finally:
        winreg.CloseKey(key)


def main():
    ok = []
    failed = []
    for v in VERSIONS:
        try:
            enable(v)
            ok.append(v)
        except OSError as exc:
            failed.append("CSXS.%s (%s)" % (v, exc))

    sys.stdout.write("PlayerDebugMode=1 for CSXS: %s\n" % ", ".join(ok))
    if failed:
        sys.stderr.write("could not set: %s\n" % "; ".join(failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
