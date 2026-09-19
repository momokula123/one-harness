---
name: powershell-encoding
display-name: PowerShell 中文编码
description: Windows 下跑 shell 命令的中文防乱码规范：先探 PowerShell 版本，能用 pwsh 7 就引导用户换上；还在 PS5 就不要把中文放进命令里
user-invocable: true
---

# PowerShell 中文编码（Windows）

One Harness 在 Windows 上默认用 Windows PowerShell 5（powershell.exe）执行命令。它的控制台编码是 GBK：命令里写中文、输出里带中文都会乱码。pwsh（PowerShell 7+）默认 UTF-8，没有这个问题。

## 顺序

1. **先探一次**：这个会话第一次要用 shell 时，跑 `$PSVersionTable.PSVersion.Major`。结果 ≥7 说明用户已经在用 PowerShell 7，正常干活，本条其余部分不用管。
2. **是 5 就找 7**：跑 `where.exe pwsh`，找不到再看 `C:\Program Files\PowerShell\7*\pwsh.exe`。找到后把完整路径告诉用户，请他填进「设置 → Shell 路径」（设置你自己改不了）。用户填了 pwsh 7 后程序会自动用它，下面的规避规则就不再需要。
3. **找不到 pwsh，或用户不想换**：留在 PS5，遵守下面的规避规则。

## PS5 规避规则

- 命令、参数、注释里**不写中文**；要说中文放对话回复里，不放进命令。
- 中文内容一律走文件工具（write_file 写出的是 UTF-8）；不要用 echo / Set-Content / Out-File 造带中文的文件。
- 确实要输出中文（比如读现成的中文文件）时，命令开头加 `[Console]::OutputEncoding=[Text.Encoding]::UTF8`，读文件加 `-Encoding UTF8`。
- 看到"锟斤拷"、成串问号，先怀疑编码问题，不要当成文件内容坏了去重写。
