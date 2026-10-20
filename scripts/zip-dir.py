#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
把目录打包为 ZIP。7-Zip 不可用时的兜底实现。

用法: python zip-dir.py <srcDir> <destZip>
"""
import os, sys, zipfile

def main():
    if len(sys.argv) < 3:
        print("Usage: zip-dir.py <srcDir> <destZip>")
        sys.exit(1)

    src = sys.argv[1]
    dest = sys.argv[2]

    if not os.path.isdir(src):
        print(f"[x] not a directory: {src}")
        sys.exit(1)

    parent = os.path.dirname(os.path.abspath(dest))
    if parent:
        os.makedirs(parent, exist_ok=True)

    count = 0
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED, compresslevel=5) as z:
        for root, _dirs, files in os.walk(src):
            for name in files:
                full = os.path.join(root, name)
                rel = os.path.relpath(full, src).replace(os.sep, "/")
                z.write(full, rel)
                count += 1

    size_mb = os.path.getsize(dest) / 1048576
    print(f"[ok] {dest} ({size_mb:.1f} MB, {count} files)")

if __name__ == "__main__":
    main()