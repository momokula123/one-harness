'use strict';
// 渲染进程：三栏界面 + 时间线 + 工具卡 + 审批弹窗

const api = window.hatch;
const $ = (id) => document.getElementById(id);

// ---------------- 图标 ----------------
// 一律内联 SVG 线条图标，界面里不放 emoji（对照参考图的线性风格）。
const svg = (body, w) =>
  `<svg viewBox="0 0 24 24" width="${w || 16}" height="${w || 16}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS = {
  'panel-left': svg('<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="M9 4.5v15" stroke-width="2.4"/>'),
  'panel-right': svg('<rect x="3" y="4.5" width="18" height="15" rx="3.5"/><path d="M15 4.5v15" stroke-width="2.4"/>'),
  'arrow-left': svg('<path d="M14.5 5.5L8 12l6.5 6.5"/>'),
  'arrow-right': svg('<path d="M9.5 5.5L16 12l-6.5 6.5"/>'),
  refresh: svg('<path d="M20 11.5a8 8 0 1 1-2.3-5.6"/><path d="M20 4.5v5h-5"/>'),
  external: svg('<path d="M14 4.5h5.5V10"/><path d="M19.5 4.5L11 13"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>'),
  browser: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.6 9.5h16.8M3.6 14.5h16.8"/><path d="M12 3.5c2.5 2.4 2.5 14.6 0 17M12 3.5c-2.5 2.4-2.5 14.6 0 17"/>'),
  compose: svg('<path d="M11 4.5H6.5A2.5 2.5 0 0 0 4 7v11a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-4.5"/><path d="M17.8 3.4a2 2 0 0 1 2.9 2.9l-7.4 7.4-3.8.9.9-3.8z"/>'),
  plus: svg('<path d="M12 5.5v13M5.5 12h13"/>'),
  folder: svg('<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h2.8l1.9 2.4H18a2.5 2.5 0 0 1 2.5 2.5v6.6A2.5 2.5 0 0 1 18 19H6a2.5 2.5 0 0 1-2.5-2.5z"/>'),
  file: svg('<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5V8.5h5"/>'),
  // ---- 按文件类型分的图标（右栏「文件」列表用；形状区分开，扫一眼就能认出类别）----
  'file-code': svg('<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5V8.5h5"/><path d="M10 12.5l-1.8 2 1.8 2M14 12.5l1.8 2-1.8 2"/>'),
  'file-web': svg('<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5V8.5h5"/><circle cx="12" cy="14.5" r="3.2"/><path d="M8.8 14.5h6.4M12 11.3c1 1 1 5.4 0 6.4M12 11.3c-1 1-1 5.4 0 6.4"/>'),
  'file-text': svg('<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5V8.5h5"/><path d="M8.8 12.5h6.4M8.8 15.5h6.4M8.8 18h3.6"/>'),
  'file-data': svg('<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5V8.5h5"/><ellipse cx="12" cy="13" rx="3.6" ry="1.5"/><path d="M8.4 13v4c0 .8 1.6 1.5 3.6 1.5s3.6-.7 3.6-1.5v-4"/>'),
  'file-image': svg('<path d="M13.5 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8.5z"/><path d="M13.5 3.5V8.5h5"/><circle cx="10" cy="13" r="1.2"/><path d="M8.5 18.5l3-3 2 1.8 2.5-2.3 2 1.8"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.8l1.2 2.4 2.6-.6 1 2.5 2.6.6-.9 2.6 1.7 2.1-1.7 2.1.9 2.6-2.6.6-1 2.5-2.6-.6L12 21.2l-1.2-2.4-2.6.6-1-2.5-2.6-.6.9-2.6L3.8 12l1.7-2.1-.9-2.6 2.6-.6 1-2.5 2.6.6z"/>'),
  // shield 是"带勾的盾"= 有评审；shield-plain 是不带勾的 = 自动放行；hand = 人工确认
  shield: svg('<path d="M12 3.2l7 2.8v5.2c0 4.2-2.9 7.7-7 9-4.1-1.3-7-4.8-7-9V6z"/><path d="M9.2 12.1l2.1 2.1 3.9-4"/>'),
  'shield-plain': svg('<path d="M12 3.2l7 2.8v5.2c0 4.2-2.9 7.7-7 9-4.1-1.3-7-4.8-7-9V6z"/>'),
  hand: svg('<path d="M9 11V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 10.5V4.8a1.5 1.5 0 0 1 3 0V11"/><path d="M15 11V6.8a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-.6a6 6 0 0 1-5-2.7L3.4 14.4a1.6 1.6 0 0 1 2.5-2l1.6 1.8"/>'),
  chip: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="3"/><rect x="10" y="10" width="4" height="4" rx="1.2"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3"/>'),
  'arrow-up': svg('<path d="M12 19.5V5M6.2 10.8L12 5l5.8 5.8"/>'),
  stop: svg('<rect x="7" y="7" width="10" height="10" rx="2.4" fill="currentColor" stroke="none"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 6.2V5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15h.7"/>'),
  branch: svg('<path d="M6 8.4V15"/><circle cx="6" cy="5.6" r="2.6"/><circle cx="6" cy="17.9" r="2.6"/><circle cx="18" cy="9" r="2.6"/><path d="M15.4 9H12a4 4 0 0 0-4 4v.4"/>'),
  undo: svg('<path d="M4 8.5h10.5a4.5 4.5 0 0 1 0 9H8.5"/><path d="M7.3 5.2 4 8.5l3.3 3.3"/>'),
  // 新建会话菜单里每个程序项的图标（showNewSessionMenu 用 setAttribute('data-ic','chat') 挂的，
  // 所以按 data-ic="chat" 字面量 grep 是搜不到的——删图标前要先搜字符串 'chat'）
  chat: svg('<path d="M20 11.5a7 7 0 0 1-7 7H9l-4 3.2V16.4A7 7 0 0 1 9.4 4.5h3.1a7 7 0 0 1 7.5 7z"/>'),
  chevron: svg('<path d="M6 9.5l6 6 6-6"/>', 14),
  check: svg('<path d="M5.5 12.6l4.2 4.2L18.5 8"/>', 14),
  'win-min': svg('<path d="M5.5 12h13"/>', 12),
  'win-max': svg('<rect x="6" y="6" width="12" height="12" rx="1.6"/>', 12),
  'win-restore': svg('<rect x="5" y="8.5" width="10.5" height="10.5" rx="1.6"/><path d="M8.5 8.5V5.6A1.6 1.6 0 0 1 10.1 4h8.3A1.6 1.6 0 0 1 20 5.6v8.3a1.6 1.6 0 0 1-1.6 1.6h-2.9"/>', 12),
  'win-close': svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', 12),
  x: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>', 15),
};

function hydrateIcons(root) {
  for (const el of (root || document).querySelectorAll('[data-ic]')) {
    const name = el.getAttribute('data-ic');
    if (!ICONS[name] || el.getAttribute('data-ic-done') === name) continue;
    el.innerHTML = ICONS[name];
    el.setAttribute('data-ic-done', name);
  }
}

const S = {
  settings: null,
  programs: [],
  modules: [],
  catalog: [],
  // 思考强度的合法取值。**由内核下发**（core/store.js 那份白名单，实测自端点），
  // 界面不自己抄一份字面值 —— 抄了迟早会和内核走散。
  reasoningLevels: [],
  projects: [],
  sessions: [],
  tree: {},            // 各项目下的会话（侧栏项目树用），{ projectId: [session] }
  maximized: false,
  projectId: null,
  sessionId: null,
  session: null,
  meta: null,
  transcript: [],
  // 拖进输入框、等这条消息一起发出去的附件。
  // 每项：{ key, name, rel, from, state:'busy'|'ok'|'bad', note }
  // 归属是**会话**（复制目标就是 session.workingDir），所以换会话必须清空。
  atts: [],
  // 气泡缩略图的像素缓存。键是 `项目/会话/相对路径` —— 相对路径只在**某个会话的
  // 工作目录**里才有意义，两个会话完全可能各有一张 chart.png。
  // 内容是主进程 files:preview 的原始返回（含 data URL），换会话时清空，
  // 免得几张图的 base64 一直留在渲染层手里。
  previewCache: new Map(),
  running: false,
  // 正在跑的会话 id 集合。内核的 running 锁本来就是**按会话**记的，
  // 而 agent:event 又是按会话过滤的：如果界面只用一个全局布尔 S.running，
  // 就会出现「在 A 发了消息 → 切到 B → A 的 turn:end 被过滤丢掉」，
  // 于是 S.running 永远是 true：切回 A 也发不出消息，点停止也不会有事件再来（永久卡死）。
  // 所以这里跟内核同构，S.running 只是"当前会话在不在这个集合里"的派生值。
  runningIds: new Set(),
  // 设置模态框停在哪个分区。**只放内存、不落盘**：Bionic 用的是路由状态
  // （bionicSettingsHistory），不是 ui-state，照搬它才不会凭空多出字段。
  settingsSection: 'general',
  live: null,          // { text, reasoning, tools: {index: {name}} }
  pendingApproval: null,
  panel: 'files',
  files: [],
  preview: null,
  skills: [],
  skillEdit: null,
  roots: null,
  models: [],
};

// ---------------- 布局状态（ui-state/window-*.json 的渲染侧） ----------------
// 三栏宽度、折叠、当前右栏视图、上次打开的会话都存进 json，下次开窗原样恢复。
const LAYOUT_LIMITS = { left: [200, 480], right: [240, 640] };
const LAYOUT = { window: null, global: null, windowKey: 'main' };

function ws() {
  return (LAYOUT.window && LAYOUT.window.workspace) || {};
}

/** windowContext：Bionic 用它记"这个窗口打开过哪些项目、当前是哪个"（字段同名照抄）。 */
function wctx() {
  return (LAYOUT.window && LAYOUT.window.windowContext) || {};
}

/** 往 window 顶层写字段（workspace 之外的，比如 windowContext）。 */
function saveWindowLayout(patch) {
  LAYOUT.window = { ...(LAYOUT.window || {}), ...patch };
  return api.ui.patch(patch).catch(() => {});
}

/** 切当前项目：写 windowContext.activeProjectIdentifier，并把项目登记进 projectIdentifiers。 */
function setActiveProject(projectId) {
  const prev = wctx();
  const ids = Array.isArray(prev.projectIdentifiers) ? prev.projectIdentifiers.slice() : [];
  if (projectId && !ids.includes(projectId)) ids.push(projectId);
  return saveWindowLayout({
    windowContext: { type: 'workspace', projectIdentifiers: ids, activeProjectIdentifier: projectId || null },
  });
}

function applyLayoutGeometry() {
  const w = ws();
  const lw = Number(w.leftSidebarWidth) || 236;
  const rw = Number(w.rightPanelWidth) || 345;
  document.documentElement.style.setProperty('--left-w', lw + 'px');
  document.documentElement.style.setProperty('--right-w', rw + 'px');
  const app = $('app-root');
  if (app) {
    app.classList.toggle('no-left', !!w.leftSidebarIsCollapsed);
    app.classList.toggle('no-right', !!w.rightPanelIsCollapsed);
  }
}

let layoutSaveTimer = null;
function saveLayout(patch, opts) {
  if (patch) {
    LAYOUT.window = LAYOUT.window || {};
    LAYOUT.window.workspace = { ...(LAYOUT.window.workspace || {}), ...patch };
  }
  const run = () => api.ui.patch({ workspace: ws() }).catch(() => {});
  if (opts && opts.immediate) {
    if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
    layoutSaveTimer = null;
    return run();
  }
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => {
    layoutSaveTimer = null;
    run();
  }, 300);
}

function setPanelWidth(side, px) {
  const lim = side === 'left' ? LAYOUT_LIMITS.left : LAYOUT_LIMITS.right;
  const v = Math.min(lim[1], Math.max(lim[0], Math.round(px)));
  document.documentElement.style.setProperty(side === 'left' ? '--left-w' : '--right-w', v + 'px');
  return v;
}

function attachSplitter(elId, side) {
  const el = $(elId);
  const key = side === 'left' ? 'leftSidebarWidth' : 'rightPanelWidth';
  let startX = 0;
  let startW = 0;
  let last = null;
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = Number(ws()[key]) || (side === 'left' ? 236 : 345);
    document.body.classList.add('resizing');
    el.classList.add('dragging');
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      last = setPanelWidth(side, side === 'left' ? startW + dx : startW - dx);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('resizing');
      el.classList.remove('dragging');
      if (last != null) saveLayout({ [key]: last });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  el.addEventListener('dblclick', () => toggleSide(side));
}

function toggleSide(side) {
  const app = $('app-root');
  const cls = side === 'left' ? 'no-left' : 'no-right';
  const key = side === 'left' ? 'leftSidebarIsCollapsed' : 'rightPanelIsCollapsed';
  const next = !app.classList.contains(cls);
  app.classList.toggle(cls, next);
  saveLayout({ [key]: next }, { immediate: true });
}

// ---------------- 基础工具 ----------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** 行内标记：先转义，再认反引号 / 粗体 / 链接 */
function mdInline(s) {
  let t = esc(s);
  t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]\n]+)\]\((<?[^)\n]+>?)\)/g, (_m, txt, u) => {
    const href = u.replace(/^<|>$/g, ''); // 已转义过，别再转一次
    const safe = /^(https?:|mailto:|#|\/|\.)/i.test(href) ? href : '#';
    return `<a href="${safe}" data-link="${href}">${txt}</a>`;
  });
  return t;
}

// 逐行解析：标题 / 分隔线 / 有序无序列表 / 普通段落。
// 代码块先摘出去，免得里面的 # 和 * 被当成标记。
function mdToHtml(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n');
  const codes = [];
  const src = raw.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    codes.push('<pre class="code"><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
    return '\u0000CODE' + (codes.length - 1) + '\u0000';
  });

  // ---- markdown 表格 ----
  // 模型经常吐标准表格（本机实测 deepseek 就会给 `| 类型 | 代表 |` + `|---|---|`）。
  // 不支持的话整块会退化成"带竖线的一坨普通文字"，列全挤在一起 —— 用户报的
  // 「没对齐」就是这个。和代码块一样**整块提前摘出去**，别污染下面的逐行解析。
  const tables = [];
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l) && l.includes('-');
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
  const alignOf = (s) => {
    const L = s.startsWith(':');
    const R = s.endsWith(':');
    return L && R ? 'center' : (R ? 'right' : (L ? 'left' : ''));
  };
  const srcLines = src.split('\n');
  const lines = [];
  for (let i = 0; i < srcLines.length; i += 1) {
    // 判据：本行是 | … |，且**下一行是分隔行**（`|---|---|`）。分隔行不可缺 ——
    // 只有这样才敢认定这是表格，不然正文里随便一个带竖线的句子都会被吃掉。
    if (isRow(srcLines[i]) && i + 1 < srcLines.length && isSep(srcLines[i + 1])) {
      const head = cells(srcLines[i]);
      const aligns = cells(srcLines[i + 1]).map(alignOf);
      const body = [];
      let j = i + 2;
      while (j < srcLines.length && isRow(srcLines[j]) && !isSep(srcLines[j])) {
        body.push(cells(srcLines[j]));
        j += 1;
      }
      const attr = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : '');
      const th = head.map((c, k) => `<th${attr(k)}>${mdInline(c)}</th>`).join('');
      // 行数不足时用空串补齐（模型偶尔会漏格子），别让表格塌掉
      const trs = body.map((r) => '<tr>' + head
        .map((_c, k) => `<td${attr(k)}>${mdInline(r[k] == null ? '' : r[k])}</td>`)
        .join('') + '</tr>').join('');
      // 外面套一层滚动容器：列多的时候表格比气泡宽，宁可它自己横向滚，也别撑破布局
      tables.push('<div class="tbl-wrap"><table><thead><tr>' + th + '</tr></thead><tbody>' + trs + '</tbody></table></div>');
      lines.push('\u0000TABLE' + (tables.length - 1) + '\u0000');
      i = j - 1;
      continue;
    }
    lines.push(srcLines[i]);
  }

  const out = [];
  let para = [];
  let items = [];
  let ordered = false;
  const flushPara = () => {
    if (!para.length) return;
    out.push('<p>' + para.map(mdInline).join('<br>') + '</p>');
    para = [];
  };
  const flushList = () => {
    if (!items.length) return;
    const tag = ordered ? 'ol' : 'ul';
    out.push(`<${tag}>` + items.map((t) => `<li>${mdInline(t)}</li>`).join('') + `</${tag}>`);
    items = [];
    ordered = false;
  };

  for (const line of lines) {
    const code = /^\u0000CODE\d+\u0000$/.test(line.trim());
    const table = /^\u0000TABLE\d+\u0000$/.test(line.trim());
    const hr = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
    const head = /^(#{1,6})\s+(.+)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const num = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (code || table || hr || head) {
      flushPara();
      flushList();
      if (code) out.push(line.trim());
      else if (table) out.push(line.trim());
      else if (hr) out.push('<hr>');
      else {
        // 模型大多用 ## / ###，往下压一级当 h2/h3 用，正文层级才顺
        const lv = Math.min(3, Math.max(1, head[1].length + 1));
        out.push(`<h${lv}>${mdInline(head[2])}</h${lv}>`);
      }
      continue;
    }
    if (bullet || num) {
      flushPara();
      const ord = !!num;
      if (items.length && ord !== ordered) flushList();
      ordered = ord;
      items.push((bullet || num)[1]);
      continue;
    }
    // 空行是**段落分隔符**，不是内容。三件事都不能做：
    //   ① 不能把它塞进 para 再 join('<br>')——模型实测会连着吐 \n\n\n\n\n（用户那个会话
    //      8 个气泡里就有 8 个 <br>），渲染出来就是界面里那一大片空行；
    //   ② 不能让它留在列表之间被 flushPara 撞见，否则会吐出一个空的 <p></p>，
    //      而 .md p 走浏览器默认 16px 边距，一个空段落就是一大块空白；
    //   ③ 不能顺手 flushList() 把列表拆成两半——.md ul 上下各有 6px/10px 边距，
    //      模型爱在列表项之间插空行，拆一次就凭空多 16px。
    // 所以：空行只 flushPara（断开段落），连续多个空行自然塌缩成一个段落断点。
    if (!line.trim()) { flushPara(); continue; }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();

  // 块之间**不能**用 '\n' 拼：气泡容器原来是 white-space:pre-wrap，这个字面换行会被当成
  // 真换行渲染 → 每个块边界凭空多出一整行（22px），而且那个匿名内联框还会阻止相邻 margin
  // 合并（于是 p→p 从 9px 变成 31px，p→h3 从 18px 变成 49px，用户看到的就是"还是很多空行"）。
  // 用 '' 直接拼，块与块之间不留任何文本节点。
  return out.join('')
    .replace(/\u0000CODE(\d+)\u0000/g, (_m, i) => codes[Number(i)])
    .replace(/\u0000TABLE(\d+)\u0000/g, (_m, i) => tables[Number(i)]);
}

function timeStr(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 5200);
}

function fmtBytes(n) {
  if (n == null) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/** 消息右下角那种只有图标的小按钮 */
function iconBtn(icon, title, onClick) {
  const b = document.createElement('button');
  b.className = 'act-btn';
  b.title = title;
  b.innerHTML = ICONS[icon] || '';
  b.onclick = (e) => {
    e.stopPropagation();
    onClick();
  };
  return b;
}

async function copyText(text) {
  const s = String(text || '');
  if (!s) return;
  try {
    await navigator.clipboard.writeText(s);
    toast('已复制', 'ok');
    return;
  } catch {}
  // file:// 下剪贴板 API 偶尔不可用，退回到老办法
  const ta = document.createElement('textarea');
  ta.value = s;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'err');
}

function setMaximized(on) {
  S.maximized = !!on;
  const b = $('win-max');
  if (!b) return;
  b.setAttribute('data-ic', on ? 'win-restore' : 'win-max');
  b.removeAttribute('data-ic-done');
  hydrateIcons(b.parentElement || b);
  b.title = on ? '还原' : '最大化';
}

// ---------------- 启动 ----------------
async function init() {
  const boot = await api.boot();
  S.settings = boot.settings;
  S.programs = boot.programs;
  S.modules = boot.modules;
  S.catalog = boot.catalog;
  S.reasoningLevels = boot.reasoningLevels || [];
  S.projects = boot.projects;
  S.roots = boot.roots;

  LAYOUT.global = boot.ui ? boot.ui.global : null;
  LAYOUT.window = boot.ui ? boot.ui.window : null;
  LAYOUT.windowKey = (boot.ui && boot.ui.windowKey) || 'main';
  // 宽度/折叠先落地，避免开窗后闪一下再归位
  applyLayoutGeometry();

  // 上次停在哪个项目，也记在布局状态里
  const lastProject = wctx().activeProjectIdentifier;
  S.projectId = S.projects.some((p) => p.id === lastProject)
    ? lastProject
    : (S.projects[0] ? S.projects[0].id : null);

  const ml = await api.models.list();
  S.models = ml.ok ? ml.models : [];
  // 主进程可能在这次调用里按端点推荐把模型补上了（设置里为空、或填的那个端点没有），
  // 这里同步一下，输入框那个模型 chip 才会显示真正在用的模型而不是"未连接"。
  if (ml.ok && ml.model && S.settings && S.settings.model.model !== ml.model) {
    const wasSet = !!S.settings.model.model;
    S.settings.model.model = ml.model;
    if (wasSet) toast('原模型在这端点上没有，已改用 ' + ml.model, 'ok');
  }

  hydrateIcons(document);
  renderNewSessionMenu();
  renderApprovalOptions();
  renderModelSelect();
  renderToolsPanel();
  await refreshSessions();
  // 上次打开的是哪个会话，也记在布局状态里
  const remembered = (ws().activeSessionPerProjectIdentifier || {})[S.projectId];
  const target = S.sessions.find((s) => s.id === remembered) || S.sessions[0];
  if (target) await loadSession(target.id);
  else {
    $('transcript').innerHTML = '<div class="empty">左侧选一个项目，或用输入框左边的 + 新建一个会话。</div>';
    renderTop();
  }
  await refreshSkills();
  // 右栏现在是四页：浏览器 / 文件 / 技能 / 工具（设置已搬去模态框）。
  // 默认停在「文件」（用户指定）；落盘值里存的是别的合法页就尊重它，非法/老值（如 'settings'）兜到 files。
  const savedView = ws().devRightPanelView;
  switchPanel(['browser', 'files', 'skills', 'tools'].includes(savedView) ? savedView : 'files', { persist: false });
  await refreshFiles();

  api.events.onAgentEvent(handleAgentEvent);
  api.events.onApprovalRequest(showApproval);
  api.win.onStateChange((st) => setMaximized(!!st.maximized));
  S.maximized = await api.win.isMaximized();
  setMaximized(S.maximized);

  setInterval(refreshFilesIfIdle, 4000);

  if (!ml.ok) {
    showBanner('连不上模型端点：' + ml.error + ' —— 确认这个地址上的服务在跑，或到设置里改 Base URL。', '去设置', () => switchPanel('settings'));
  } else if (!S.models.length) {
    showBanner('模型端点已连通，但一个模型都没列出来。确认服务侧已经拉起模型（要支持工具调用）。', '去设置', () => switchPanel('settings'));
  }
  console.log('HATCH_RENDERER_READY sessions=' + S.sessions.length + ' programs=' + S.programs.length + ' tools=' + S.catalog.length + ' models=' + S.models.length + ' skills=' + S.skills.length);
}

function showBanner(text, actionLabel, action) {
  $('banner-text').textContent = text;
  const btn = $('banner-action');
  btn.textContent = actionLabel;
  btn.onclick = action;
  $('banner').classList.remove('hidden');
}

function hideBanner() {
  $('banner').classList.add('hidden');
}

// ---------------- 左栏：项目树 ----------------
// 结构对照参考图：[图标] 项目名，下面挂它自己的会话（会话行不缩进图标位，直接与项目名左对齐）。
// 折叠状态存进布局文件的 workspaceSidebarCollapsedProjectIdentifiers（Bionic 同名字段）。
function collapsedProjects() {
  const raw = ws().workspaceSidebarCollapsedProjectIdentifiers;
  return new Set(Array.isArray(raw) ? raw : []);
}

function treeNode(cls, icon) {
  const el = document.createElement('div');
  el.className = 'node' + (cls ? ' ' + cls : '');
  const i = document.createElement('span');
  i.className = 'ic';
  if (icon) i.setAttribute('data-ic', icon);
  const nm = document.createElement('span');
  nm.className = 'nm';
  el.appendChild(i);
  el.appendChild(nm);
  return el;
}

function renderTree() {
  const box = $('project-tree');
  if (!box) return;
  box.innerHTML = '';
  const collapsed = collapsedProjects();

  for (const p of S.projects) {
    const open = !collapsed.has(p.id);
    const row = treeNode('', 'folder');
    row.title = p.cwd ? `${p.name}\n${p.cwd}` : p.name;
    row.querySelector('.nm').textContent = p.name;
    if (p.id === S.projectId) row.classList.add('current');
    row.onclick = () => {
      if (p.id === S.projectId) {
        const set = collapsedProjects();
        set.has(p.id) ? set.delete(p.id) : set.add(p.id);
        saveLayout({ workspaceSidebarCollapsedProjectIdentifiers: [...set] }, { immediate: true });
        renderTree();
      } else {
        setProject(p.id);
      }
    };
    // 删除入口：常驻显示（不藏在 hover 里 —— 那样真实鼠标点不到、用户也发现不了）。
    // 用真 <button> 而不是 span：语义对、能用键盘，而且会被真实鼠标那层的"全量体检"
    // （选择器里含 'button'）自动扫到，不必只靠我手写的一条断言兜着。
    // 必须 stopPropagation，否则点删除会连带触发行的"折叠/切换项目"。
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'row-del';
    del.id = 'del-project-' + p.id;
    del.title = '删除项目（只摘索引，磁盘上的记录与工作目录都保留）';
    del.setAttribute('data-ic', 'x');
    del.onclick = (e) => { e.stopPropagation(); removeProject(p); };
    row.appendChild(del);
    box.appendChild(row);

    if (!open) continue;
    const list = S.tree[p.id] || [];
    if (!list.length) {
      const none = treeNode('sub empty-note', '');
      none.querySelector('.nm').textContent = p.id === S.projectId ? '还没有会话' : '—';
      none.style.cursor = 'default';
      none.onclick = null;
      none.style.color = 'var(--text-4)';
      none.style.fontSize = '12px';
      box.appendChild(none);
      continue;
    }
    for (const s of list) {
      const el = treeNode('sub' + (s.id === S.sessionId ? ' active' : ''), '');
      el.title = `${s.name}\n${s.programId} · ${s.entryCount} 条 · ${new Date(s.updatedAt).toLocaleString()}`;
      el.querySelector('.nm').textContent = s.name;
      if (s.id === S.sessionId && S.running) {
        const dot = document.createElement('span');
        dot.className = 'spin';
        el.appendChild(dot);
      }
      el.onclick = () => openSession(p.id, s.id);
      box.appendChild(el);
    }
  }
  hydrateIcons(box);
}

/** 侧栏底部「聊天」区已在 2026-09-16 按用户要求整体移除（连折叠框架一起）。
 *  保留这个空注释只是给后来人指路：如果又要跨项目最近会话，这里是原来的位置，
 *  渲染逻辑可参考 git 历史里的 renderChatSection()。 */

async function openSession(projectId, sessionId) {
  if (projectId !== S.projectId) return setProject(projectId, { sessionId });
  if (sessionId !== S.sessionId) return loadSession(sessionId);
}

/**
 * 应用内的「给项目起名」对话框。
 * 不能用 window.prompt —— Electron 渲染层禁用原生弹窗，调用直接抛
 * `prompt() is not supported.`，而这个抛错发生在 async 事件处理器里会变成
 * 未处理拒绝：界面一点反应都没有，看起来就是"点了没反应"。
 * 返回：名字（字符串）或 null（取消）。
 */
function askProjectName(dir) {
  return new Promise((resolve) => {
    const back = $('project-modal');
    const input = $('project-name-input');
    const fallback = String(dir || '').split(/[\\/]/).filter(Boolean).pop() || '新项目';
    let settled = false;

    $('project-dir').textContent = dir
      ? '工作目录：' + dir
      : '没有选目录，工作区放在 One Harness 的数据目录里。';
    input.value = fallback;

    const finish = (val) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      back.classList.add('hidden');
      input.blur();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || fallback); }
    };

    $('project-create').onclick = () => finish(input.value.trim() || fallback);
    $('project-cancel').onclick = () => finish(null);
    back.onclick = (e) => { if (e.target === back) finish(null); };
    document.addEventListener('keydown', onKey, true);

    back.classList.remove('hidden');
    input.focus();
    input.select();
  });
}

/**
 * 应用内通用确认框（有副作用、需要用户点头的动作走这里）。
 * 为什么不用 window.confirm：Electron 渲染层禁用了原生 prompt/confirm/alert，调了直接抛
 * —— "新建项目"当初就是因为这个变成"点了没反应"（见 docs 里的那段复盘）。
 * text 支持多行（\n）。
 * loc: { label, path, title, onOpen } —— 可选的"位置"行：显示一个路径，点它就打开那个文件夹。
 *      删除项目用它告诉用户"东西在哪"，比在正文里堆一长段路径清楚得多。
 */
function askConfirm({ title, text, okLabel, cancelLabel, danger, loc }) {
  return new Promise((resolve) => {
    const back = $('confirm-modal');
    let settled = false;
    $('confirm-title').textContent = title || '确认';
    $('confirm-text').textContent = text || '';
    const ok = $('confirm-ok');
    ok.textContent = okLabel || '确定';
    ok.classList.toggle('danger', danger !== false);
    $('confirm-cancel').textContent = cancelLabel || '取消';

    const locRow = $('confirm-loc-row');
    const locBtn = $('confirm-loc');
    if (loc && loc.path) {
      $('confirm-loc-label').textContent = (loc.label || '位置：');
      locBtn.textContent = loc.path;
      locBtn.title = loc.title || '点击打开这个文件夹';
      locBtn.onclick = (e) => { e.stopPropagation(); if (loc.onOpen) loc.onOpen(); };
      locRow.classList.remove('hidden');
    } else {
      locRow.classList.add('hidden');
      locBtn.onclick = null;
    }

    const finish = (val) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      back.classList.add('hidden');
      locRow.classList.add('hidden');   // 下一个人用这个框时别把上一条的位置留着
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    };
    ok.onclick = () => finish(true);
    $('confirm-cancel').onclick = () => finish(false);
    back.onclick = (e) => { if (e.target === back) finish(false); };
    document.addEventListener('keydown', onKey, true);
    back.classList.remove('hidden');
    ok.focus();
  });
}

/**
 * 删除项目 = **只摘索引**（见 core/store.js 的 deleteProject）：项目列表里去掉这一条，
 * 磁盘上的记录目录、会话、检查点、工作目录一律不动。
 * 文案刻字要短（用户点名要求精简）：一句话说清"删的是索引、不删文件"，
 * 再挂一行可点的「工程位置」让他自己去看 —— 比在正文里堆一长段路径清楚得多。
 */
async function removeProject(p) {
  const info = await api.projects.deleteInfo({ projectId: p.id });
  const locPath = (info && info.recordDir) || null;
  const ok = await askConfirm({
    title: '删除项目「' + p.name + '」',
    text: '本操作只删除此工程的索引（从列表中移除），不删除磁盘上的任何文件。' +
      ((info && info.sessionCount) ? '它的 ' + info.sessionCount + ' 个会话记录与工作目录都会原样保留。' : ''),
    loc: locPath ? {
      label: '记录位置：',
      path: locPath,
      title: '点击打开这个文件夹（会话记录都在里面，删除后依然保留）',
      onOpen: () => api.shell.openPath(locPath),
    } : null,
    okLabel: '删除索引',
    danger: true,
  });
  if (!ok) return false;

  const r = await api.projects.remove({ projectId: p.id });
  if (!r || !r.ok) { toast((r && r.message) || '删除失败', 'err'); return false; }

  const wasCurrent = S.projectId === p.id;
  if (wasCurrent) {
    // 标签栏是所有项目共用的一条数组：先把被删项目的标签摘掉，
    // 否则它们会一直挂在那儿，点一下就报「会话不存在」。
    for (const s of (S.tree[p.id] || [])) dropTab(p.id, s.id);
  }
  S.projects = await api.projects.list();
  delete S.tree[p.id];
  if (wasCurrent) {
    // setProject 对"同一个项目"会直接 return，所以先清空当前项目再切
    S.projectId = null;
    S.sessionId = null;
    S.session = null;
    S.meta = null;
    S.transcript = [];
    S.sessions = [];
    syncRunning();
  }
  renderTree();
  toast('已删除项目「' + p.name + '」的索引（文件与工作目录都保留）');
  if (wasCurrent) {
    const next = S.projects[0];
    if (next) await setProject(next.id, { sessionId: null });
    else { renderTop(); renderTranscript(); showNoSession(); }
  }
  await refreshSessions();
  renderTree();
  return true;
}

async function setProject(projectId, opts) {
  if (!projectId || projectId === S.projectId) return;
  S.projectId = projectId;
  S.sessionId = null;
  S.session = null;
  S.meta = null;
  S.transcript = [];
  syncRunning(); // 会话已置空，运行状态跟着重算
  // 顺手清掉会话列表：它是"当前项目"的推导结果，留着上一个项目的值，
  // 一旦下面 refreshSessions 失败，target 就会来自别的项目 → 「会话不存在」。
  S.sessions = [];
  setActiveProject(projectId);
  await refreshSessions();
  const want = (opts && opts.sessionId) || (ws().activeSessionPerProjectIdentifier || {})[projectId];
  const target = S.sessions.find((s) => s.id === want) || S.sessions[0];
  if (target) await loadSession(target.id);
  else {
    renderTop();
    $('transcript').innerHTML = '<div class="empty">这个项目下还没有会话。</div>';
  }
  await refreshFiles();
}

// ---------------- 输入框「+」：新建会话 ----------------
function renderNewSessionMenu() {
  const box = $('new-session-menu');
  if (!box) return;
  box.innerHTML = '<div class="pop-title">新建会话</div>';
  for (const p of S.programs) {
    const el = document.createElement('div');
    el.className = 'pop-item';
    el.title = p.description || '';
    const i = document.createElement('span');
    i.className = 'ic';
    i.setAttribute('data-ic', 'chat');
    const nm = document.createElement('span');
    // 专用会话这一项行为和其他项不同（有就打开、没有才建），名字上标出来
    nm.textContent = p.modelSource === 'fallback' ? p.label + '（专用会话）' : p.label;
    el.appendChild(i);
    el.appendChild(nm);
    el.onclick = () => {
      hideNewSessionMenu();
      // 专用会话走"打开或新建"：它要的是**那一个**走自带模型的选项卡，
      // 不是每点一次多一个同名标签（见 openDefaultSession 的说明）。
      if (p.modelSource === 'fallback') return openDefaultSession();
      createSession(p.id);
    };
    box.appendChild(el);
  }
  hydrateIcons(box);
}

function showNewSessionMenu() {
  const box = $('new-session-menu');
  if (!box) return;
  renderNewSessionMenu();
  box.classList.remove('hidden');
}

function hideNewSessionMenu() {
  const box = $('new-session-menu');
  if (box) box.classList.add('hidden');
}

// ---------------- 下拉浮层（自定义，替代原生 select） ----------------
// 为什么不用原生 <select>：点开的选项列表是**系统**画的（Windows 上就是那个灰白系统菜单），
// 圆角/字号/hover/勾号统统不受 CSS 控制，跟应用其他部分不是一套观感。
// 所以触发器（图标按钮 / chip / 表单框）+ 自绘浮层，浮层规范照 Bionic 逐项抄（见 styles.css）。
let selOpen = null;   // { trigger, items, onPick, value, hi }

function ensureSelPop() {
  let el = $('sel-pop');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'sel-pop';
  el.className = 'sel-pop hidden';
  el.setAttribute('role', 'listbox');
  document.body.appendChild(el);
  return el;
}

/** 关掉浮层。restoreFocus=true 时把焦点还给触发器（键盘操作要用） */
function closeSelect(restoreFocus) {
  const cur = selOpen;
  selOpen = null;
  const pop = $('sel-pop');
  if (pop) { pop.classList.add('hidden'); pop.innerHTML = ''; pop.className = 'sel-pop hidden'; }
  if (cur && cur.trigger) {
    cur.trigger.setAttribute('aria-expanded', 'false');
    cur.trigger.classList.remove('open');
    if (restoreFocus && cur.trigger.focus) cur.trigger.focus();
  }
}

/**
 * 打开下拉。triggerElOrId：触发器元素或 id。
 * items: [{ value, label, desc?, icon?, disabled? }]，另外支持 { title } 分组标题和 { sep: true } 分隔线。
 * opts: { value 当前值, onPick(value), density:'compact'|'normal', width: 数字 | 'trigger' | 'fit', minWidth }
 */
function openSelect(triggerElOrId, items, opts = {}) {
  const trigger = typeof triggerElOrId === 'string' ? $(triggerElOrId) : triggerElOrId;
  if (!trigger || trigger.disabled) return;
  if (selOpen && selOpen.trigger === trigger) return closeSelect(true);   // 再点一次 = 收起
  closeSelect(false);

  const pop = ensureSelPop();
  const cur = opts.value;
  pop.className = 'sel-pop' + (opts.density === 'normal' ? ' normal' : '');
  pop.innerHTML = items.map((it) => {
    if (it.sep) return '<div class="sel-sep"></div>';
    if (it.title) return `<div class="sel-grp">${esc(it.title)}</div>`;
    const on = it.value === cur;
    return `<div class="sel-item${on ? ' on' : ''}${it.disabled ? ' dis' : ''}" role="option"
      aria-selected="${on ? 'true' : 'false'}" data-v="${esc(it.value)}"
      title="${esc(it.desc || it.label)}">
      ${it.icon ? `<span class="ic" data-ic="${esc(it.icon)}"></span>` : ''}
      <span class="sel-txt">${esc(it.label)}</span>
      ${on ? '<span class="ic sel-check" data-ic="check"></span>' : ''}
    </div>`;
  }).join('');
  hydrateIcons(pop);

  // 宽度：照 Bionic 的档位 sm=180 / md=256 / lg=320 / xl=384 / fit=自适应内容；
  // 默认（'trigger'）跟触发器同宽——Radix 也是这么做的，
  // 但表单里的触发器可能很宽（设置里那个 618px），跟过去会得到一个巨宽的菜单，所以那种用 fit。
  const r = trigger.getBoundingClientRect();
  pop.style.visibility = 'hidden';
  pop.classList.remove('hidden');
  pop.style.minWidth = (opts.minWidth || 0) + 'px';
  if (opts.width === 'fit') pop.style.width = 'auto';
  else if (typeof opts.width === 'number') pop.style.width = opts.width + 'px';
  else pop.style.width = r.width + 'px';
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;

  // 定位：默认贴触发器下方；下面放不下且上面更宽裕就翻上去。左右贴触发器并与窗口留 8px 边。
  const gap = 6, edge = 8;
  const below = window.innerHeight - r.bottom, above = r.top;
  const up = below < h + gap + edge && above > below;
  let left = r.left;
  if (opts.align === 'right') left = r.right - w;
  left = Math.min(Math.max(edge, left), Math.max(edge, window.innerWidth - w - edge));
  pop.style.left = Math.round(left) + 'px';
  pop.style.top = Math.round(up ? Math.max(edge, r.top - h - gap) : Math.min(window.innerHeight - h - edge, r.bottom + gap)) + 'px';
  pop.style.visibility = '';

  selOpen = { trigger, items, onPick: opts.onPick, value: cur, hi: -1 };
  trigger.setAttribute('aria-expanded', 'true');
  trigger.classList.add('open');

  for (const el of pop.querySelectorAll('.sel-item')) {
    el.onclick = () => pickSelect(el.dataset.v);
    el.onmouseenter = () => highlight(el);
  }
  const on = pop.querySelector('.sel-item.on');
  if (on) highlight(on);
}

function pickSelect(value) {
  const cur = selOpen;
  if (!cur) return;
  const it = cur.items.find((x) => x.value === value);
  if (!it || it.disabled) return;
  closeSelect(false);
  if (cur.onPick) cur.onPick(value);
  if (cur.trigger && cur.trigger.focus) cur.trigger.focus();
}

function highlight(el) {
  if (!selOpen) return;
  const pop = $('sel-pop');
  for (const x of pop.querySelectorAll('.sel-item')) x.classList.remove('hi');
  el.classList.add('hi');
  selOpen.hi = [...pop.querySelectorAll('.sel-item')].indexOf(el);
  if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}

/** 浮层开着时的键盘：上下移动、回车选中、Esc 关掉、Tab 关掉 */
function selectKeydown(e) {
  if (!selOpen) return;
  const pop = $('sel-pop');
  const all = [...pop.querySelectorAll('.sel-item:not(.dis)')];
  if (!all.length) return;
  const at = all.findIndex((x) => x.classList.contains('hi'));
  if (e.key === 'Escape') {
    e.preventDefault();
    // 必须是 stopImmediatePropagation：stopPropagation 挡不住**同一个节点**上的其他监听器
    // （设置在 document 上也有一个 Esc 处理，不加这一句会连设置模态框一起关掉）
    e.stopImmediatePropagation();
    closeSelect(true);
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const d = e.key === 'ArrowDown' ? 1 : -1;
    const next = all[at < 0 ? (d > 0 ? 0 : all.length - 1) : (at + d + all.length) % all.length];
    highlight(next);
    return;
  }
  if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); highlight(all[e.key === 'Home' ? 0 : all.length - 1]); return; }
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const el = all[at < 0 ? 0 : at]; if (el) pickSelect(el.dataset.v); }
}

// 审批模式四档。trigger 上的图标跟着当前档走（Bionic 也是每个模式一个图标：
// BioShieldCheck / BioHand / BioCircleOff），不然这个按钮完全看不出现在是哪一档。
const APPROVAL_MODES = [
  { value: '', label: '跟随全局设置', icon: 'gear', desc: '用「设置 → 会话 → 新会话默认模式」那一档' },
  { value: 'auto', label: '自动放行', icon: 'shield-plain', desc: '只在极高危命令时拦截' },
  { value: 'reviewer', label: '评审子会话', icon: 'shield', desc: '低风险直接过，其余交给评审子会话（默认）' },
  { value: 'always-ask', label: '每次询问', icon: 'hand', desc: '每一次工具调用都要你确认' },
];

function approvalModeOf(value) {
  return APPROVAL_MODES.find((m) => m.value === (value || '')) || APPROVAL_MODES[0];
}

/** 把当前会话的审批模式画到 trigger 上：图标 + tooltip */
function renderApprovalOptions() {
  const btn = $('approval-select');
  if (!btn) return;
  const m = approvalModeOf(S.meta && S.meta.approvalMode);
  btn.dataset.ic = m.icon;
  btn.removeAttribute('data-ic-done');    // 换个图标要重新注水
  hydrateIcons(btn.parentElement || btn);
  const globalMode = approvalModeOf((S.settings && S.settings.approval && S.settings.approval.mode) || '').label;
  btn.title = `审批模式（只改当前会话）：${m.label}` + (m.value ? '' : `（= ${globalMode}）`);
}

/** 打开审批模式下拉（会话级） */
function openApprovalSelect() {
  const cur = (S.meta && S.meta.approvalMode) || '';
  const globalMode = (S.settings && S.settings.approval && S.settings.approval.mode) || '';
  openSelect('approval-select', [
    { title: '当前会话' },
    ...APPROVAL_MODES.map((m) => ({
      value: m.value,
      label: m.label,
      icon: m.icon,
      desc: m.value === '' ? `跟随全局设置（现在全局是「${approvalModeOf(globalMode).label}」）` : m.desc,
    })),
  ], {
    value: cur,
    width: 180,               // Bionic 的 sm 档：触发器只有一个图标，跟触发器同宽会窄成一条
    onPick: async (v) => {
      const r = await api.sessions.update({ projectId: S.projectId, sessionId: S.sessionId, patch: { approvalMode: v || null } });
      S.meta = r.meta;
      renderTop();
      toast(v ? '本会话审批模式：' + approvalModeOf(v).label : '本会话跟随全局设置');
    },
  });
}

// 「One Harness」专用会话：模型固定走程序自带的那份，切不了。
// 它在会话列表里的唯一凭据是 programId（见 core/prompts.js 的 modelSource），
// 内核那边记的是 session.modelSource —— 两处说的是同一件事，别各自判一套。
const DEFAULT_LLM_PROGRAM = 'default-llm';
// 下拉里那一项"去专用会话"用的哨兵值：模型名可以叫任何东西，得有个不会撞的名字
const DEFAULT_LLM_ENTRY = '@default-llm';
// 这个会话的标签名 / 左栏那个固定入口的文字。**只此一处**，改文案别在两处各写一遍。
const DEFAULT_SESSION_LABEL = 'One Harness';

function sessionUsesFallback() {
  return !!(S.session && S.session.modelSource === 'fallback');
}

/** 兜底那份语言模型的模型名（界面显示用） */
function fallbackModelName() {
  const fb = (S.settings && S.settings.fallback) || {};
  return (fb.llm && fb.llm.model) || '';
}

/** 当前会话**实际**打哪个模型 —— 专用会话是兜底那份，普通会话是生效设置里那套 */
function currentModelName() {
  if (sessionUsesFallback()) return fallbackModelName();
  return (S.settings && S.settings.model.model) || '';
}

/**
 * 当前会话的上下文容量（占用条的分母）。
 * 与内核**同口径** —— core/store.js 的 endpointFor：专用会话按兜底那份算（agnes 是 512K），
 * 普通会话按生效设置那个数。两边不一致的话，界面会显示一个和"什么时候真的会压缩"对不上的百分比。
 */
function contextLimitOf() {
  if (sessionUsesFallback()) {
    const fb = ((S.settings && S.settings.fallback) || {}).llm || {};
    const n = Number(fb.contextLength);
    if (n > 0) return n;
  }
  return Number(S.settings.model.contextLength) || 16384;
}

function renderModelSelect() {
  const chip = $('model-select');
  const cur = currentModelName();
  const pinned = sessionUsesFallback();
  const nameEl = $('model-name');
  if (nameEl) nameEl.textContent = cur || '未连接模型';
  if (chip) {
    chip.title = pinned
      ? `${DEFAULT_SESSION_LABEL} 专用会话：固定走程序自带的那份（${cur || '未配置'}），改不了`
      : (cur ? `模型：${cur}（点开切换）` : '未连接模型端点（点开选择）');
  }
  // 左栏那个固定入口的高亮跟着一起刷新 —— 它俩问的是同一个问题（"当前会话是不是它"），
  // 放在这里就不会出现"chip 说在专用会话里、左栏却没亮"这种不一致。
  renderFootDefault();
}

/** 打开模型下拉 */
function openModelSelect() {
  // 专用会话的模型是锁死的（会话建出来就带上 modelSource，没有改它的入口）。
  // 与其给一个按了没反应的下拉，不如直接说清楚该去哪儿换。
  if (sessionUsesFallback()) {
    toast('这是 ' + DEFAULT_SESSION_LABEL + ' 专用会话：模型固定走程序自带的那份。想换模型请新建一个普通会话；想换自带模型本身去「设置 → 兜底模型」');
    return;
  }
  const cur = currentModelName();
  const fbName = fallbackModelName();
  const list = S.models.slice();
  if (cur && !list.includes(cur)) list.unshift(cur);
  if (!list.length) {
    toast('还没有模型列表——先到设置里点「拉取模型列表」', 'err');
    openSettings('general');
    return;
  }
  // ★ 自带模型不进普通会话的"切换"候选：它有自己的专用会话。
  // 留一条"切换到这个模型"在这儿，用户点了会以为切好了，实际是把全局设置改了 —— 两回事。
  const items = list
    .filter((m) => m !== fbName || m === cur)
    .map((m) => ({ value: m, label: m, desc: m === cur ? '当前使用' : '切换到这个模型' }));
  if (fbName) {
    items.push({
      value: DEFAULT_LLM_ENTRY,
      label: fbName + '（' + DEFAULT_SESSION_LABEL + '）',
      desc: '程序自带的那份模型：只能用在 ' + DEFAULT_SESSION_LABEL + ' 专用会话里。选它会打开那个会话，不动这里正在用的模型',
    });
  }
  openSelect('model-select', items, {
    value: cur,
    width: 256,               // Bionic 的 md 档（16rem）：模型名字长，别跟着 chip 宽度挤
    onPick: async (v) => {
      if (v === DEFAULT_LLM_ENTRY) return openDefaultSession();
      S.settings = await api.settings.save({ model: { model: v } });
      if (S.session) await api.sessions.update({ projectId: S.projectId, sessionId: S.sessionId, patch: { model: { model: v } } });
      renderModelSelect();
      renderSettingsModal();
      toast('模型已切换为 ' + v, 'ok');
    },
  });
}

/**
 * 打开「One Harness」专用会话；这个项目里还没有就建一个。
 * 之所以"有就打开、没有才建"：它的定位就是**专门用自带模型的那一个选项卡**，
 * 每点一次多一个同名标签的话，用户要找的就不再是"那一个"了。
 * 三个入口都走这里（左栏底部固定项 / 新建会话菜单 / 模型下拉那一项）—— 语义必须一致。
 */
async function openDefaultSession() {
  if (!S.projectId) { toast('先创建项目', 'err'); return null; }
  const found = (S.sessions || []).find((s) => s.programId === DEFAULT_LLM_PROGRAM);
  if (found) {
    if (found.id === S.sessionId) { toast('已经在这个会话里了'); $('input').focus(); return found; }
    await loadSession(found.id, S.projectId);
    toast('已切到 ' + DEFAULT_SESSION_LABEL + '：它固定走程序自带的那份模型');
    return found;
  }
  return createSession(DEFAULT_LLM_PROGRAM, DEFAULT_SESSION_LABEL);
}

/**
 * 左栏底部那个固定入口的高亮：当前会话正是专用会话时点亮。
 * 只改 class 与 title，不重建节点 —— 它是 HTML 里写死的常驻元素，
 * 反复 innerHTML 会把绑在上面的 click 一起丢掉。
 */
function renderFootDefault() {
  const el = $('btn-default-session');
  if (!el) return;
  const on = sessionUsesFallback();
  const nm = fallbackModelName();
  el.classList.toggle('on', on);
  el.title = on
    ? '当前就在 ' + DEFAULT_SESSION_LABEL + ' 专用会话里（固定走 ' + (nm || '未配置') + '）'
    : DEFAULT_SESSION_LABEL + '：走程序自带的那份模型开聊' + (nm ? '（' + nm + '）' : '') + '，不用自己配端点';
}

// ---------------- 会话 ----------------
async function refreshSessions() {
  if (!S.projects.length) return;
  // 项目树要显示每个项目下的会话，所以一次把全部项目的会话列表读回来。
  // 用 allSettled 而不是 all：某个项目读不出来（目录被删、json 坏了）不能拖垮整次刷新——
  // 一旦这里抛错，S.sessions 会留着上一个项目的列表，接着按"当前项目"去 load，
  // 就会拿别的项目的会话 id 去报「会话不存在」。
  const results = await Promise.allSettled(
    S.projects.map(async (p) => [p.id, await api.sessions.list(p.id)])
  );
  const tree = {};
  results.forEach((r, i) => {
    const p = S.projects[i];
    if (r.status === 'fulfilled') tree[r.value[0]] = r.value[1];
    else {
      tree[p.id] = [];
      console.log('[sessions] 读不到项目「' + p.name + '」的会话列表：' + ((r.reason && r.reason.message) || r.reason));
    }
  });
  S.tree = tree;
  S.sessions = S.tree[S.projectId] || [];
  renderTree(); // 标签标题取自 S.sessions，列表刷新后跟着更新
  renderTabs();
}

async function createSession(programId, name) {
  if (!S.projectId) {
    toast('先创建项目', 'err');
    return;
  }
  const r = await api.sessions.create({ projectId: S.projectId, programId, name: name || '新会话' });
  S.session = r.session;
  S.sessionId = r.session.id;
  applyLoaded(r);
  await refreshSessions();
  openTab(S.sessionId);
  $('input').focus();
  return r.session;
}

/**
 * 打开一个会话。
 * - projectId 可省略（按当前项目算）；与当前项目不一致时自动切过去，而不是
 *   拿当前项目的目录去找别的项目的会话。
 * - 会话真的不存在时不抛错：异常冒到 unhandledrejection 只会变成一句红字，
 *   这里改成「摘掉这个标签 + 接着开同项目的下一个」，界面不会卡在打不开的会话上。
 */
async function loadSession(sessionId, projectId) {
  const pid = projectId || S.projectId;
  if (!pid || !sessionId) return null;
  if (pid !== S.projectId) return setProject(pid, { sessionId });
  let r;
  try {
    r = await api.sessions.load({ projectId: pid, sessionId });
  } catch (e) {
    console.log('[sessions] 加载失败 ' + sessionId + '：' + ((e && e.message) || e));
    toast('会话打不开（可能已被删除）：' + String(sessionId).slice(0, 8), 'err');
    dropTab(pid, sessionId);
    await openNextInProject(pid);
    return null;
  }
  S.session = r.session;
  S.sessionId = sessionId;
  applyLoaded(r);
  renderSessions();
  renderFiles();
  openTab(sessionId);
  const map = { ...(ws().activeSessionPerProjectIdentifier || {}), [pid]: sessionId };
  saveLayout({ activeSessionPerProjectIdentifier: map });
  return r;
}

/** 把某个标签从标签栏摘掉（不动会话文件），并把 active 夹回合法下标 */
function dropTab(projectId, sessionId) {
  const pane = tabsPane();
  const i = pane.tabs.indexOf(tabIdFor(projectId, sessionId));
  if (i < 0) return false;
  pane.tabs.splice(i, 1);
  pane.tabInstanceIds.splice(i, 1);
  if (!pane.tabs.length) pane.active = 0;
  else if (i < pane.active) pane.active -= 1;
  else pane.active = Math.min(pane.active, pane.tabs.length - 1);
  persistTabs(pane);
  renderTabs();
  return true;
}

/** 没有可打开的会话时的空态 */
function showNoSession() {
  S.sessionId = null;
  S.session = null;
  S.meta = null;
  S.transcript = [];
  syncRunning(); // 没有会话就没有"正在跑"可言
  renderTop();
  renderTranscript();
  renderTabs();
  $('transcript').innerHTML = '<div class="empty">没有打开的会话。<br>点标签栏的 + 或在左侧选一个预设建立新会话。</div>';
}

/**
 * 接着开「这个项目」在标签栏里的下一个会话，没有就回到空态。
 * 注意 pane.tabs 是**所有项目共用**的一条数组，而标签栏只画当前项目的标签，
 * 所以绝不能拿 pane.tabs[pane.active] 当"下一个"——那个下标可能落在别的项目的标签上，
 * 把它的会话 id 拿到当前项目里加载就是「会话不存在：xxx」（实测踩到的那个报错）。
 */
async function openNextInProject(projectId) {
  const pane = tabsPane();
  const mine = pane.tabs.filter((t) => String(t).startsWith('session:' + projectId + ':'));
  if (!mine.length) return showNoSession();
  const tab = mine[0];
  pane.active = pane.tabs.indexOf(tab);
  persistTabs(pane);
  renderTabs();
  return loadSession(tabSessionId(tab), projectId);
}

function applyLoaded(r) {
  S.meta = r.meta;
  S.transcript = r.transcript || [];
  // 附件是**按会话**存在的（复制目标就是那个会话的工作目录），换会话必须清空，
  // 否则会把 A 会话的文件名发到 B 会话里去。缩略图缓存同理：键里虽带了会话，
  // 但换会话后旧的像素再也没有用处，留着只是占内存。
  S.atts = [];
  S.previewCache.clear();
  renderAtts();
  syncRunning(); // 换了会话：S.running 是按当前会话算的派生值，必须重算
  // 模型 chip 也是**按会话**的：「默认模型」专用会话显示的是兜底那份，普通会话显示生效设置那套。
  // 不跟着重画的话，切到专用会话后 chip 还在说上一个会话的模型名。
  renderModelSelect();
  renderTop();
  renderTranscript();
}

// ---------------- 会话标签栏（写进布局文件的 tabLayouts） ----------------
// 结构对齐 Bionic：{ type:'pane', id, tabs:[...], tabInstanceIds:[...], active, previewIndex }
// 标签 id 用 "session:<项目id>:<会话id>"，对应 Bionic 的 "bionicSession:v2:..."。
const TAB_LAYOUT_KEY = 'workspace.sessions';

function tabsPane() {
  LAYOUT.window = LAYOUT.window || {};
  if (!LAYOUT.window.tabLayouts || typeof LAYOUT.window.tabLayouts !== 'object') LAYOUT.window.tabLayouts = {};
  const all = LAYOUT.window.tabLayouts;
  if (!all[TAB_LAYOUT_KEY]) {
    all[TAB_LAYOUT_KEY] = { type: 'pane', id: 'root', instanceId: 'root', tabs: [], tabInstanceIds: [], active: 0, previewIndex: null };
  }
  const pane = all[TAB_LAYOUT_KEY];
  if (pane.instanceId === undefined) pane.instanceId = 'root'; // Bionic 的 pane 有这个字段，名字照抄
  if (!Array.isArray(pane.tabs)) pane.tabs = [];
  if (!Array.isArray(pane.tabInstanceIds)) pane.tabInstanceIds = [];
  return pane;
}

function tabIdFor(projectId, sessionId) {
  return 'session:' + projectId + ':' + sessionId;
}

function tabSessionId(tab) {
  const parts = String(tab).split(':');
  return parts.length >= 3 ? parts.slice(2).join(':') : String(tab);
}

function persistTabs(pane) {
  LAYOUT.window.tabLayouts = { ...(LAYOUT.window.tabLayouts || {}), [TAB_LAYOUT_KEY]: pane };
  api.ui.patch({ tabLayouts: LAYOUT.window.tabLayouts }).catch(() => {});
}

/** 把会话挂到标签栏并激活（重复打开不会多出一个标签） */
function openTab(sessionId) {
  if (!S.projectId || !sessionId) return;
  const pane = tabsPane();
  const id = tabIdFor(S.projectId, sessionId);
  let i = pane.tabs.indexOf(id);
  if (i < 0) {
    pane.tabs.push(id);
    pane.tabInstanceIds.push('tab-' + Math.random().toString(36).slice(2, 10));
    i = pane.tabs.length - 1;
  }
  pane.active = i;
  persistTabs(pane);
  renderTabs();
}

function closeTab(sessionId) {
  const pane = tabsPane();
  const id = tabIdFor(S.projectId, sessionId);
  const i = pane.tabs.indexOf(id);
  if (i < 0) return;
  const closingCurrent = sessionId === S.sessionId;
  dropTab(S.projectId, sessionId); // 摘标签 + 把 active 夹回来
  // 关的不是当前会话 → 只是重画标签栏；关的是当前会话 → 接着开同项目的下一个
  if (!closingCurrent) return renderTabs();
  openNextInProject(S.projectId);
}

function renderTabs() {
  const box = $('session-tabs');
  if (!box) return;
  box.innerHTML = '';
  if (!S.projectId) return;
  const pane = tabsPane();
  const prefix = 'session:' + S.projectId + ':';
  const current = S.sessionId ? tabIdFor(S.projectId, S.sessionId) : null;
  for (const tab of pane.tabs) {
    // 只画当前项目的标签；切到别的项目它的标签先留着，切回来还在
    if (!String(tab).startsWith(prefix)) continue;
    const sid = tabSessionId(tab);
    const meta = S.sessions.find((s) => s.id === sid);
    const el = document.createElement('div');
    el.className = 'stab' + (tab === current ? ' active' : '');
    el.title = meta ? meta.name : sid;
    if (S.running && tab === current) {
      const dot = document.createElement('span');
      dot.className = 'stab-dot';
      el.appendChild(dot);
    }
    const name = document.createElement('span');
    name.className = 'stab-name';
    name.textContent = meta ? meta.name : '(已删除)';
    el.appendChild(name);
    const x = document.createElement('button');
    x.className = 'stab-close';
    x.textContent = '×';
    x.title = '关闭标签';
    x.onclick = (e) => {
      e.stopPropagation();
      closeTab(sid);
    };
    el.appendChild(x);
    el.onclick = () => {
      // 点标签就把 active 同步到它的真实下标：active 是"所有项目共用数组"里的下标，
      // 不同步的话它会一直停在别的项目的标签上，关标签时按它找"下一个"就会跑偏。
      const at = pane.tabs.indexOf(tab);
      if (at >= 0 && pane.active !== at) {
        pane.active = at;
        persistTabs(pane);
      }
      if (sid !== S.sessionId) loadSession(sid, S.projectId);
    };
    box.appendChild(el);
  }
  hydrateIcons(box);
}

function renderSessions() { refreshSessions(); }

function fmtTok(n) {
  const v = Number(n) || 0;
  // 整万不留 ".0"（1000000 写成 "100万" 比 "100.0万" 省一截，这一行要塞的东西不少）
  return v >= 10000 ? (v / 10000).toFixed(1).replace(/\.0$/, '') + '万' : String(v);
}

function renderTop() {
  const m = S.meta;
  const pills = $('session-pills');
  pills.innerHTML = '';
  if (m) {
    const add = (text, cls, tip) => {
      const s = document.createElement('span');
      s.className = 'pill ' + (cls || '');
      s.textContent = text;
      if (tip) s.title = tip;          // 悬停能看清这枚标签到底是什么（读屏也读得到）
      pills.appendChild(s);
    };
    const prog = S.programs.find((p) => p.id === m.programId);
    // 程序预设这枚标签必须**跟着实际模块走**：在「设置 → 会话 → 能力模块」里关掉一个模块后，
    // 会话的 programId 仍是 omni，但模块集已经和预设不一样了——以前这里只认 programId，
    // 于是标签永远显示 "Omni"，用户会觉得"改了设置它不更新"。
    const presetIds = prog && Array.isArray(prog.modules) ? prog.modules : null;
    const curIds = Array.isArray(m.modules) ? m.modules : null;
    let sameAsPreset = true;
    let progTip = prog ? `程序预设 ${prog.label}：${prog.description}` : '程序预设（未找到该 id）';
    let progLabel = prog ? prog.label : m.programId;
    if (presetIds && curIds) {
      const a = new Set(presetIds), b = new Set(curIds);
      sameAsPreset = a.size === b.size && [...a].every((x) => b.has(x));
      if (!sameAsPreset) {
        const labelOf = (id) => {
          const mod = (S.modules || []).find((x) => x.id === id);
          return mod ? mod.label : id;
        };
        const off = presetIds.filter((x) => !b.has(x)).map(labelOf);
        const extra = curIds.filter((x) => !a.has(x)).map(labelOf);
        progLabel = '自定义';
        progTip =
          `程序预设 ${prog.label} 已调整：当前开着 ${curIds.length}/${presetIds.length} 个模块` +
          (off.length ? `\n已关：${off.join('、')}` : '') +
          (extra.length ? `\n多开：${extra.join('、')}` : '') +
          '\n（在「设置 → 会话 → 能力模块」里改）';
      }
    }
    add(progLabel, 'lilac', progTip);
    // 「默认模型」专用会话：模型不是来自「常规」那套，而是兜底那份。
    // 这枚标签让"模型 chip 为什么显示这个"有出处 —— 否则用户会以为设置被改了。
    if (sessionUsesFallback()) {
      add(DEFAULT_SESSION_LABEL, 'sky',
        '本会话固定走程序自带的那份语言模型：' + (fallbackModelName() || '未配置') +
        '\n（地址/钥匙/模型名/思考强度都在「设置 → 兜底模型 → 语言模型」里改）');
    }
    add(m.readOnly ? '只读' : '可写', m.readOnly ? 'warn' : 'mint',
      m.readOnly ? '本会话只读：可以读文件，不允许改动' : '本会话可写：允许改文件、执行命令');
    if (m.compaction) add('已压缩', 'sky', '本会话的上下文被压缩过：旧事件已折叠成摘要');
  }

  // 输入框下面一行：左边是会话标签，右边上下文用量。
  // （当前项目名原先也在这里，但跟左栏项目树重复，已撤掉——把宽度让给用量明细。）
  // 用量明细（容量 / 占比 / 上次输入输出 / 本轮次数与合计）**直接铺在这一行上**，
  // 不再只藏在 title 的原生 tooltip 里（那个要悬停才看得到，等于没显示）。
  const u = m && m.usage;
  const limit = contextLimitOf();
  const hint = $('usage-hint');
  // 段间分隔点（几段数字挤在一起会读不出来哪段是哪段）
  const seg = () => '<span class="s">·</span>';
  if (!m) {
    hint.innerHTML = '';
    hint.removeAttribute('title');
    hint.classList.remove('over');
  } else if (u && u.calls) {
    const ctx = u.lastPromptTokens != null ? u.lastPromptTokens : u.promptTokens || 0;
    const down = u.lastCompletionTokens != null ? u.lastCompletionTokens : u.completionTokens || 0;
    const pct = Math.min(999, Math.round((ctx / limit) * 100));
    // 文案是**量出来的**：这一行剩下的宽度只有 392px（窗口 1118、左边只剩会话标签时），
    // 全称写法（"最近一次调用：输入 … / 输出 …"）要 457px，必折行。
    // 所以横排用最短写法，完整说明挂在每段的 title 上（悬停能看，不悬停也能看）。
    hint.innerHTML =
      `<span class="g" title="上下文占用：最近一次调用的输入 ${ctx} tokens，设定容量 ${limit} tokens（可在「设置 → 常规」里改）">` +
      `上下文 <b>${fmtTok(ctx)}</b>/${fmtTok(limit)} <span class="pc">(${pct}%)</span></span>` +
      seg() +
      `<span class="g" title="最近一次调用：输入 ${ctx} tokens → 输出 ${down} tokens">上次 ${ctx}→${down}</span>` +
      seg() +
      `<span class="g" title="本轮累计调用 ${u.calls} 次，共 ${u.totalTokens} tokens">本轮 <b>${u.calls}</b> 次 共 ${fmtTok(u.totalTokens)}</span>`;
    hint.classList.toggle('over', pct >= 80);
  } else if (u) {
    hint.innerHTML = `<span class="g">上下文 — <span class="pc">(模型没有回传用量)</span></span>`;
    hint.classList.remove('over');
  } else {
    const estUp = Math.round(((m && m.chars) || 0) / 4);
    hint.innerHTML = `<span class="g">上下文 ≈<b>${fmtTok(estUp)}</b> <span class="pc">(按字符数估算，模型未回传用量)</span></span>`;
    hint.classList.remove('over');
  }

  $('btn-stop').classList.toggle('hidden', !S.running);
  $('btn-send').disabled = S.running || !S.sessionId;
  renderApprovalOptions();
  renderTabs();
}

// ---------------- 图片缩略图 ----------------
// 用户拖进来的图，气泡上要看得见。transcript 里只带相对路径，像素要向主进程要
// （files:preview，主进程会再校验一次"必须在工作目录内"）。
// 缓存是必要的：每轮 session:update 都会整份重绘转录，不缓存就是每次重绘都把
// 几张图重新搬一遍 IPC。
function imgThumb(im) {
  const rel = im.rel;
  const pid = S.projectId;
  const sid = S.sessionId;
  const key = pid + '/' + sid + '/' + rel;
  const box = document.createElement('div');
  box.className = 'img-thumb';
  box.title = rel;

  const paint = (r) => {
    if (r && r.ok) {
      const img = document.createElement('img');
      img.src = r.dataUrl;
      img.alt = rel;
      box.appendChild(img);
      box.classList.add('ready');
      box.title = rel + '（' + (r.width && r.height ? r.width + '×' + r.height + ' · ' : '') + '点击用系统程序打开）';
      box.onclick = () => api.shell.openPath(r.abs);
    } else {
      // 图被删/改名/越界：留一个能看懂的占位，不要把整个气泡弄没
      box.classList.add('gone');
      box.textContent = '图片打不开';
      box.title = rel + '：' + ((r && r.error) || '读取失败');
    }
  };

  const hit = S.previewCache.get(key);
  if (hit) { paint(hit); return box; }

  box.classList.add('loading');
  box.textContent = String(rel).split('/').pop();
  api.files.preview({ projectId: pid, sessionId: sid, rel })
    .then((r) => {
      const res = r || { ok: false, error: '主进程没有返回' };
      S.previewCache.set(key, res);
      box.classList.remove('loading');
      box.textContent = '';
      paint(res);
    })
    .catch((e) => {
      box.classList.remove('loading');
      box.classList.add('gone');
      box.textContent = '图片打不开';
      box.title = rel + '：' + ((e && e.message) || e);
    });
  return box;
}

// ---------------- 转录渲染 ----------------
function renderTranscript() {
  const box = $('transcript');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  box.innerHTML = '';
  if (!S.transcript.length) {
    box.innerHTML = '<div class="empty">还没有消息。说点什么吧。</div>';
  }
  const toolResults = new Map();
  for (const row of S.transcript) if (row.kind === 'tool') toolResults.set(row.callId, row);

  for (const row of S.transcript) {
    if (row.kind === 'user') {
      if (row.hidden) continue;
      const d = document.createElement('div');
      d.className = 'row user';
      // 缩略图放在文字上方，点击用系统程序打开原图。
      // 只在这里放一个空壳，像素是异步去主进程要的（transcript 里只有相对路径）。
      for (const im of row.images || []) d.appendChild(imgThumb(im));
      // 用 insertAdjacentHTML 而不是 `d.innerHTML +=` —— 后者会把已经 append 进去的
      // 缩略图节点序列化再重新解析一遍，等于把刚建好的元素换成了新对象，
      // 于是"异步取回像素之后填进那个元素"这句话就落到了已经被丢弃的节点上（画面永远空着）。
      if (row.text) d.insertAdjacentHTML('beforeend', `<div class="bubble md">${mdToHtml(row.text)}</div>`);
      const bar = document.createElement('div');
      bar.className = 'msg-actions keep';
      bar.appendChild(iconBtn('undo', '回滚到这条消息之前', () => rollbackTo(row.id)));
      bar.appendChild(iconBtn('copy', '复制', () => copyText(row.text)));
      bar.appendChild(iconBtn('branch', '从这里分叉', () => forkAt(row.id)));
      d.appendChild(bar);
      box.appendChild(d);
    } else if (row.kind === 'assistant') {
      const d = document.createElement('div');
      d.className = 'row assistant';
      let html = `<div class="meta"><span>助手</span><span>${timeStr(row.ts)}</span></div>`;
      if (row.reasoning) {
        html += `<details class="reasoning-box"><summary>思考过程（${row.reasoning.length} 字符）</summary><div class="reasoning">${esc(row.reasoning)}</div></details>`;
      }
      if (row.text) html += `<div class="bubble md">${mdToHtml(row.text)}</div>`;
      d.innerHTML = html;
      const bar = document.createElement('div');
      bar.className = 'msg-actions';
      bar.appendChild(iconBtn('copy', '复制', () => copyText(row.text)));
      bar.appendChild(iconBtn('branch', '从这条回复分叉', () => forkAt(row.id)));
      d.appendChild(bar);
      box.appendChild(d);
      for (const call of row.toolCalls || []) box.appendChild(toolCard(call, toolResults.get(call.callId)));
    } else if (row.kind === 'summary') {
      box.appendChild(summaryRow(row));
    } else if (row.kind === 'elicitation') {
      box.appendChild(elicitationRow(row));
    } else if (row.kind === 'error') {
      const d = document.createElement('div');
      d.className = 'row error-row';
      d.textContent = (row.critical ? '错误：' : '提示：') + row.message;
      box.appendChild(d);
    } else if (row.kind === 'interrupted') {
      const d = document.createElement('div');
      d.className = 'row fork-row';
      d.textContent = '本轮被中断';
      box.appendChild(d);
    } else if (row.kind === 'compaction') {
      const d = document.createElement('div');
      d.className = 'row summary';
      d.innerHTML = `<span class="pill sky">上下文已压缩</span><span>${esc((row.summary || '').slice(0, 160))}…</span>`;
      box.appendChild(d);
    } else if (row.kind === 'forkPoint') {
      const d = document.createElement('div');
      d.className = 'row fork-row';
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = '从这里分叉出分支';
      btn.onclick = () => forkAt(row.id);
      d.appendChild(document.createTextNode('分叉点 ' + timeStr(row.ts)));
      d.appendChild(btn);
      box.appendChild(d);
    }
  }

  if (S.live) {
    const n = liveNode();
    n.classList.add('live');
    box.appendChild(n);
  }
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

/**
 * 工具卡上的文件小标签：把这次调用涉及的文件名做成可点的 chip，点了就切到文本视图（带行号）。
 * 参数里带路径的键名按 fs 工具的约定来：relativePath（相对工作目录）/ path / absPath。
 * 相对路径要拼上会话的 workingDir —— 直接拿 'notes/hello.md' 去读会读不到。
 */
function fileChip(toolName, argsObj) {
  if (!argsObj || typeof argsObj !== 'object') return '';
  const raw = argsObj.relativePath || argsObj.path || argsObj.absPath;
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const wd = (S.meta && S.meta.workingDir) || '';
  const abs = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(raw)
    ? raw
    : (wd ? wd.replace(/[\\/]+$/, '') + '\\' + raw.replace(/^[\\/]+/, '') : raw);
  return `<button class="file-chip" data-abs="${esc(abs)}" title="查看 ${esc(abs)}（带行号）">` +
    `<span class="ic" data-ic="file"></span>${esc(raw.split(/[\\/]/).pop())}</button>`;
}

function toolCard(call, result) {
  const wrap = document.createElement('div');
  const status = !result ? (S.running ? 'run' : 'wait') : result.isError ? 'err' : 'ok';
  // 被拦下来/要人确认的卡片默认展开，别让用户还得自己去点开看原因
  const gated = !!(result && result.decision && result.decision.action !== 'allow');
  wrap.className = 'tool' + (status === 'run' || gated ? ' open' : '');
  let args = call.argsText || '{}';
  let argsObj = null;
  try {
    argsObj = JSON.parse(args);
    args = JSON.stringify(argsObj, null, 2);
  } catch {}
  const head = document.createElement('div');
  head.className = 'tool-head';
  const dur = result && result.durationMs != null ? ` · ${result.durationMs} ms` : '';
  head.innerHTML =
    `<span class="dot ${status}"></span><span class="tool-name">${esc(call.name)}</span>` +
    // 会话里直接给出"这个调用动了哪个文件"，点它就切到带行号的文本视图 ——
    // 不用先去右栏「文件」里翻。path 参数（相对/绝对都认）来自参数 JSON。
    fileChip(call.name, argsObj) +
    `<span class="spacer"></span><span class="time">${status === 'run' ? '执行中…' : timeStr(call.ts || (result && result.ts) || Date.now()) + dur}</span>`;
  const body = document.createElement('div');
  body.className = 'tool-body';
  body.innerHTML =
    `<div class="label">参数</div><div class="tool-args">${esc(args)}</div>` +
    (result ? `<div class="label">结果${result.isError ? '（失败）' : ''}</div><pre class="out">${esc(result.text || '')}</pre>` : `<div class="label">等待结果…</div>`);
  // 闸门决定：谁放行的、评审三轴怎么判的（持久化在会话里，刷新后还在）。
  // 只在「拦下来了」或「过了评审」时才显示——普通只读调用每条都挂个"放行"太吵。
  const dec = result && result.decision;
  if (dec && (dec.action !== 'allow' || dec.reviewer)) {
    const r = dec.reviewer;
    const tag =
      dec.action === 'deny' ? ['danger', '已拒绝'] :
      dec.action === 'ask' ? ['warn', dec.reviewerFailed ? '评审失效→转人工' : '人工确认'] :
      ['', '放行'];
    const bits = [];
    if (r && r.ok) {
      bits.push(`评审 risk=${r.risk} auth=${r.authorization} correct=${r.correct}`);
      if (r.steps > 1) bits.push(`${r.steps} 步`);
    } else if (r && !r.ok) {
      bits.push('评审输出无法解析');
    }
    body.innerHTML +=
      `<div class="decision">` +
      `<span class="pill ${tag[0]}">${esc(tag[1])}</span>` +
      `<span class="dtag">${esc(dec.reason || '')}</span>` +
      (bits.length ? `<span class="dtag dim">${esc(bits.join(' · '))}</span>` : '') +
      `</div>`;
  }
  wrap.appendChild(head);
  wrap.appendChild(body);
  // 产出图片的工具（生图）把图直接贴在卡片里 —— 用的是和用户附件同一个缩略图。
  // 必须放在**所有 innerHTML 赋值之后**：`innerHTML +=` 会把已经 append 进去的节点
  // 序列化再重新解析一遍，先 append 的缩略图会被换成新对象（就是那个"异步填像素填到了
  // 被丢弃的节点上"的老坑）。这里图是给人看的：模型侧仍然只能读到结果里的文本。
  if (result && Array.isArray(result.images) && result.images.length) {
    const pics = document.createElement('div');
    pics.className = 'tool-imgs';
    for (const im of result.images) pics.appendChild(imgThumb(im));
    body.appendChild(pics);
  }
  head.onclick = () => wrap.classList.toggle('open');
  const row = document.createElement('div');
  row.className = 'row';
  row.appendChild(wrap);
  return row;
}

function summaryRow(row) {
  const d = document.createElement('div');
  d.className = 'row summary';
  const secs = (row.durationMs / 1000).toFixed(1);
  d.innerHTML = `<span class="pill mint">本轮完成</span><span>${secs} 秒</span>` + (row.files || [])
    .map((f) => `<span class="filerow">${esc(f.path)}<span class="add">+${f.added}</span><span class="del">-${f.removed}</span></span>`)
    .join('');
  return d;
}

function elicitationRow(row) {
  const d = document.createElement('div');
  d.className = 'row elicitation';
  const r = row.request || {};
  const ok = row.response === 'approved';
  const cmd = r.args && r.args.command ? r.args.command : (r.tool || '');
  let extra = '';
  if (row.reviewer) {
    const v = row.reviewer;
    extra = `<div style="margin-top:6px;color:var(--text-2)">评审：risk=${esc(v.risk || '-')} · 授权=${esc(v.authorization || '-')} · 正确=${v.correct === false ? '否' : '是'}${v.risk_reason ? ' · ' + esc(v.risk_reason) : ''}${v.incorrect_reason ? ' · ' + esc(v.incorrect_reason) : ''}</div>`;
  }
  d.innerHTML =
    `<div><span class="pill ${ok ? 'mint' : 'danger'}">${ok ? '已批准' : '已拒绝'}</span> <span class="mono">${esc(cmd).slice(0, 300)}</span></div>` +
    (row.reason ? `<div style="margin-top:4px;color:var(--text-3)">${esc(row.reason)}</div>` : '') + extra;
  return d;
}

function liveNode() {
  // 流式生成结束时会先把 S.live 置空，而 requestAnimationFrame 的回调可能下一帧才跑，
  // 于是这里读到 null.reasoning 直接抛错（界面上就弹一条「界面错误」的红字）。必须兜住。
  const live = S.live || { text: '', reasoning: '', tools: {} };
  const d = document.createElement('div');
  d.className = 'row assistant';
  let html = `<div class="meta"><span>助手</span><span class="pill warn">生成中</span></div>`;
  if (live.reasoning) html += `<details class="reasoning-box" open><summary>思考中…</summary><div class="reasoning">${esc(live.reasoning.slice(-4000))}</div></details>`;
  if (live.text) html += `<div class="bubble md">${mdToHtml(live.text)}</div>`;
  const names = Object.values(live.tools || {}).map((t) => t.name).filter(Boolean);
  if (names.length && !live.text) html += `<div class="meta"><span class="pill sky">调用工具 ${esc(names.join(', '))}</span></div>`;
  d.innerHTML = html;
  return d;
}

// ---------------- 事件 ----------------
/** 运行状态以 S.runningIds 为准，S.running 是按当前会话算出来的派生值 */
function syncRunning() {
  const was = S.running;
  S.running = S.runningIds.has(S.sessionId);
  if (was !== S.running) renderTop();
}

function handleAgentEvent(ev) {
  // 运行状态必须**先于**"按会话过滤"处理：事件是按会话过滤的（切走之后
  // 别的会话的事件会被丢掉），但运行状态是全局的记账，不能跟着一起丢，
  // 否则切走再切回那个会话，就永远复不了位（发送按钮永久禁用）。
  if (ev.sessionId && (ev.type === 'turn:start' || ev.type === 'turn:end')) {
    if (ev.type === 'turn:start') S.runningIds.add(ev.sessionId);
    else S.runningIds.delete(ev.sessionId);
    syncRunning();
  }
  if (ev.sessionId && ev.sessionId !== S.sessionId) return;
  switch (ev.type) {
    case 'turn:start':
      S.live = { text: '', reasoning: '', tools: {} };
      renderTop();
      renderTranscript();
      break;
    case 'assistant:start':
      S.live = S.live || { text: '', reasoning: '', tools: {} };
      break;
    case 'assistant:delta':
      if (!S.live) S.live = { text: '', reasoning: '', tools: {} };
      if (ev.kind === 'text') S.live.text += ev.delta;
      else S.live.reasoning += ev.delta;
      scheduleLive();
      break;
    case 'tool:announce':
      if (!S.live) S.live = { text: '', reasoning: '', tools: {} };
      S.live.tools[Object.keys(S.live.tools).length] = { name: ev.name };
      scheduleLive();
      break;
    case 'assistant:end':
      S.live = null;
      break;
    case 'tool:start':
      // 不再每次弹提示——工具卡自己会显示「执行中…」，一屏弹七八条太吵。
      // 只有真正需要人决策的（always-ask）才提示，那种情况走审批卡片。
      break;
    case 'tool:end':
      if (ev.isError) toast(`${ev.name} 失败：${String(ev.text || '').slice(0, 160)}`, 'err');
      break;
    case 'approval:decision':
      if (ev.action === 'deny') toast(`已拦截 ${ev.tool}：${ev.reason}`, 'err');
      break;
    case 'compaction':
      toast(`上下文已压缩（丢弃 ${ev.dropped} 条旧事件）`, 'ok');
      break;
    case 'session:update':
      S.transcript = ev.transcript || [];
      S.meta = ev.meta || S.meta;
      renderTop();
      renderTranscript();
      refreshSessions();
      refreshFiles();
      break;
    case 'turn:end':
      // 运行状态已在函数开头按会话销账了，这里只管清掉这一轮的临时态
      S.live = null;
      renderTop();
      renderTranscript();
      break;
    case 'log':
      toast(ev.message, 'err');
      break;
    default:
      break;
  }
}

let liveRaf = null;
function scheduleLive() {
  if (liveRaf) return;
  liveRaf = requestAnimationFrame(() => {
    liveRaf = null;
    if (!S.live) return; // 这一帧还没跑，生成就已经结束了
    const box = $('transcript');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 200;
    const old = box.querySelector('.row.live');
    if (old) old.remove();
    const node = liveNode();
    node.classList.add('live');
    box.appendChild(node);
    if (nearBottom) box.scrollTop = box.scrollHeight;
  });
}

// ---------------- 拖进来的附件（本地复制，不是上传） ----------------
// 机制：drop 事件给的 File **问不出本地地址**（Electron 32 起 File.path 已被移除），
// 只能经 preload 的 webUtils.getPathForFile 拿；拿到后由主进程复制一份进这个会话的
// 工作目录 —— 因为工具只认工作目录内的路径，外面的一律"路径越界"。
// 复制后的相对路径跟着消息一起发出去（main.js 拼成 [附件] xxx 行），模型据此调工具。
function renderAtts() {
  const box = $('composer-atts');
  if (!box) return;
  box.classList.toggle('hidden', S.atts.length === 0);
  box.innerHTML = S.atts.map((a) => {
    const img = a.image;
    // 图片多给两种状态：读不出来（格式/体积不合格）与"偏大"（长边超 1568，白花 token）
    const imgWarn = !!(img && img.ok && img.oversize);
    const imgBad = !!(img && !img.ok);
    const cls = 'att-chip'
      + (a.state === 'busy' ? ' busy' : a.state === 'bad' || imgBad ? ' bad' : imgWarn ? ' warn' : '');
    const meta = a.state === 'busy' ? '复制中…'
      : a.state === 'bad' ? (a.note || '没能复制')
        : imgBad ? (img.error || '图片有问题')
          : img && img.ok && img.width ? (img.width + '×' + img.height + (img.oversize ? ' · 偏大' : ''))
            : a.copied ? '已复制入项目' : '已在工作目录';
    const tip = a.state === 'bad' ? (a.note || '')
      : imgBad ? (img.error || '')
        : img && img.ok
          ? (a.from || '') + '　·　约 ' + img.tokens + ' token/次（每轮都会重发）'
          : (a.from || '');
    return `<span class="${cls}" title="${esc(tip)}">` +
      `<span class="ic" data-ic="${fileIconFor(a.name)}"></span>` +
      `<span class="nm">${esc(a.name)}</span>` +
      `<span class="meta">${esc(meta)}</span>` +
      `<button class="x" data-ic="x" data-att-drop="${esc(a.key)}" title="移除"></button>` +
      `</span>`;
  }).join('');
  hydrateIcons(box);
}

function removeAtt(key) {
  S.atts = S.atts.filter((a) => a.key !== key);
  renderAtts();
}

async function attachFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  if (!S.sessionId || !S.projectId) { toast('先打开一个会话，再往输入框里拖文件', 'err'); return; }
  // 先全部按"复制中"占位：拖完立刻有条，不用等磁盘
  const jobs = files.map((f) => {
    const it = { key: 'att-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: f.name, state: 'busy' };
    S.atts.push(it);
    return { it, f };
  });
  renderAtts();

  // 串行复制：并发拷几个大文件会把磁盘打满，小条的出现顺序也会和拖入顺序对不上
  for (const { it, f } of jobs) {
    let abs = '';
    try { abs = api.files.pathFor(f) || ''; } catch { abs = ''; }
    if (!abs) {
      it.state = 'bad';
      it.note = '问不到本地地址';
      it.from = '网页里直接拖出来的文件没有本地地址，先存到磁盘再拖进来。';
      renderAtts();
      continue;
    }
    it.from = abs;
    let r;
    try {
      r = await api.files.attach({ projectId: S.projectId, sessionId: S.sessionId, absPath: abs });
    } catch (e) {
      r = { ok: false, error: e.message };
    }
    if (r && r.ok) {
      it.state = 'ok';
      it.rel = r.rel;
      it.name = r.name;
      it.copied = r.copied;
      it.bytes = r.bytes;
      // 图片额外带回来宽高（主进程量的）。小条上显示出来，
      // 用户才知道自己拖的是一张多大的图 —— 它每轮都会随历史重发。
      it.image = r.image || null;
    } else {
      it.state = 'bad';
      it.note = (r && r.error) || '复制失败';
      it.from = it.note + '（源文件：' + abs + '）';
    }
    renderAtts();
  }
}

/** 拖拽：整个窗口都接住，但只有落在输入框里才算附件。
 *  必须 preventDefault —— 不然 Chromium 会执行默认动作：把窗口导航到那个文件，
 *  文本类文件会直接把整个界面顶掉（没有返回入口，只能重启）。 */
function bindDrops() {
  const box = document.querySelector('.composer-box');
  const clear = () => { if (box) box.classList.remove('drop-hot'); };
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (box && (e.target === box || box.contains(e.target))) box.classList.add('drop-hot');
  });
  window.addEventListener('dragleave', (e) => {
    if (box && !box.contains(e.relatedTarget)) clear();
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); // 先拦默认动作，再谈别的
    clear();
    const files = e.dataTransfer && e.dataTransfer.files;
    const inside = !!box && (e.target === box || box.contains(e.target));
    if (!inside) {
      if (files && files.length) toast('把文件拖进输入框里', '');
      return;
    }
    if (files && files.length) attachFiles(files);
  });
}

// ---------------- 发送 / 停止 ----------------
async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!S.sessionId || S.running) return;
  // 只有复制成功的附件才跟着走：坏掉的（问不到地址 / 没权限）不进消息，界面上留着红条
  const atts = S.atts.filter((a) => a.state === 'ok').map((a) => a.rel);
  // 一个字没打但拖了图，也应该能发出去 —— 否则用户拖完图点发送毫无反应，
  // 只会以为功能坏了（拖入附件本来就是"以图为主"的用法）。
  if (!text && !atts.length) return;
  input.value = '';
  // 回声里先带上图片：缩略图在等模型回复的这段时间就能显示出来。
  // 主进程返回后会用**真正发出去的那份**覆盖 text（[附件] 行只允许有一处拼接规则）。
  const echo = { kind: 'user', id: 'pending-' + Date.now(), ts: Date.now(), text, images: atts.map((rel) => ({ rel })) };
  S.transcript.push(echo);
  renderTranscript();
  S.atts = [];
  renderAtts();
  S.runningIds.add(S.sessionId);
  syncRunning();
  try {
    const r = await api.chat.send({ projectId: S.projectId, sessionId: S.sessionId, text, attachments: atts });
    // 用主进程真正发出去的那份 body 覆盖本地回声（[附件] xxx 那几行只允许有一处拼接规则）
    if (r && typeof r.body === 'string') {
      echo.text = r.body;
      if (Array.isArray(r.images)) echo.images = r.images.map((rel) => ({ rel }));
      renderTranscript();
    }
  } catch (e) {
    S.runningIds.delete(S.sessionId);
    syncRunning();
    toast('发送失败：' + e.message, 'err');
  }
}

async function stop() {
  const stopped = await api.chat.stop({ sessionId: S.sessionId });
  // 内核说这个会话根本没在跑 → 界面记的账已经过期了，就地销掉。
  // 这是最后一道自愈：任何没被 turn:end 覆盖到的路径，用户点一下停止就能复位。
  if (!stopped) {
    S.runningIds.delete(S.sessionId);
    syncRunning();
  }
  toast(stopped ? '已请求停止' : '这个会话没有正在运行的一轮');
}

async function forkAt(entryId) {
  const r = await api.sessions.fork({ projectId: S.projectId, sessionId: S.sessionId, entryId });
  S.session = r.session;
  S.sessionId = r.session.id;
  applyLoaded(r);
  await refreshSessions();
  toast('已分叉出新会话', 'ok');
}

async function rollbackTo(entryId) {
  if (!entryId) return;
  const r = await api.checkpoints.rollback({ projectId: S.projectId, sessionId: S.sessionId, entryId });
  toast(r.message || '已回滚', r.ok ? 'ok' : 'err');
  await refreshFiles();
}

// ---------------- 审批弹窗 ----------------
function showApproval(req) {
  S.pendingApproval = req;
  $('approval-title').textContent = `需要确认：${req.tool}`;
  $('approval-sub').textContent = req.reason || '';
  const cmd = req.args && req.args.command ? req.args.command : JSON.stringify(req.args || {}, null, 2);
  $('approval-cmd').textContent = cmd;
  const v = req.reviewer;
  const box = $('approval-verdict');
  const riskCls = (r) => (r === 'high' || r === 'too_destructive' ? 'danger' : r === 'medium' ? 'warn' : 'mint');
  // 不管有没有送评审，风险等级都要先摆出来 —— 它是本地正则分级算出来的，
  // 人来拍板时至少要看到这一条，否则卡片上只剩一个光秃秃的"要不要跑"。
  const riskPill = `<span class="pill ${riskCls(req.risk)}">风险 ${esc(req.risk || '-')}</span>`;
  if (v) {
    // 上面那行副标题已经把 risk_reason 说过了就别重复
    const why = v.risk_reason && v.risk_reason !== req.reason ? v.risk_reason : '';
    box.innerHTML =
      `<div><span class="pill ${riskCls(v.risk)}">风险 ${esc(v.risk || '-')}</span> ` +
      `<span class="pill">授权 ${esc(v.authorization || '-')}</span> ` +
      `<span class="pill ${v.correct === false ? 'danger' : 'mint'}">语法 ${v.correct === false ? '有误' : '正常'}</span>` +
      (v.steps > 1 ? ` <span class="pill">取证 ${v.steps} 步</span>` : '') +
      `</div>` +
      (why ? `<div class="empty-note">${esc(why)}</div>` : '') +
      (v.incorrect_reason ? `<div class="empty-note" style="color:var(--danger)">${esc(v.incorrect_reason)}</div>` : '') +
      (!v.ok ? `<div class="empty-note">（评审未正常返回，已按失败安全处理）</div>` : '');
  } else if (req.risk === 'low') {
    // 「每次询问」模式下低风险调用不会去问评审（省一次模型调用），别写成「未启用」
    box.innerHTML = `<div>${riskPill}</div><div class="empty-note">低风险调用，没有送评审子会话。因为你的审批模式是「每次询问」，所以仍然需要你确认一下。</div>`;
  } else {
    box.innerHTML = `<div>${riskPill}</div><div class="empty-note">未启用评审子会话，请自行判断。</div>`;
  }
  $('approval-note').value = '';
  $('approval-modal').classList.remove('hidden');
}

async function answerApproval(approved, always) {
  const req = S.pendingApproval;
  if (!req) return;
  const note = $('approval-note').value.trim();
  $('approval-modal').classList.add('hidden');
  S.pendingApproval = null;
  if (always && approved) {
    await api.sessions.update({ projectId: S.projectId, sessionId: S.sessionId, patch: { approvalMode: 'auto' } });
    toast('本会话已切换为自动放行', 'ok');
  }
  await api.approvals.answer({ requestId: req.requestId, approved, note, always });
  // 这里**不要**再补一句 S.running = true：点审批按钮时本来就处于运行中，
  // 补它的唯一效果是"把一个可能已经被 turn:end 复位成 false 的状态又推回 true"，
  // 而推回去之后就没有人负责复位它了 → 界面永久停在"运行中"（停止按钮常亮、发送键禁用）。
  // 运行状态统一由 runningIds + syncRunning() 记账，不要在别处单独改。
  renderTop();
}

// ---------------- 右栏 ----------------
function switchPanel(name, opts) {
  // 设置已经不是右栏的一页了（照 Bionic：入口在左下角，点开是模态框）。
  // 老调用点和老的落盘值（devRightPanelView='settings'）都从这里兜回模态框。
  if (name === 'settings') { openSettings(); return; }
  S.panel = name;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.tab === name);
  for (const p of $('panel-files').parentElement.children) {
    if (p.classList.contains('panel')) p.classList.toggle('hidden', p.id !== 'panel-' + name);
  }
  if (name === 'files') refreshFiles();
  if (name === 'skills') refreshSkills();
  // ★ 切到浏览器时**不要**在这里建 webview：ensureBrowser 需要一个初始地址当 src，
  //   在这里无参调用会建出一个"没有 src 的 webview"，而它永远不会 dom-ready，
  //   之后 openInBrowser 再想 loadURL 就会一直报「must be attached to the DOM…」。
  //   建视图这件事只由 openInBrowser 负责（它手里才有地址）。
  if (name === 'browser') focusUrlIfNeeded();
  // 记住右栏停在哪一页（对应 Bionic 的 bionic.devRightPanelView）
  if (!opts || opts.persist !== false) saveLayout({ devRightPanelView: name });
}

// ---------------- 内置浏览器（照 Bionic 的右栏） ----------------
// 为什么用 <webview> 而不是 <iframe>：目标页面几乎都会带 X-Frame-Options / frame-ancestors，
// iframe 里根本打不开；<webview> 是独立的 guest 进程，等同一个小浏览器，不受同源策略限制。
// 安全上：guest 不给 preload、关掉 node 集成，且**只允许 http/https/file**（见 main.js 的
// will-attach-webview 守卫），所以它拿不到本应用的能力。
let bwView = null;
let bwHistory = [];      // 只用来判断"能不能后退/前进"的简易栈
let bwAt = -1;

/** 把用户输入变成可加载的 URL：网址直接用；本地路径补 file://；其余当搜索词喂给默认搜索页 */
function toUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|mailto):/i.test(s)) return s;
  // Windows 盘符路径 / UNC / 以斜杠开头 → 本地文件
  if (/^[a-zA-Z]:[\\/]/.test(s) || /^\\\\/.test(s) || s.startsWith('/')) {
    let p = s.replace(/\\/g, '/');
    // UNC（\\server\share → //server/share）要先补足两个斜杠再 encodeURI，
    // 否则拼出 file:////server/... 多一个斜杠，Chromium 会当成非法路径。
    if (p.startsWith('//')) p = '//' + p.replace(/^\/+/, '');
    else if (!p.startsWith('/')) p = '/' + p;
    return 'file://' + encodeURI(p);
  }
  if (/^localhost(:\d+)?(\/|$)/i.test(s) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(s)) return 'http://' + s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(s)) return 'http://' + s;
  return 'https://www.bing.com/search?q=' + encodeURIComponent(s);
}

/**
 * 创建 <webview>。
 * ★ 两件事的顺序是踩出来的，别改：
 *   ① `document.createElement('webview')` 得到的还是个**未升级**的元素，
 *      此时设 `src` 会被丢掉（实测：先设 src 再 append，事后读回来是 null）。
 *      必须**先 append 到文档**（触发自定义元素升级），再设 src —— guest 进程才会启动。
 *   ② webview 是"懒惰"的：没有 src 就不会建 guest，`dom-ready` 便永不触发；
 *      而 `loadURL()` 又规定只能在 dom-ready 之后调 —— 两者互等，谁都动不了。
 *      所以首屏一律靠 `src` 引导。
 */
function ensureBrowser(initialUrl) {
  if (bwView) return bwView;
  const stage = $('bw-stage');
  if (!stage) return null;
  bwView = document.createElement('webview');
  // guest 的 webPreferences 在 main.js 的 will-attach-webview 里强制收紧（不给 preload、无 node）
  bwView.setAttribute('partition', 'persist:one-harness-browser');
  bwView.addEventListener('did-start-loading', () => $('bw-reload').classList.add('spin'));
  bwView.addEventListener('did-stop-loading', () => $('bw-reload').classList.remove('spin'));
  bwView.addEventListener('dom-ready', () => {
    bwReady = true;
    if (bwPending) { const u = bwPending; bwPending = null; loadIntoView(u); }
  });
  bwView.addEventListener('did-navigate', (e) => {
    $('bw-url').value = e.url || '';
    pushHistory(e.url);
  });
  bwView.addEventListener('did-navigate-in-page', (e) => { $('bw-url').value = e.url || ''; });
  bwView.addEventListener('did-fail-load', (e) => {
    // -3 是"用户主动中止"，属于正常现象（点了刷新/又输了新地址），别报错
    if (e.errorCode === -3) return;
    showBrowserError(e.errorDescription || e.errorCode, e.validatedURL);
  });
  stage.appendChild(bwView);          // ← 先入文档（触发元素升级）
  if (initialUrl) bwView.src = initialUrl;   // ← 再设 src（此刻才会真正生效）
  return bwView;
}

/** 真正往 view 里载地址（只在 dom-ready 之后调用） */
function loadIntoView(url) {
  if (!bwView) return false;
  const err = $('bw-error'); if (err) err.remove();
  try { bwView.loadURL(url); } catch (e) { showBrowserError(e.message, url); return false; }
  return true;
}

let bwReady = false;    // webview 是否已 dom-ready
let bwPending = null;   // dom-ready 之前排队的地址

function pushHistory(url) {
  if (!url || bwHistory[bwAt] === url) return;
  bwHistory = bwHistory.slice(0, bwAt + 1);
  bwHistory.push(url);
  bwAt = bwHistory.length - 1;
  syncNavButtons();
}

function syncNavButtons() {
  const back = $('bw-back'); const fwd = $('bw-fwd');
  if (back) back.disabled = bwAt <= 0;
  if (fwd) fwd.disabled = bwAt >= bwHistory.length - 1;
}

function showBrowserError(msg, url) {
  const stage = $('bw-stage');
  if (!stage) return;
  const old = $('bw-error');
  if (old) old.remove();
  const d = document.createElement('div');
  d.id = 'bw-error';
  d.className = 'empty';
  d.style.cssText = 'padding:22px 16px';
  d.textContent = '打不开：' + msg + (url ? '（' + url + '）' : '');
  stage.appendChild(d);
}

/** 打开一个地址（外部入口都走它）：输入框、会话里的文件名、文件面板都用 */
function openInBrowser(raw, opts) {
  const url = toUrl(raw);
  if (!url) return false;
  // 右栏收起时 #side-right 是 visibility:hidden、宽 0 —— 那种状态下 webview 拿不到尺寸，
  // Chromium 不会给它建 guest 进程，loadURL 会静默失败（dom-ready 永远不来）。
  // 所以先确保右栏是展开的，再谈加载。
  if ($('app-root').classList.contains('no-right')) toggleSide('right');
  switchPanel('browser');
  // 首次创建时就把地址当 src 传进去（见 ensureBrowser 的说明：不给 src 的 webview 不会 ready）
  const first = !bwView;
  const v = ensureBrowser(first ? url : null);
  if (!v) return false;
  const empty = $('bw-empty'); if (empty) empty.remove();
  $('bw-url').value = opts && opts.keepInput ? raw : url;
  if (!(opts && opts.keepInput)) pushHistory(url);
  // 首次创建已经用 src 载入了，不用再 loadURL
  if (first) { bwPending = null; return true; }
  if (!bwReady) { bwPending = url; return true; }
  return loadIntoView(url);
}

function focusUrlIfNeeded() {
  // 刚切过来且还没内容时，顺手把光标放地址栏，省一次点击
  if (!bwView) setTimeout(() => { const u = $('bw-url'); if (u && !u.value) u.focus(); }, 60);
}

function bindBrowser() {
  const url = $('bw-url');
  if (!url) return;
  // guest 里的 target=_blank 由主进程回推过来（见 main.js），在当前 view 里打开
  if (api.events.onBrowserNavigate) {
    api.events.onBrowserNavigate((u) => { if (u) openInBrowser(u); });
  }
  url.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    openInBrowser(url.value);
  });
  $('bw-back').onclick = () => {
    if (bwAt <= 0) return;
    bwAt -= 1;
    loadIntoView(bwHistory[bwAt]);
    syncNavButtons();
  };
  $('bw-fwd').onclick = () => {
    if (bwAt >= bwHistory.length - 1) return;
    bwAt += 1;
    loadIntoView(bwHistory[bwAt]);
    syncNavButtons();
  };
  $('bw-reload').onclick = () => { if (bwView && bwReady) bwView.reload(); };
  // 「用系统默认浏览器打开」：地址栏那串先跟回车走同一条归一化（toUrl），再交给系统。
  // ★ 必须走 openExternal —— openPath 只吃文件系统路径，喂它 `file:///C:/…` 这种会失败，
  //   而且失败是 resolve 出来的字符串、不抛异常，旧代码没接返回值 → 用户看到的"按了没反应"。
  //   现在无论成败都回一句话，不存在"什么都不发生"。
  $('bw-open').onclick = async () => {
    const t = toUrl(url.value);
    if (!t) { toast('地址栏是空的', 'err'); return; }
    const r = await api.shell.openExternal(t);
    if (r && r.ok) toast('已交给系统打开：' + r.target, 'ok');
    else toast('打不开：' + ((r && r.error) || '未知原因'), 'err');
  };
  syncNavButtons();
}

/**
 * 正文/工具卡里点链接的统一去处。
 * 用户的预期是"点文件名 → 右侧浏览器打开"（Bionic 就是这么用的），所以这里的规则是：
 *   · http/https           → 右侧内置浏览器
 *   · 本地路径（绝对/相对） → 能当文件读的 → 右侧浏览器（file://）；否则交给系统程序
 *   · .html/.htm 用浏览器渲染，其它文本类（.md/.txt/.json/.js…）走带行号的文本视图
 *   · 其它协议（mailto: 等）→ 系统默认程序
 * ★ 注意相对路径：模型经常只给 `房贷利率与物价.html` 这种文件名，旧代码只认
 *   `http(s)://` 和 `C:\` 绝对路径，于是相对路径**什么都不做**（用户点了没反应）。
 *   这里一律按会话的工作目录拼成绝对路径。工作目录可能有多个：会话的 workingDir、
 *   当前项目目录 —— 挨个试，能读到就用。找不到就退回"交给系统程序"。
 */
function openLink(href) {
  const raw = String(href || '').trim();
  if (!raw) return false;
  if (/^(https?|file):/i.test(raw)) { openInBrowser(raw); return true; }
  // 协议链接（mailto: 等）交给系统 —— 也必须 openExternal：openPath 拿 "mailto:…" 当路径找，
  // 找不到就静默失败（同 bw-open 那个 bug 一个成因）。
  if (/^(mailto|tel):/i.test(raw)) { api.shell.openExternal(raw); return true; }

  // 相对路径 → 依次用这几个基准目录试探
  const bases = [];
  if (S.meta && S.meta.workingDir) bases.push(S.meta.workingDir);
  const proj = S.projects.find((p) => p.id === S.projectId);
  if (proj && proj.cwd) bases.push(proj.cwd);
  const isAbs = /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(raw);
  // ★ 兜底：从检查点记录里按文件名找同名文件。
  //   模型生成的文件一定在改动记录里（agent 每次写文件都会存快照），
  //   而 S.files 里存的是**绝对路径** —— 所以哪怕会话的 workingDir 没读到
  //   （比如刚切项目、meta 还没回来），这条也能把文件找出来。
  //   用户的场景恰恰是"agent 刚生成的文件"，所以这条路命中率最高。
  const byName = (S.files || []).find((f) => {
    if (typeof f.path !== 'string' || !f.path) return false;
    const base = f.path.split(/[\\/]/).pop();
    const want = raw.split(/[\\/]/).pop();
    return base === want && (raw.includes('/') || raw.includes('\\') ? f.path.endsWith(raw) : true);
  });
  const cands = isAbs
    ? [raw]
    : (byName ? [byName.path] : []).concat(
        bases.map((b) => String(b).replace(/[\\/]+$/, '') + '\\' + raw.replace(/^[\\/]+/, ''))
      );

  if (!cands.length) {
    // 实在没有基准目录可拼：至少把它当"用户想用系统程序打开"处理，别静默什么都不做
    api.shell.openPath(raw);
    toast('找不到这个文件：' + raw + '（没有可用的工作目录）', 'err');
    return true;
  }

  // 文本类（含 .html）优先走内置浏览器；.html 交给浏览器渲染，其余用文本视图看
  const isHtml = /\.html?$/i.test(raw);
  const isText = /\.(md|txt|json|js|cjs|mjs|ts|css|yml|yaml|ini|conf|log|csv|xml|py|sh|bat|cmd|vbs|java|go|rs|c|h|cpp)$/i.test(raw);

  (async () => {
    for (const abs of cands) {
      const r = await api.fs.readText({ absPath: abs });   // 有 ok 就说明这个路径真的存在
      if (!r || !r.ok) continue;
      if (isHtml) { openInBrowser(abs); return; }
      if (isText) { switchPanel('files'); previewFile(abs); return; }
      break;                                              // 存在但不是能预览的类型 → 交给系统
    }
    api.shell.openPath(isAbs ? raw : cands[0]);
  })();
  return true;
}

async function refreshFiles() {
  if (!S.projectId) return;
  S.files = await api.checkpoints.list(S.projectId);
  if (S.panel === 'files') renderFiles();
}

let filesTick = 0;
async function refreshFilesIfIdle() {
  if (S.running) return;
  filesTick++;
  if (filesTick % 3 === 0) await refreshFiles();
}

/**
 * 按扩展名给文件挑一个图标名（配合 ICONS 里的 file-* 系列）。
 * 用形状区分大类，扫一眼列表就能认出"这是代码 / 网页 / 文档 / 数据 / 图片"。
 * 认不出来的一律给通用 file 图标 —— 别硬猜。
 */
function fileIconFor(pathOrName) {
  const name = String(pathOrName || '').split(/[\\/]/).pop();
  const m = /\.([a-z0-9]+)$/i.exec(name);
  const ext = m ? m[1].toLowerCase() : '';
  if (!ext) return 'file';
  if (['html', 'htm', 'xhtml', 'vue', 'svelte'].includes(ext)) return 'file-web';
  if (['js', 'cjs', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'bash', 'bat', 'cmd', 'vbs', 'ps1',
    'c', 'h', 'cpp', 'cc', 'hpp', 'java', 'go', 'rs', 'rb', 'php', 'cs', 'swift', 'kt', 'lua', 'sql'].includes(ext)) return 'file-code';
  if (['json', 'csv', 'tsv', 'yml', 'yaml', 'ini', 'toml', 'conf', 'env', 'lock', 'xml'].includes(ext)) return 'file-data';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'].includes(ext)) return 'file-image';
  if (['md', 'markdown', 'txt', 'log', 'rst', 'adoc'].includes(ext)) return 'file-text';
  return 'file';
}

function renderFiles() {
  // ★ 只重画列表容器，**绝不碰** #viewer-host —— 文本视图是另一个容器。
  //   这个坑踩过：两者共用 panel 的 innerHTML 时，renderFiles() 每次刷新都把
  //   行号视图清掉，表现是"点文件名后一闪就没了"。
  const panel = $('files-list');
  if (!panel) return;
  panel.innerHTML = '';
  const t = document.createElement('div');
  t.className = 'group-title';
  t.textContent = '改动记录（检查点）';
  panel.appendChild(t);
  if (!S.files.length) {
    const n = document.createElement('div');
    n.className = 'empty-note';
    n.textContent = '还没有文件改动。agent 每次写文件前都会自动存一份快照，可以在这里恢复。';
    panel.appendChild(n);
  }
  for (const f of S.files) {
    if (typeof f.path !== 'string' || !f.path) continue;   // 日志里若有坏行，别把面板带崩
    const el = document.createElement('div');
    el.className = 'file-item';
    const rel = f.path.split(/[\\/]/).slice(-2).join('/');
    // 每个文件一行：kind 是它**改动前**的状态（新建的=恢复会删掉它），
    // 改过多次的话带个次数——以前这里直接把原始日志行铺出来，同一个文件会出现好几行。
    const kindText = (f.kind === 'absent' ? '新建的' : '改过') + (f.changes > 1 ? ` ×${f.changes}` : '');
    el.innerHTML = `<span class="ic" data-ic="${fileIconFor(f.path)}"></span>`
      + `<span class="path" title="${esc(f.path)}">${esc(rel)}</span><span class="kind">${esc(kindText)}</span>`;
    el.onclick = () => previewFile(f.path);
    const btn = document.createElement('button');
    btn.className = 'ghost';
    btn.textContent = '恢复';
    btn.title = f.kind === 'absent' ? '恢复到这个文件被创建之前（等于删掉它）' : `恢复到最近一次改动之前（已改 ${f.changes || 1} 次）`;
    btn.onclick = async (e) => {
      e.stopPropagation();
      const r = await api.checkpoints.revertFile({ projectId: S.projectId, sessionId: S.sessionId, absPath: f.path });
      toast(r.message, r.ok ? 'ok' : 'err');
      refreshFiles();
    };
    el.appendChild(btn);
    panel.appendChild(el);
  }
  // 新插入的行要注水图标（[data-ic] → SVG）。漏了这步图标就是空的 —— 静默失败，不报错。
  hydrateIcons(panel);
  const g2 = document.createElement('div');
  g2.className = 'group-title';
  g2.textContent = '会话';
  panel.appendChild(g2);
  const btns = document.createElement('div');
  btns.className = 'row-inline';
  const b1 = document.createElement('button');
  b1.className = 'ghost';
  b1.textContent = '打开工作目录';
  b1.onclick = () => api.shell.openPath(S.meta.workingDir);
  const b2 = document.createElement('button');
  b2.className = 'ghost';
  b2.textContent = '删除会话';
  b2.onclick = async () => {
    const removing = S.sessionId;
    await api.sessions.remove({ projectId: S.projectId, sessionId: removing });
    S.sessionId = null;
    S.session = null;
    S.meta = null;
    S.transcript = [];
    S.runningIds.delete(removing); // 注意：必须用置空前抓下来的 id
    await refreshSessions();
    if (S.sessions.length) await loadSession(S.sessions[0].id);
    // 没有别的会话了就走空态（顺带把运行状态重算，别留下上一轮的残留）
    else showNoSession();
  };
  btns.appendChild(b1);
  btns.appendChild(b2);
  panel.appendChild(btns);
}

async function previewFile(absPath) {
  // 文本视图：行号 / 内容两栏，等宽字体对齐（用户要的"点击文件名查看带行号的文本"）。
  const r = await api.fs.readText({ absPath });
  const lines = r.ok ? String(r.text).split('\n') : [];
  const rowsHtml = lines.map((t, i) =>
    '<div class="tv-row"><span class="tv-n">' + (i + 1) + '</span><span class="tv-l">' + (esc(t) || '&nbsp;') + '</span></div>'
  ).join('');
  S.preview = { path: absPath, text: r.ok ? r.text : null, error: r.ok ? null : r.error, lines: lines.length, size: r.size };

  const old = $('file-viewer');
  if (old) old.remove();
  const v = document.createElement('div');
  v.id = 'file-viewer';
  v.innerHTML =
    '<div class="tv-head">' +
      '<button class="ic-btn sm" id="tv-close" title="返回列表" data-ic="arrow-left"></button>' +
      '<span class="ic tv-ic" data-ic="' + fileIconFor(absPath) + '"></span>' +
      '<span class="tv-name" title="' + esc(absPath) + '">' + esc(absPath.split(/[\\/]/).pop()) + '</span>' +
      '<span class="tv-meta">' + (r.ok
        ? lines.length + ' 行' + (r.size ? ' · ' + (r.size / 1024).toFixed(1) + ' KB' : '')
        : '') + '</span>' +
      '<div class="grow"></div>' +
      '<button class="ghost sm" id="tv-open">用系统程序打开</button>' +
    '</div>' +
    (r.ok
      ? '<div class="tv-body">' + rowsHtml + '</div>'
      : '<div class="empty" style="padding:24px 12px">读不了这个文件：' + esc(r.error || '') + '</div>');
  const host = $('viewer-host');
  if (host) host.appendChild(v);
  hydrateIcons(v);
  $('tv-close').onclick = () => v.remove();
  $('tv-open').onclick = () => api.shell.openPath(absPath);
  renderFiles();
}

// ---------------- 设置（模态框） ----------------
// 分组/分区命名照 Bionic 真实安装包里的分区表（bionicSettingsSectionGroups）：
//   组 Settings  → general / agent / voice / cloud / appearance / sessions / advanced
//   组 Integrations → connected-apps / skills
//   组 Devices → link；组 Local Models → local-models-*
// 三条照搬的规矩：
//   ① Bionic 正式版会把 advanced 分区过滤掉（只在 isBionicInternalBuild() 里显示）；我们不是它的正式版，保留。
//   ② 当前停在哪个分区**不落盘**：Bionic 用的是路由状态（bionicSettingsHistory），不是 ui-state。
//      这里也只放内存，免得凭空多出一个 Bionic 里查不到的字段（test:bionic 会当场抓出来）。
//   ③ voice / cloud / connected-apps / link / local-models-* 这些 One Harness 没有对应功能，不硬造空分区充数。
const SETTINGS_GROUPS = [
  { title: '设置', items: ['general', 'fallback', 'agent', 'appearance', 'sessions', 'advanced'] },
  { title: '集成', items: ['skills'] },
];

// 兜底模型卡片：一张给语言模型、一张给生图。两张都是"用户没配时顶上"的那份配置，
// 与「常规」里正在用的模型**互不影响** —— 这正是要点：用户（或者 agent 自己）在这里改配置，
// 不会把自己正在跑的那套改掉，也就不会出现"程序把自己配死"那种局面。
const FALLBACK_CARDS = [
  {
    key: 'llm',
    name: '语言模型（LLM）',
    ctx: true,
    reasoning: true,
    tip: '「常规 → 模型端点」的 Base URL 与模型名都留空时，对话就走这里；' + DEFAULT_SESSION_LABEL + ' 专用会话也固定走这里。',
    note: '出厂值来自随包的 config/model.json。这几项留空 = 用出厂值。',
    saveId: 'btn-save-fb-llm',
  },
  {
    key: 'image',
    name: '生图（generate_image）',
    tip: '所有生图请求都走这里（没有第二个图像端点的概念）。',
    note: '出厂值来自随包的 config/image.json。agnes 家的模型名是 agnes-image-2.5-flash，地址填到 /v1 即可。',
    saveId: 'btn-save-fb-image',
  },
];

// 思考强度那一档的中文名。**取值表不在这儿** —— 它由内核下发（S.reasoningLevels），
// 这里只负责把字面值翻成人话；等级名对不上时原样显示，不猜、不吞。
const REASONING_LABELS = {
  none: '不思考',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
};

function reasoningLabelOf(v) {
  if (!v) return '跟出厂值';
  return (REASONING_LABELS[v] || v) + '（' + v + '）';
}

// 一个端点"填全了"没有 —— 与 core/store.js 的 hasOwnEndpoint 同一条规则
// （baseUrl + 模型名算数，key 不算：本机端点本来就不要 key）。两处都必须一致，
// 否则界面说"正在用你自己配的"、内核却判定没配，用户会看到完全相反的两句话。
function endpointComplete(e) {
  return !!(e && String(e.baseUrl || '').trim() && String(e.model || '').trim());
}

const SETTINGS_SECTIONS = {
  general: {
    label: '常规',
    render() {
      const s = S.settings;
      // 输入框绑的是**用户自己填的原文**（modelOwn），不是"生效值"：
      // 生效值可能是兜底顶上来的，把它填进输入框的话，用户随手一存就把兜底值
      // 变成了"他自己配的" —— 之后改兜底卡片就再也不影响他了。
      const own = s.modelOwn || s.model;
      const usingFallback = !endpointComplete(own);
      return `
        <div class="group-title">模型端点</div>
        <div class="field"><label>Base URL</label><input id="set-baseUrl" value="${esc(own.baseUrl)}" placeholder="留空 = 用兜底模型" /></div>
        <div class="field"><label>API Key</label><input id="set-apiKey" value="${esc(own.apiKey)}" /></div>
        <div class="field"><label>模型</label><input id="set-model" value="${esc(own.model)}" list="model-options" placeholder="留空 = 用兜底模型" /></div>
        <datalist id="model-options">${(S.models || []).map((m) => `<option value="${esc(m)}"></option>`).join('')}</datalist>
        <div class="hint">${usingFallback
          ? `现在<b>没有</b>用自己的端点（Base URL 与模型名都留空），整套走「兜底模型」：<code>${esc(s.model.model)}</code> @ <code>${esc(s.model.baseUrl)}</code>。想换成自己的，把上面两项都填上即可。`
          : '现在用的是你自己配的这一组。'}上面这几项**要么都填、要么都别填**：只填一半时不会去兜底那份里"借"缺的那一项（把兜底家的 Key 发到你家地址上，是不会报错的那种错），而是整个按你填的来。</div>
        <div class="field">
          <label class="chk"><input type="checkbox" id="set-vision"${s.model.supportsVision ? ' checked' : ''} /><span>支持图片输入（这个模型能看图）</span></label>
          <div class="hint">勾上之后，拖进输入框的图片会随消息一起交给模型。端点不会告诉程序"这个模型能不能看图"（/v1/models 只回 id），所以只能在这里声明。勾错了也不至于卡死：程序会剥掉图按纯文本重发一次，并提示你来这里取消勾选。</div>
        </div>
        <div class="row-inline field">
          <div><label>温度</label><input id="set-temp" type="number" step="0.1" min="0" max="2" value="${esc(s.model.temperature)}" /></div>
          <div><label>上下文长度</label><input id="set-ctx" type="number" step="1024" value="${esc(s.model.contextLength)}" /></div>
        </div>
        <div class="hint">上下文长度只影响「什么时候自动压缩」和界面上的占用条，不影响请求本身。框里显示的就是<b>当前生效</b>的那个数${usingFallback ? `（现在走兜底模型，所以它是兜底那份自带的；想改到别处请去「兜底模型 → 语言模型」）` : ''}；在这填了别的数，就按你填的算。</div>
        <div class="row-inline">
          <button id="btn-test">拉取模型列表</button>
          <button id="btn-save-general" class="primary">保存并应用</button>
        </div>

        <div class="group-title">数据</div>
        <div class="row-inline"><button id="btn-open-data" class="ghost">打开数据目录</button></div>
        <div class="hint">模型端点、审批、工具等配置都存在数据目录的 settings.json 里。</div>

        <div class="group-title">工程索引</div>
        <div class="row-inline">
          <button id="btn-export-index">导出工程索引</button>
          <button id="btn-import-index" class="ghost">导入工程索引</button>
        </div>
        <div class="hint">当前索引里有 ${(S.projects || []).length} 个工程。索引是**指针**（每个工程的 id / 名字 / 工程文件夹地址，几 KB）。会话记录**不在索引里** —— 它就在工程文件夹自己的 .one-harness 子目录下，跟着文件夹走：把文件夹带到哪，对话就跟到哪。</div>
        <div class="hint">导入是**只增不减**的：同一个工程（id 相同）会被跳过，本机已有的名字与工作目录不会被备份里的旧值覆盖；本机多出来的工程也不受影响。</div>
      `;
    },
    bind() {
      on('btn-open-data', () => api.shell.openDataDir());
      on('btn-export-index', async () => {
        const r = await api.projects.exportIndex();
        if (!r.ok) { if (!r.canceled) toast(r.message, 'err'); return; }
        toast('已导出 ' + r.count + ' 个工程的索引：' + r.path, 'ok');
      });
      on('btn-import-index', async () => {
        const r = await api.projects.importIndex();
        if (!r.ok) { if (!r.canceled) toast(r.message, 'err'); return; }
        // 索引变了，左栏的工程树和会话列表都得跟着重读；当前还没选中工程时顺手选上第一个
        S.projects = await api.projects.list();
        await refreshSessions();
        renderTree();
        if (!S.projectId && S.projects.length) await setProject(S.projects[0].id, { sessionId: null });
        renderSettingsModal();
        const bits = ['新增 ' + r.added + ' 个工程'];
        if (r.skipped) bits.push('已有 ' + r.skipped + ' 个跳过');
        if (r.invalid) bits.push('另有 ' + r.invalid + ' 条记录不完整已忽略');
        let msg = '导入完成：' + bits.join('，');
        if (r.gone) msg += '。其中 ' + r.gone + ' 个指向的工程文件夹在本机不存在（把文件夹放回原处就能用）';
        else if (r.empty) msg += '。其中 ' + r.empty + ' 个还是空工程（文件夹里没有会话记录）';
        toast(msg, r.added ? 'ok' : '');
      });
      on('btn-test', async () => {
        const ml = await api.models.list({
          baseUrl: $('set-baseUrl').value, apiKey: $('set-apiKey').value, model: $('set-model').value,
        });
        if (ml.ok) {
          S.models = ml.models;
          hideBanner();
          toast(`连通，共 ${ml.models.length} 个模型`, 'ok');
          renderModelSelect();
          renderSettingsModal();
        } else {
          toast('连接失败：' + ml.error, 'err');
        }
      });
      on('btn-save-general', async () => {
        S.settings = await api.settings.save({
          model: {
            baseUrl: $('set-baseUrl').value.trim(),
            apiKey: $('set-apiKey').value,
            model: $('set-model').value.trim(),
            supportsVision: $('set-vision').checked,
            temperature: Number($('set-temp').value),
            contextLength: Number($('set-ctx').value),
          },
        });
        renderModelSelect();
        renderTop();
        toast('模型设置已保存', 'ok');
      });
    },
  },

  fallback: {
    label: '兜底模型',
    render() {
      const s = S.settings;
      const fb = s.fallback || {};
      const ownInUse = endpointComplete(s.modelOwn || {});
      const cards = FALLBACK_CARDS.map((c) => {
        const e = fb[c.key] || {};
        // 语言模型那张只在"用户没配"时顶上；生图这张就是工具唯一的出处，永远算在用。
        // 语言模型那张**永远**有人用：除了"常规里没填时顶上"，还有 One Harness 专用会话。
        // 所以它在用户在「常规」里配了端点之后也不能写"未使用" —— 那会是一句假话。
        const state = c.key === 'llm'
          ? (ownInUse ? { cls: 'state-off', tag: '专用会话在用', why: '你在「常规」里配了自己的端点，所以普通会话走你那套；但左栏那个 ' + DEFAULT_SESSION_LABEL + ' 专用会话**始终**走这里。' }
                      : { cls: 'state-on', tag: '正在生效', why: '「常规」里没配端点：普通对话和 ' + DEFAULT_SESSION_LABEL + ' 专用会话都走这里。' })
          : { cls: 'state-on', tag: '生图就是走它', why: 'generate_image 只有这一个端点，没有"第二套"可切。' };
        return `
        <div class="fb-card ${state.cls}">
          <div class="fb-card-top">
            <span class="fb-card-name">${esc(c.name)}</span>
            <span class="pill ${state.cls === 'state-on' ? 'mint' : ''}">${esc(state.tag)}</span>
          </div>
          <div class="hint">${esc(c.tip + state.why)}</div>
          <div class="field"><label>Base URL</label><input id="fb-${c.key}-baseUrl" value="${esc(e.baseUrl)}" /></div>
          <div class="field"><label>API Key</label><input id="fb-${c.key}-apiKey" value="${esc(e.apiKey)}" /></div>
          <div class="field"><label>模型</label><input id="fb-${c.key}-model" value="${esc(e.model)}" list="model-options" /></div>
          ${c.ctx ? `<div class="field"><label>上下文长度</label><input id="fb-${c.key}-ctx" type="number" step="1024" value="${esc(e.contextLength)}" placeholder="留空 = 用出厂值" /><div class="hint">这个模型自带的上下文大小（token）。它决定自动压缩的阈值和界面上的占用条 —— agnes-3.0-flash 是 524288（512K）。「常规」里那个同名框是**你自己端点**的，两者各管各的；正在用哪一套，就按那一套的算。</div></div>` : ''}
          ${c.reasoning ? `<div class="field"><label>思考强度</label>
            <button id="fb-${c.key}-reasoning" class="sel-trigger" aria-haspopup="listbox" aria-expanded="false" data-v="${esc(e.reasoning || '')}"><span class="sel-label">${esc(reasoningLabelOf(e.reasoning))}</span><span class="ic" data-ic="chevron"></span></button>
            <div class="hint">就是请求里的 <code>reasoning_effort</code>：「不思考」出话快、适合日常；调高之后模型会先想一段再答（响应明显变慢，思考过程会显示在气泡里）。取值只能从下拉里那几个里选 —— 这是端点自己定的字面值，乱填（或大小写不对）它直接回 400。<br />这一项<b>只作用于兜底这份端点</b>：你要是配了自己的模型，它永远不会被带上（在「常规」里配了端点时，这里改什么都不影响你正在用的那套）。</div>
          </div>` : ''}
          <div class="fb-card-foot">
            <button id="${c.saveId}" class="primary">保存</button>
            <span class="state">${esc(c.note)}</span>
          </div>
        </div>`;
      }).join('');
      return `
        <div class="group-title">兜底模型</div>
        <div class="hint">这两张卡是**没配置时顶上来的那套**：语言模型那张在「常规 → 模型端点」没填时顶上，生图那张则是 generate_image 工具唯一的出处。两张卡与"正在用的模型"分开存放 —— 在这儿改不会动到正在跑的那套，反之也一样（这正是"能用兜底去配置 One Harness、却不会把程序自己配死"的前提）。<br />语言模型那张还多一个去处：左栏底部那个<b>${DEFAULT_SESSION_LABEL}</b>固定入口（就在「设置」上方），点进去就是专用会话 —— 它始终走这里（哪怕你在「常规」里配了自己的端点）。想在不动自己模型的前提下用自带模型，就从那个入口进；「新建会话」菜单和模型下拉里也能进，说的是同一个会话。<br />每项**留空 = 用随包 config/ 里的出厂值**；想用自己的 key（例如自己去 agnes 注册领一个），填进来保存即可。</div>
        <div class="fb-cards">${cards}</div>
      `;
    },
    bind() {
      for (const c of FALLBACK_CARDS) {
        // 思考强度：下拉选项**由内核下发的取值表**现拼（见 S.reasoningLevels 的说明），
        // 前面加一档"跟出厂值"（空串）—— 空串会存成空串，于是将来改 config/model.json 还能跟着走。
        if (c.reasoning) {
          const btn = $('fb-' + c.key + '-reasoning');
          if (btn) {
            const paint = () => {
              const lb = btn.querySelector('.sel-label');
              if (lb) lb.textContent = reasoningLabelOf(btn.dataset.v);
            };
            paint();
            btn.onclick = () => openSelect(btn, [{ value: '', label: '跟出厂值', desc: '用随包 config/model.json 里那句 reasoning' }]
              .concat((S.reasoningLevels || []).map((v) => ({ value: v, label: reasoningLabelOf(v), desc: 'reasoning_effort = ' + v }))), {
              value: btn.dataset.v,
              density: 'normal',      // 设置里是表单控件，跟审批模式那档一致
              width: 'fit',
              minWidth: 220,
              onPick: (v) => { btn.dataset.v = v; paint(); },
            });
          }
        }
        on(c.saveId, async () => {
          const patch = {
            baseUrl: $('fb-' + c.key + '-baseUrl').value.trim(),
            apiKey: $('fb-' + c.key + '-apiKey').value.trim(),
            model: $('fb-' + c.key + '-model').value.trim(),
          };
          // 上下文只给语言模型那张：它是模型属性，生图端点没有这一项。
          // 空串保持空串（= 用出厂值），别写成 0 —— 0 会被当成"用户设成了 0"。
          if (c.ctx) {
            const raw = $('fb-' + c.key + '-ctx').value.trim();
            patch.contextLength = raw === '' ? '' : Number(raw);
          }
          // 思考强度同理：空串 = 跟出厂走（内核存盘时会归一化，填了跟出厂一样的值也存空串）
          if (c.reasoning) {
            const tb = $('fb-' + c.key + '-reasoning');
            patch.reasoning = (tb && tb.dataset.v) || '';
          }
          S.settings = await api.settings.save({ fallback: { [c.key]: patch } });
          renderSettingsModal();
          renderTop();
          toast(c.name + '的兜底设置已保存', 'ok');
        });
      }
    },
  },

  agent: {
    label: '智能体',
    render() {
      const s = S.settings;
      return `
        <div class="group-title">循环</div>
        <div class="row-inline field">
          <div><label>单轮最大步数</label><input id="set-maxsteps" type="number" min="1" max="200" step="1" value="${esc(s.agent.maxSteps)}" /></div>
          <div><label>自动压缩阈值（占上下文比例）</label><input id="set-ratio" type="number" step="0.01" min="0.5" max="1" value="${esc(s.agent.autoCompactRatio)}" /></div>
        </div>
        <div class="row-inline"><button id="btn-save-agent" class="primary">保存</button></div>
        <div class="hint">压缩阈值指上下文占用超过该比例时丢掉最旧的事件；单轮步数到顶会强制收尾。</div>
      `;
    },
    bind() {
      on('btn-save-agent', async () => {
        S.settings = await api.settings.save({
          agent: {
            maxSteps: Number($('set-maxsteps').value),
            autoCompactRatio: Number($('set-ratio').value),
          },
        });
        toast('已保存', 'ok');
      });
    },
  },

  appearance: {
    label: '外观',
    render() {
      const wsx = ws();
      return `
        <div class="group-title">界面布局</div>
        <div class="row-inline field">
          <div><label>左栏宽度（px）</label><input id="set-left-w" type="number" min="200" max="480" step="2" value="${Number(wsx.leftSidebarWidth) || 236}" /></div>
          <div><label>右栏宽度（px）</label><input id="set-right-w" type="number" min="240" max="640" step="2" value="${Number(wsx.rightPanelWidth) || 345}" /></div>
        </div>
        <div class="row-inline">
          <button id="btn-fold-left" class="ghost">左栏 ${wsx.leftSidebarIsCollapsed ? '展开' : '折叠'}</button>
          <button id="btn-fold-right" class="ghost">右栏 ${wsx.rightPanelIsCollapsed ? '展开' : '折叠'}</button>
          <button id="btn-reset-layout" class="ghost">重置布局</button>
        </div>
        <div class="field">
          <label>布局文件（窗口键 ${esc(LAYOUT.windowKey)}）</label>
          <div class="hint" style="word-break:break-all">${esc(S.roots ? S.roots.uiStateDir : '')}/window-${esc(LAYOUT.windowKey)}.json</div>
        </div>
        <div class="hint">栏宽是即时生效的：改完直接落盘，下次开窗照旧。</div>
      `;
    },
    bind() {
      on('set-left-w', null, (e) => {
        const v = setPanelWidth('left', Number(e.target.value));
        e.target.value = v;
        saveLayout({ leftSidebarWidth: v }, { immediate: true });
      });
      on('set-right-w', null, (e) => {
        const v = setPanelWidth('right', Number(e.target.value));
        e.target.value = v;
        saveLayout({ rightPanelWidth: v }, { immediate: true });
      });
      on('btn-fold-left', () => { toggleSide('left'); renderSettingsModal(); });
      on('btn-fold-right', () => { toggleSide('right'); renderSettingsModal(); });
      on('btn-reset-layout', async () => {
        LAYOUT.window = await api.ui.reset();
        applyLayoutGeometry();
        renderSettingsModal();
        toast('布局已恢复默认', 'ok');
      });
    },
  },

  sessions: {
    label: '会话',
    render() {
      const s = S.settings;
      return `
        <div class="group-title">审批</div>
        <div class="field"><label>新会话默认模式</label>
          <button id="set-approval" class="sel-trigger" aria-haspopup="listbox" aria-expanded="false"><span class="sel-label"></span><span class="ic" data-ic="chevron"></span></button>
        </div>
        <div class="field"><label>评审用模型（留空 = 与主模型相同）</label><input id="set-reviewer" value="${esc(s.approval.reviewerModel)}" /></div>
        <div class="row-inline"><button id="btn-save-approval" class="primary">保存</button></div>
        <div class="hint">顶栏输入框旁边那个盾牌只改「当前会话」；这里改的是「新会话的默认值」，已经开着的会话不受影响。</div>

        <div class="group-title">当前会话</div>
        <div class="field"><label>工作目录</label>
          <div class="row-inline"><input id="set-wd" value="${S.meta ? esc(S.meta.workingDir) : ''}" /><button id="btn-pick-wd" class="ghost">选择</button><button id="btn-save-wd">应用</button></div>
        </div>
        <div class="field"><label>能力模块（改了立即生效）</label><div class="chips" id="module-chips"></div></div>
      `;
    },
    bind() {
      // 全局默认模式：这里是"新会话默认值"，所以不提供「跟随全局」那一档（会自我循环）
      const btn = $('set-approval');
      if (btn) {
        if (!btn.dataset.v) btn.dataset.v = S.settings.approval.mode || '';
        const paint = () => {
          const lb = btn.querySelector('.sel-label');
          if (lb) lb.textContent = approvalModeOf(btn.dataset.v).label;
        };
        paint();
        btn.onclick = () => openSelect(btn, APPROVAL_MODES.filter((m) => m.value), {
          value: btn.dataset.v,
          density: 'normal',      // 设置里是表单控件，用 normal 档（28px 条目 / 32px 右留白）
          width: 'fit',           // 表单框有 618px 宽，跟过去会得到一个巨宽的菜单 → 用 fit
          minWidth: 180,
          onPick: (v) => { btn.dataset.v = v; paint(); },
        });
      }
      on('btn-save-approval', async () => {
        S.settings = await api.settings.save({
          approval: { mode: ($('set-approval') || {}).dataset?.v || '', reviewerModel: $('set-reviewer').value.trim() },
        });
        renderTop();
        toast('已保存', 'ok');
      });
      on('btn-pick-wd', async () => {
        const dir = await api.projects.pickFolder();
        if (dir) $('set-wd').value = dir;
      });
      on('btn-save-wd', async () => {
        const r = await api.sessions.update({ projectId: S.projectId, sessionId: S.sessionId, patch: { workingDir: $('set-wd').value.trim() } });
        S.meta = r.meta;
        renderTop();
        toast('工作目录已更新', 'ok');
      });

      const chips = $('module-chips');
      if (!chips) return;
      const active = new Set((S.meta && S.meta.modules) || []);
      for (const mod of S.modules) {
        const c = document.createElement('div');
        c.className = 'chip' + (active.has(mod.id) ? ' on' : '');
        c.textContent = mod.label + (mod.tools.length ? `（${mod.tools.length}）` : '');
        c.onclick = async () => {
          active.has(mod.id) ? active.delete(mod.id) : active.add(mod.id);
          const r = await api.sessions.update({
            projectId: S.projectId, sessionId: S.sessionId,
            patch: { modules: S.modules.map((m) => m.id).filter((id) => active.has(id)) },
          });
          S.meta = r.meta;
          renderTop();
          renderSettingsModal();
        };
        chips.appendChild(c);
      }
    },
  },

  skills: {
    label: '技能',
    // 一个技能一张卡：名字 + 常驻/按需 + 随包/自装 + 描述 + 所在文件夹 + 「查看」。
    // 卡片顺序按 tier 分组，因为"常驻"是有代价的（正文每轮都进系统提示），
    // 分开放眼一看就知道上下文被谁占了。
    render() {
      const all = S.skills || [];
      if (!all.length) {
        return `
          <div class="group-title">技能库</div>
          <div class="empty-note">还没有技能。技能就是技能目录里的一个文件夹，里面放一份 SKILL.md。</div>
          <div class="row-inline" style="margin-top:10px"><button id="btn-open-skills-dir" class="ghost">打开技能目录</button></div>
        `;
      }
      const intro = all.filter((s) => s.tier === 'intro');
      const outro = all.filter((s) => s.tier !== 'intro');
      const card = (s) => `
        <div class="skill-card">
          <div class="skill-card-top">
            <span class="skill-card-name">${esc(s.name)}</span>
            <span class="pill ${s.tier === 'intro' ? 'mint' : 'warn'}">${s.tier === 'intro' ? '常驻' : '按需'}</span>
            <span class="pill sky">${s.source === 'builtin' ? '随包' : '自装'}</span>
            <button class="ghost skill-card-btn" data-skill-view="${esc(s.name)}">查看</button>
          </div>
          <div class="skill-card-desc">${esc(s.description || '这份 SKILL.md 没有写 description。')}</div>
          <div class="skill-card-path" title="${esc(s.path)}">${esc(s.dir)}</div>
        </div>`;
      const group = (title, note, arr) => (arr.length ? `
        <div class="group-title">${title} · ${arr.length} 个</div>
        <div class="hint" style="margin:-3px 0 9px">${note}</div>
        <div class="skill-cards">${arr.map(card).join('')}</div>` : '');
      return `
        <div class="hint" style="margin-top:0">技能 = 技能目录里的一个文件夹，里面一份 SKILL.md。当前共 ${all.length} 个 —— 常驻 ${intro.length}、按需 ${outro.length}。</div>
        ${group('常驻', '正文每轮都进系统提示，只该放"必须一直遵守"的规范。', intro)}
        ${group('按需', '系统提示里只给名字与一句话描述；模型判断相关后自己用 read_skill 读全文。', outro)}
        <div class="row-inline" style="margin-top:16px"><button id="btn-open-skills-dir" class="ghost">打开技能目录</button></div>
      `;
    },
    bind() {
      on('btn-open-skills-dir', () => api.skills.openDir());
      for (const b of document.querySelectorAll('[data-skill-view]')) {
        b.onclick = async () => {
          const name = b.dataset.skillView;
          closeSettings();
          switchPanel('skills');
          await selectSkill(name);
        };
      }
    },
  },

  advanced: {
    label: '高级',
    render() {
      const s = S.settings;
      return `
        <div class="group-title">工具</div>
        <div class="field"><label>Python 可执行文件</label><input id="set-python" value="${esc(s.python.executable)}" placeholder="留空则自动探测" /></div>
        <div class="field"><label>Shell</label><input id="set-shell" value="${esc(s.shell.shellPath)}" /></div>
        <div class="field"><label>联网搜索端点（SearxNG JSON API）</label><input id="set-search" value="${esc(s.web.searchEndpoint)}" placeholder="例如 http://127.0.0.1:8888" /></div>
        <div class="row-inline"><button id="btn-save-tools" class="primary">保存</button></div>
        <div class="hint">Bionic 的正式版会把这个分区藏起来（只在内部构建里显示），我们保留，因为 Python / Shell 路径是这里唯一能改的地方。</div>
      `;
    },
    bind() {
      on('btn-save-tools', async () => {
        S.settings = await api.settings.save({
          python: { executable: $('set-python').value.trim() },
          shell: { shellPath: $('set-shell').value.trim() },
          web: { searchEndpoint: $('set-search').value.trim() },
        });
        toast('已保存', 'ok');
      });
    },
  },
};

/** 只绑存在的控件：同一个 id 只会出现在一个分区里，别的分区里没有就跳过 */
function on(id, clickFn, changeFn) {
  const el = $(id);
  if (!el) return;
  if (clickFn) el.onclick = clickFn;
  if (changeFn) el.onchange = changeFn;
}

function openSettings(section) {
  const def = SETTINGS_SECTIONS[section] ? section : null;
  if (def) S.settingsSection = def;
  if (!SETTINGS_SECTIONS[S.settingsSection]) S.settingsSection = 'general';
  renderSettingsModal();
  $('settings-modal').classList.remove('hidden');
}

function closeSettings() {
  closeSelect(false);        // 关设置时顺手收掉里面可能开着的下拉
  $('settings-modal').classList.add('hidden');
}

function renderSettingsModal() {
  const nav = $('settings-nav');
  if (!nav) return;
  nav.innerHTML = SETTINGS_GROUPS.map((g) => `
    <div class="grp">${esc(g.title)}</div>
    ${g.items.filter((id) => SETTINGS_SECTIONS[id]).map((id) => `
      <div class="item${id === S.settingsSection ? ' active' : ''}" data-sec="${esc(id)}">${esc(SETTINGS_SECTIONS[id].label)}</div>
    `).join('')}
  `).join('');
  for (const el of nav.querySelectorAll('.item')) {
    el.onclick = () => { S.settingsSection = el.dataset.sec; renderSettingsModal(); };
  }
  const sec = SETTINGS_SECTIONS[S.settingsSection];
  const box = $('settings-content');
  box.innerHTML = sec.render();
  // 设置内容里也有 data-ic（审批下拉的箭头等），插完 DOM 必须水合一次，
  // 否则那些图标是空的 —— hydrateIcons 的契约就是"插完标记后调它"，别漏。
  hydrateIcons(box);
  sec.bind();
}

function renderToolsPanel() {
  const p = $('panel-tools');
  p.innerHTML = '<div class="group-title">已注册工具（别名 → 模块）</div>' +
    S.catalog.map((t) => `
      <div class="field">
        <div><span class="mono" style="color:var(--text)">${esc(t.alias)}</span>
        <span class="pill ${t.risk === 'low' ? 'mint' : t.risk === 'medium' ? 'warn' : t.risk === 'high' ? 'peach' : ''}" style="margin-left:6px">${esc(t.risk)}</span>
        <span class="pill" style="margin-left:4px">${esc(t.module)}</span></div>
        <div class="empty-note" style="margin-top:4px">${esc(t.description)}</div>
      </div>`).join('');
}

// 并发合并：切到技能页会刷新一次，「设置 → 卡片里的查看」也会刷新一次，
// 两次并发跑完各自 renderSkillsPanel()，后完成的那次会把刚灌进文本框的内容清掉。
// 共用同一次刷新就没这个窗口了（第二次 await 到的就是第一次的结果）。
let skillsRefreshPromise = null;
function refreshSkills() {
  if (skillsRefreshPromise) return skillsRefreshPromise;
  skillsRefreshPromise = (async () => {
    try {
      S.skills = await api.skills.list();
      if (S.panel === 'skills') renderSkillsPanel();
    } finally {
      skillsRefreshPromise = null;
    }
  })();
  return skillsRefreshPromise;
}

/** 选中一个技能：先等面板按最新列表渲染完，再把正文灌进文本框 */
async function selectSkill(name) {
  await refreshSkills();
  const full = await api.skills.read(name);
  if (!full) return toast('读不到这个技能：' + name, 'err');
  $('skill-name').value = name;
  $('skill-content').value = full.content || '';
  $('skill-edit-title').textContent = '内容 · ' + full.path;
  for (const c of document.querySelectorAll('#skill-chips .chip')) {
    c.classList.toggle('on', c.dataset.skill === name);
  }
}

function renderSkillsPanel() {
  const p = $('panel-skills');
  p.innerHTML = `
    <div class="group-title">技能库（SKILL.md）</div>
    <div class="chips" id="skill-chips"></div>
    <div class="group-title" id="skill-edit-title">内容</div>
    <textarea id="skill-content" rows="16" placeholder="选中一个技能查看内容，或在这里写一个新的。"></textarea>
    <div class="field" style="margin-top:8px"><label>技能名（新技能目录名）</label><input id="skill-name" placeholder="例如 pdf-report" /></div>
    <div class="row-inline"><button id="btn-skill-save" class="primary">保存为技能</button><button id="btn-skill-dir" class="ghost">打开技能目录</button></div>
    <div class="empty-note" style="margin-top:10px">技能在系统提示里只暴露名字与描述，模型需要时用 read_skill 读取全文，避免长文档常驻上下文。</div>
  `;
  const chips = $('skill-chips');
  if (!S.skills.length) {
    const n = document.createElement('div');
    n.className = 'empty-note';
    n.textContent = '还没有技能。';
    chips.appendChild(n);
  }
  for (const s of S.skills) {
    const c = document.createElement('div');
    c.className = 'chip';
    c.textContent = s.name;
    c.title = (s.description || s.name) + '\n' + s.path;
    c.dataset.skill = s.name;
    c.onclick = () => selectSkill(s.name);
    chips.appendChild(c);
  }
  $('btn-skill-save').onclick = async () => {
    const name = $('skill-name').value.trim();
    if (!name) return toast('先填技能名', 'err');
    const r = await api.skills.save({ name, content: $('skill-content').value });
    toast('已保存到 ' + r.path, 'ok');
    await refreshSkills();
  };
  $('btn-skill-dir').onclick = () => api.skills.openDir();
}

// ---------------- 事件绑定 ----------------
function bind() {
  hydrateIcons(document);
  // 布局：分隔条拖动 + 侧栏折叠
  attachSplitter('split-left', 'left');
  attachSplitter('split-right', 'right');
  $('btn-toggle-left').onclick = () => toggleSide('left');
  // 收起后 #side-left 整块被隐藏，里面的按钮点不到了，所以顶栏常驻这个展开入口
  $('btn-open-left').onclick = () => toggleSide('left');
  $('btn-toggle-right').onclick = () => toggleSide('right');
  $('btn-close-right').onclick = () => toggleSide('right');
  $('btn-tab-new').onclick = () => createSession('omni');
  bindBrowser();
  // 会话里的文件 chip：点一下切到「文件」面板的文本视图（带行号）。
  // 用事件委托，因为转录是整体重渲染的，逐个绑会在重渲染后失效。
  const tr = $('transcript');
  if (tr) {
    tr.addEventListener('click', (e) => {
      const chip = e.target.closest && e.target.closest('.file-chip');
      if (!chip) return;
      e.preventDefault();
      e.stopPropagation();
      switchPanel('files');
      previewFile(chip.getAttribute('data-abs'));
    });
  }
  // 左栏底部的设置入口（位置与样式照 Bionic 的左下角那个按钮）：点开是模态框，
  // 不再去动右栏——设置和右栏没关系了。
  // 左栏底部那个固定入口：打开/新建「One Harness」专用会话（有就打开、没有才建）。
  // 位置在设置**上方**，常驻不随项目树滚动 —— 见 index.html 的 .side-footer。
  $('btn-default-session').onclick = () => openDefaultSession();
  $('btn-open-settings').onclick = () => openSettings();
  // 左栏收起时的兜底入口（见 index.html 的注释）：不补的话收起左栏就没法开设置了
  $('btn-open-settings-rail').onclick = () => openSettings();
  $('settings-close').onclick = closeSettings;
  $('settings-modal').addEventListener('click', (e) => {
    // 点遮罩空白处关闭；点面板内部不关
    if (e.target === $('settings-modal')) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settings-modal').classList.contains('hidden')) {
      // 下拉浮层开着时，Esc 先归浮层（selectKeydown 会 stopImmediatePropagation，
      // 正常轮不到这里；万一将来有人调了注册顺序，这道判断也不会把设置一起关掉）
      if (selOpen) { closeSelect(true); return; }
      // 审批卡在最上层时，Esc 先给审批卡（它自己会处理），别把底下的设置一起关掉
      if ($('approval-modal').classList.contains('hidden')) closeSettings();
    }
  });
  $('btn-send').onclick = send;
  $('btn-stop').onclick = stop;
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      hideNewSessionMenu();
    }
  });

  // 拖进来的文件：整个窗口接住 drag/drop，但落在输入框里才算附件（见 bindDrops）
  bindDrops();
  $('composer-atts').addEventListener('click', (e) => {
    const b = e.target.closest('[data-att-drop]');
    if (b) removeAtt(b.getAttribute('data-att-drop'));
  });

  // 输入框左边的 +：弹出「新建会话」菜单
  $('btn-plus').onclick = (e) => {
    e.stopPropagation();
    const box = $('new-session-menu');
    if (box.classList.contains('hidden')) showNewSessionMenu();
    else hideNewSessionMenu();
  };

  // 无边框窗口的三颗按钮
  $('win-min').onclick = () => api.win.minimize();
  $('win-max').onclick = () => api.win.toggleMaximize();
  $('win-close').onclick = () => api.win.close();

  $('btn-new-project').onclick = async () => {
    const dir = await api.projects.pickFolder();
    if (dir == null) return; // 用户在系统对话框里点了取消
    const name = await askProjectName(dir);
    if (!name) return;
    const p = await api.projects.create({ name, cwd: dir });
    S.projects.push(p);
    S.tree[p.id] = [];
    await setProject(p.id);
    await createSession('omni');
    toast('已创建项目「' + p.name + '」', 'ok');
  };
  $('approval-allow').onclick = () => answerApproval(true, false);
  $('approval-deny').onclick = () => answerApproval(false, false);
  $('approval-always').onclick = () => answerApproval(true, true);
  $('approval-modal').addEventListener('click', (e) => {
    if (e.target === $('approval-modal')) return;
  });
  for (const t of document.querySelectorAll('.tab')) t.onclick = () => switchPanel(t.dataset.tab);
  // 审批模式 / 模型两个下拉（自绘浮层，见 openSelect）
  $('approval-select').onclick = () => openApprovalSelect();
  $('model-select').onclick = () => openModelSelect();
  // 点别处 / 按 Esc / 窗口尺寸变了 → 收起浮层
  document.addEventListener('click', (e) => {
    if (!selOpen) return;
    const t = e.target;
    if (t.closest && (t.closest('#sel-pop') || t === selOpen.trigger)) return;
    closeSelect(false);
  }, true);
  document.addEventListener('keydown', selectKeydown);
  window.addEventListener('resize', () => { if (selOpen) closeSelect(false); });
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t.closest && (t.closest('#new-session-menu') || t.closest('#btn-plus')))) hideNewSessionMenu();
    const a = t.closest && t.closest('a[data-link]');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('data-link');
      openLink(href);
    }
  });
  window.addEventListener('error', (e) => toast('界面错误：' + e.message, 'err'));
  // async 事件处理器里抛的错**不会**触发上面的 error 事件，只会变成未处理拒绝。
  // 这就是"点了按钮什么都没发生"的典型成因，必须让它现形。
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    const msg = (r && (r.message || String(r))) || '未知错误';
    console.error('[unhandled]', r);
    toast('操作失败：' + msg, 'err');
  });
}

bind();
init().catch((e) => {
  // 直接吞掉异常会只剩一个白窗口，行号都没有；把栈也画出来，方便定位是哪个元素/哪一行
  document.body.innerHTML =
    '<div style="padding:24px;font-family:sans-serif;color:#c9372c;white-space:pre-wrap">启动失败：' +
    esc(e.message) +
    '\n\n' +
    esc(String(e.stack || '').split('\n').slice(0, 8).join('\n')) +
    '</div>';
});
