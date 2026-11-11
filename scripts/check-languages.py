"""The project's languages are English and German (docs/RULES.md, R2). This fails when a tracked text file contains
Arabic-script characters (used by Persian and Arabic), so the rule is checked by CI instead of by memory.

    python3 scripts/check-languages.py      (from the repository root; exit 1 and the places when something is found)
"""
import re
import subprocess
import sys

ARABIC_SCRIPT = re.compile("[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFC]")  # not U+FEFF: the byte-order mark is no Arabic letter


def main() -> int:
    files = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout.decode().split("\0")
    found = []
    for path in filter(None, files):
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError:
            continue
        if b"\0" in data[:8000]:
            continue  # binary
        text = data.decode("utf-8", errors="ignore")
        for number, line in enumerate(text.splitlines(), 1):
            if ARABIC_SCRIPT.search(line):
                found.append(f"{path}:{number}: {line.strip()[:80]}")
    for place in found:
        print(place)
    print(f"{len(found)} line(s) with Persian or Arabic script" if found else "only English and German script found")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
