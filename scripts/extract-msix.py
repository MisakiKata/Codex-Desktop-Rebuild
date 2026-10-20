#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
解包 MSIX (本质为 ZIP)，避开 7zr 对多卷布局的限制。

MSIX 打包时会把路径中的 '@' 编码成 '%40'（npm scoped 包名）。
直接 extractall 会生成字面量 '%40' 目录，导致 asar / Electron 找不到
node_modules/@scope/... 真实路径。此处在提取时还原。

用法: python extract-msix.py <archive> <dest>
"""
import sys, os, zipfile
from urllib.parse import unquote

def main():
    if len(sys.argv) < 3:
        print("Usage: extract-msix.py <archive> <dest>")
        sys.exit(1)

    src = sys.argv[1]
    dest = sys.argv[2]

    if not os.path.exists(src):
        print(f"[x] not found: {src}")
        sys.exit(1)

    os.makedirs(dest, exist_ok=True)
    print(f"[zip] {src} -> {dest}")

    with zipfile.ZipFile(src, "r") as z:
        bad = z.testzip()
        if bad is not None:
            print(f"[x] corrupt entry: {bad}")
            sys.exit(1)

        members = z.infolist()
        print(f"[ok] {len(members)} entries, archive valid")

        renamed = 0
        for info in members:
            raw = info.filename
            # 只还原路径段中的 %40，避免误伤文件名里的字面 '%40'
            decoded = unquote(raw)
            if decoded != raw:
                info.filename = decoded
                renamed += 1
            z.extract(info, dest)

        if renamed:
            print(f"[ok] unescaped %40 in {renamed} entry paths")

    print(f"[done] extracted {len(members)} entries")

if __name__ == "__main__":
    main()