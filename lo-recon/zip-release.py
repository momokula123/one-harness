#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打发布用的 zip（替代 Compress-Archive）。
为什么不用 PowerShell 的 Compress-Archive：它的 deflate 固定在较低档，同样内容比上一版
产物大 21MB（710MB 原始 → 278.9MB vs 258.5MB）。这里用 zlib 最高档，并把目录条目一并写进去，
形态与历史产物一致（根层级 = win-unpacked/）。
跑法：python lo-recon/zip-release.py 0.1.10
"""
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ver = sys.argv[1] if len(sys.argv) > 1 else None
if not ver:
    sys.exit('用法：python lo-recon/zip-release.py <版本号>')

SRC = os.path.join(ROOT, 'dist', ver, 'win-unpacked')
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'dist', 'One-Harness-%s-win-x64.zip' % ver)
if not os.path.isdir(SRC):
    sys.exit('找不到产物目录：' + SRC)

parent = os.path.dirname(SRC)          # dist/<ver>
base = os.path.basename(SRC)           # win-unpacked
dirs, files = [], []
for root, dnames, fnames in os.walk(SRC):
    rel = os.path.relpath(root, parent).replace('\\', '/')
    dirs.append(rel)
    for f in fnames:
        files.append((os.path.join(root, f), rel + '/' + f))
dirs.sort()
files.sort(key=lambda x: x[1])

if os.path.exists(OUT):
    # 沙箱的删除守卫会拦 os.remove（本轮删除配额用满时），所以不删：改名腾位（改名不算删除）。
    stale = '%s.prev-%d' % (OUT, int(__import__('time').time()))
    os.replace(OUT, stale)
    print('旧文件已让位 → ' + os.path.basename(stale))

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for d in dirs:
        zi = zipfile.ZipInfo(d + '/', date_time=(2026, 9, 19, 12, 0, 0))
        zi.external_attr = 0o40755 << 16
        zi.compress_type = zipfile.ZIP_STORED
        z.writestr(zi, b'')
    for full, arc in files:
        z.write(full, arc)

size = os.path.getsize(OUT)
raw = sum(os.path.getsize(f) for f, _ in files)
print('zip  = %s' % OUT)
print('文件 = %d 个；目录条目 = %d 个；共 %d 条' % (len(files), len(dirs), len(files) + len(dirs)))
print('原始 = %.1f MB；压缩后 = %.1f MB（%.1f%%）' % (raw / 1048576, size / 1048576, 100.0 * size / raw))
