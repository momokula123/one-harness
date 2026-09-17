---
name: single-file-html
display-name: 单文件 HTML 页面
description: 生成可直接双击打开的单文件 HTML 页面时的排版与配色规范（含本地偏好：界面不用 emoji、配色要柔和但保留对比度）
user-invocable: true
---

# 单文件 HTML 页面规范

## 交付形态

- 只产出**一个** `.html` 文件：CSS 内联在 `<style>`，JS 内联在 `<script>`，不要外链本地资源。
- 需要图片素材时：优先用内联 SVG 或 Canvas 绘制，不要引用不存在的本地图片路径。
- 写完后用 `shell_command` 打开一次确认没有语法错误（例如 `node -e "..."` 之类的静态检查），并把文件路径报给用户。

## 排版

- `<!DOCTYPE html>` + `lang="zh-CN"` + `<meta name="viewport">`。
- 字号用 `clamp()` 做响应式，正文不小于 14px。
- 容器用 `max-width` + `margin:auto` 居中，避免全屏拉满。
- 圆角 10–16px，阴影克制（一层即可，不要发光效果）。

## 配色（重要）

- 风格偏好：柔和、偏"甜"的马卡龙色，但**避免大面积纯白 / 纯亮色**，否则显得刺眼；保留足够的明暗对比。
- 建议结构：深色或中性背景 + 2–3 个低饱和强调色 + 高对比正文文字。
- 每个色值都显式写出来，不要依赖未定义的 CSS 变量。

## 交互

- 能不用 JS 就不用；需要动画时优先 CSS `transition` / `@keyframes`，并加 `@media (prefers-reduced-motion: reduce)` 降级。
- 键盘可用：可点元素尽量用 `<button>` 而不是 `<div onclick>`。

## 硬性禁忌

- **页面上不要出现任何 emoji**。需要图标时用内联 SVG 或纯文字。
- 不要用渐变大面积铺底（小面积点缀可以）。
- 不要引入任何 CDN 资源。
