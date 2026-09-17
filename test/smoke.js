'use strict';
// 冒烟测试：用假的 OpenAI 兼容服务跑通 整轮 → 工具调用 → 落盘 → 检查点 → 回滚
// 运行： node test/smoke.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'test', '.tmp');
process.env.HATCH_DATA_DIR = path.join(TMP, 'data');

const store = require('../core/store');
const sessionLib = require('../core/session');
const checkpoints = require('../core/checkpoints');
const { Agent } = require('../core/agent');
const approvals = require('../core/approvals');
const tools = require('../core/tools');
const runlog = require('../core/runlog');
const { classifyCommand } = require('../core/tools/shell');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fail++;
    console.log('  FAIL ' + name + (extra ? '  → ' + extra : ''));
  }
}

// ---------- 假模型服务 ----------
let call = 0;
function startMock() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    if (req.url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const payload = JSON.parse(body || '{}');
        const msgs = payload.messages || [];
        const sys = String((msgs[0] || {}).content || '');
        const hasToolResult = msgs.some((m) => m.role === 'tool');
        const toolNames = (payload.tools || []).map((t) => t.function.name);
        const joined = JSON.stringify(msgs);
        call++;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
        const chunk = (delta, finish) => ({ choices: [{ index: 0, delta, finish_reason: finish || null }] });

        // ---- 评审子会话：走另一套脚本 ----
        if (sys.startsWith('You are the command reviewer')) {
          global.__lastReviewTools = toolNames;
          if (joined.includes('REVIEW_FAIL')) {
            // 一直吐不出 <result>，用来验证「评审坏了要转人工」的兜底
            send(chunk({ content: '我不太确定，先不判断了。' }));
            send(chunk({}, 'stop'));
          } else if (joined.includes('REVIEW_READ') && !hasToolResult) {
            // 先取证：要求给只读工具，再出裁决
            send(chunk({ tool_calls: [{ index: 0, id: 'rv_1', function: { name: 'list_directory', arguments: '{"relativePath":"."}' } }] }));
            send(chunk({}, 'tool_calls'));
          } else {
            send(chunk({ content: '<result>{"risk":"medium","authorization":"neutral","correct":true}</result>' }));
            send(chunk({}, 'stop'));
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        if (!hasToolResult) {
          send({ choices: [{ delta: { reasoning_content: '先写一个文件。' } }] });
          send({
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call_1',
                  function: { name: 'write_file', arguments: JSON.stringify({ relativePath: 'notes/hello.txt', content: 'hello hatch\n第二行\n' }) },
                }],
              },
            }],
          });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
          send({ usage: { prompt_tokens: 60, completion_tokens: 10, total_tokens: 70 } });
        } else {
          const toolMsg = msgs.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
          send({ choices: [{ delta: { content: '搞定。工具回执：' + toolMsg.slice(0, 60).replace(/\n/g, ' ') } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          send({ usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
        }
        res.write('data: [DONE]\n\n');
        res.end();
        // 把工具名暴露给断言用
        global.__lastToolNames = toolNames;
        global.__lastMessages = msgs;
      });
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'workspace'), { recursive: true });
  const server = await startMock();
  const port = server.address().port;
  console.log('\n假模型服务: http://127.0.0.1:' + port + '/v1\n');

  store.init();
  store.saveSettings({
    model: { baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'mock-model' },
    approval: { mode: 'auto' },
  });

  // 运行日志：冒烟里也真开一份（默认不 init 就是关的），这样"整轮对话该产出哪些日志行"
  // 有断言兜底 —— 免得哪天埋点被误删，又要等出事时才发现没记录。日志写到 TMP 下，不碰仓库 logs/。
  const RUNLOG_DIR = path.join(TMP, 'logs');
  runlog.init({ dataDir: path.join(TMP, 'data'), logDir: RUNLOG_DIR });

  console.log('1) 数据层');
  const project = store.createProject('测试项目', path.join(TMP, 'workspace'));
  check('创建项目', !!project.id && fs.existsSync(project.cwd));
  const session = sessionLib.createSession({ projectId: project.id, name: '冒烟', programId: 'coder' });
  session.instruction = require('../core/prompts').PROMPTS.coder;
  check('创建会话（模块数 ' + session.modules.length + '）', session.modules.includes('fs') && session.modules.includes('shell'));

  console.log('\n2) 工具注册表');
  check('别名解析 shell_command', tools.resolveTool('shell_command') && tools.resolveTool('shell_command').module === 'shell');
  check('未知工具返回 null', tools.resolveTool('nope_tool') === null);
  const schemas = tools.schemasFor(['read_file_lines', 'write_file']);
  check('按别名生成 schema', schemas.length === 2 && schemas[0].type === 'function');
  check('工具数量 ' + tools.ALL.length, tools.ALL.length >= 12);

  console.log('\n3) 风险分类器');
  check('ls 是 low', classifyCommand('ls -la').risk === 'low');
  check('npm install 是 medium', classifyCommand('npm install left-pad').risk === 'medium');
  check('git reset --hard 是 high', classifyCommand('git reset --hard HEAD~3').risk === 'high');
  check('rm -rf / 是 too_destructive', classifyCommand('rm -rf /').risk === 'too_destructive');

  console.log('\n4) 完整一轮（流式 + 工具调用 + 落盘）');
  const events = [];
  const agent = new Agent({
    getSettings: () => store.getSettings(),
    emit: (ev) => events.push(ev),
    askUser: async () => ({ approved: true, note: '测试自动批准' }),
  });
  sessionLib.userMessage(session, '在 notes 目录建一个 hello.txt');
  const r = await agent.runTurn(session);
  check('runTurn 成功', r.ok === true, JSON.stringify(r));
  check('共调用模型 2 次', call === 2, '实际 ' + call);
  check('模型看到的工具里有 write_file', (global.__lastToolNames || []).includes('write_file'));
  check('第二轮消息里带上了 tool 结果', (global.__lastMessages || []).some((m) => m.role === 'tool'));
  check('文件已创建', fs.existsSync(path.join(project.cwd, 'notes', 'hello.txt')));
  check('文件内容正确', fs.readFileSync(path.join(project.cwd, 'notes', 'hello.txt'), 'utf8').startsWith('hello hatch'));
  const summary = session.entries.find((e) => e.type === 'turnSummary');
  check('写了 turnSummary', !!summary && summary.files.length === 1, JSON.stringify(summary && summary.files));
  check('summary 记录了新增行', summary && summary.files[0].added >= 2);
  check('推送了流式 delta 事件', events.some((e) => e.type === 'assistant:delta'));
  check('推送了工具开始/结束事件', events.some((e) => e.type === 'tool:start') && events.some((e) => e.type === 'tool:end'));
  check('推送了 turn:end', events.some((e) => e.type === 'turn:end'));

  // 4b) 早期抛错必须释放 running 锁，并且补发 turn:end。
  // 回归的是一个真实死锁：锁在原 try 之外就上了，而 getSettings() 抛错时 finally 跑不到 →
  // running 锁不释放 → 这个会话之后每次发送都被判成"正在运行中"，界面停在"运行中"再也发不出消息。
  const lockSession = { ...session, id: 'smoke-lock-' + Date.now(), entries: [...session.entries] };
  const lockEvents = [];
  const badAgent = new Agent({
    getSettings: () => { throw new Error('设置文件损坏（模拟）'); },
    emit: (ev) => lockEvents.push(ev),
    askUser: async () => ({ approved: true, note: '' }),
  });
  let lockRes = null;
  await badAgent.runTurn(lockSession).then((r) => { lockRes = r; }, () => { lockRes = 'rejected'; });
  check('getSettings 抛错被折成本轮的失败结果（而不是炸穿调用方）',
    lockRes && lockRes.ok === false && lockRes.reason === 'error', JSON.stringify(lockRes));
  check('错误落成会话里的 critical 记录（用户看得见）',
    lockSession.entries.some((e) => e.type === 'error' && e.critical === true));
  check('抛错后 running 锁被释放（否则该会话永久发不出消息）', badAgent.isRunning(lockSession.id) === false);
  check('抛错也会补发 turn:end（界面才能从"运行中"复位）', lockEvents.some((e) => e.type === 'turn:end'));

  // 用量：累计 ≠ 上下文占用，两个都要对（meta 挂在 session:update 上）
  const meta = (events.filter((e) => e.type === 'session:update').pop() || {}).meta;
  const u = (meta && meta.usage) || {};
  check('usage 记了 2 次调用', u.calls === 2, JSON.stringify(u));
  check('usage 累计输入 = 60+100', u.promptTokens === 160, String(u.promptTokens));
  check('usage 累计输出 = 10+20', u.completionTokens === 30, String(u.completionTokens));
  check('lastPromptTokens 是最后一次的 100（上下文占用）', u.lastPromptTokens === 100, String(u.lastPromptTokens));
  check('lastCompletionTokens 是最后一次的 20', u.lastCompletionTokens === 20, String(u.lastCompletionTokens));

  // 4c) 运行日志。
  // 这是"请求停不下来"那类问题唯一的事后依据 —— 出事时磁盘上必须已经有一份完整记录，
  // 不能等到复盘时才发现埋点被删了/写歪了。所以这里对**日志的产出**做断言，而不是只测函数返回。
  console.log('\n4c) 运行日志（事后排障的唯一依据）');
  const runLogFile = runlog.logFile();
  check('日志文件名按天分：run-YYYY-MM-DD.log',
    /run-\d{4}-\d{2}-\d{2}\.log$/.test(runLogFile || ''), String(runLogFile));
  const logLines = (runLogFile && fs.existsSync(runLogFile) ? fs.readFileSync(runLogFile, 'utf8') : '')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));   // 顺便验证每行都是合法 JSON
  const kinds = logLines.map((l) => l.kind);
  check('写了 app.start（能看出是哪次启动、什么运行时）',
    logLines.some((l) => l.kind === 'app.start' && l.pid), JSON.stringify(kinds));
  check('轮次边界记了起止', kinds.filter((k) => k === 'turn').length >= 2, JSON.stringify(kinds));
  check('模型请求记了发起与开销', kinds.includes('model.start') && kinds.includes('model.call'), JSON.stringify(kinds));

  const mc = logLines.filter((l) => l.kind === 'model.call');
  check('每次模型调用都有耗时与 token（共 2 次）',
    mc.length === 2 && mc.every((l) => typeof l.durationMs === 'number' && l.ok === true),
    JSON.stringify(mc));
  check('模型开销的 token 数正确（末次 100 / 20）',
    !!mc[1] && mc[1].promptTokens === 100 && mc[1].completionTokens === 20, JSON.stringify(mc[1] || null));

  const tc = logLines.filter((l) => l.kind === 'tool.call');
  check('工具调用记了名称、耗时、成功状态（★ 成功也记，不只记失败）',
    tc.length === 1 && tc[0].tool === 'write_file' && typeof tc[0].durationMs === 'number' && tc[0].ok === true,
    JSON.stringify(tc));
  check('工具调用记了参数（复盘时要知道它拿什么去调的）',
    !!tc[0] && !!tc[0].args && tc[0].args.relativePath === 'notes/hello.txt', JSON.stringify(tc[0] && tc[0].args));
  check('失败才带 error 字段，成功时为 undefined（不塞无意义字段）',
    !!tc[0] && tc[0].error === undefined);

  // 脱敏：密钥绝不能落进日志文件（它是纯文本、还可能被随手发出去）
  runlog.log('probe.secret', { apiKey: 'sk-abcdef1234567890', nested: { authorization: 'Bearer topsecret' } });
  const logText = fs.readFileSync(runLogFile, 'utf8');
  check('密钥被脱敏，不落盘',
    !logText.includes('sk-abcdef1234567890') && !logText.includes('topsecret') && logText.includes('***7890'),
    logText.split('\n').filter((l) => l.includes('probe.secret')).join(''));

  // 关掉后不能再写（测试环境可整体关闭）
  process.env.HATCH_RUN_LOG = '0';
  const offInit = runlog.init({ logDir: RUNLOG_DIR });
  const beforeOff = fs.readFileSync(runLogFile, 'utf8').split('\n').filter(Boolean).length;
  runlog.log('should.not.appear', { x: 1 });
  const offText = fs.readFileSync(runLogFile, 'utf8');
  check('HATCH_RUN_LOG=0 时不写任何东西（init 返回 false，isEnabled 为假）',
    offInit === false && runlog.isEnabled() === false
      && !offText.includes('should.not.appear')
      && offText.split('\n').filter(Boolean).length === beforeOff,
    'init=' + offInit + ' 行数 ' + beforeOff + ' → ' + offText.split('\n').filter(Boolean).length);
  delete process.env.HATCH_RUN_LOG;

  console.log('\n5) 检查点与回滚');
  const log = checkpoints.readLog(project.id);
  check('检查点日志有记录', log.length >= 1, '条数 ' + log.length);
  check('记录类型是 absent（新建文件）', log[0].kind === 'absent');
  const userEntry = session.entries.find((e) => e.type === 'message' && e.role === 'user');
  const rb = checkpoints.rollbackTo(project.id, session.id, userEntry.ts);
  check('回滚删掉了新建文件', rb.deleted.length === 1 && !fs.existsSync(path.join(project.cwd, 'notes', 'hello.txt')), JSON.stringify(rb));

  // 用户报过的那条：恢复之后再点一次「恢复」→
  //   ERR_INVALID_ARG_TYPE: The "path" argument must be of type string. Received null
  // 根因：revertFile 取"最后一条记录"，而恢复动作自己也写一条 kind:'restored'、sha:null
  // 的记录，null 被当 blob 文件名喂给 path.join 就炸了。改成只认 snapshot 写的记录
  // （absent / modified），顺带变成幂等。
  const helloPath = path.join(project.cwd, 'notes', 'hello.txt');
  const tailRec = checkpoints.listForPath(project.id, helloPath).slice(-1)[0];
  check('回滚后该路径最后一条记录是 restored 且 sha 为 null（就是崩的那条）',
    !!tailRec && tailRec.kind === 'restored' && tailRec.sha === null, JSON.stringify(tailRec));
  const revertAgain = checkpoints.revertFile(project.id, session.id, helloPath);
  check('再点一次「恢复」不抛异常（幂等）', revertAgain.ok === true, JSON.stringify(revertAgain));
  const nullPath = checkpoints.revertFile(project.id, session.id, null);
  check('路径传 null 时给可读错误而不是抛异常', nullPath.ok === false && !!nullPath.message, JSON.stringify(nullPath));
  const fList = checkpoints.listFiles(project.id);
  check('listFiles 每个文件一行、不含 restored，并带改动次数',
    fList.length === 1 && fList[0].path === helloPath && fList[0].changes === 1 && fList[0].kind === 'absent',
    JSON.stringify(fList));
  check('listRecent 也已经滤掉没有路径的坏记录', checkpoints.listRecent(project.id).every((r) => typeof r.path === 'string' && r.path));

  // 目录被删掉过时，恢复要能把目录补回来（否则 copyFileSync 直接 ENOENT，
  // 又会以 "操作失败：Error invoking remote method …" 的形式糊到用户脸上）
  {
    const dir2 = path.join(project.cwd, 'deep', 'nested');
    fs.mkdirSync(dir2, { recursive: true });
    const f3 = path.join(dir2, 'note.txt');
    fs.writeFileSync(f3, 'BEFORE-DIR-DELETE');
    checkpoints.snapshot(project.id, session.id, f3);          // 记下"改动前"的内容
    fs.writeFileSync(f3, 'AFTER');
    fs.rmSync(path.join(project.cwd, 'deep'), { recursive: true, force: true });   // 整个目录没了
    const r3 = checkpoints.revertFile(project.id, session.id, f3);
    check('目录被删掉过也能恢复（会补建目录）',
      r3.ok === true && fs.existsSync(f3) && fs.readFileSync(f3, 'utf8') === 'BEFORE-DIR-DELETE', JSON.stringify(r3));
  }

  // 构造一段"只恢复过、没改过"的坏日志：第一条就是 restored（sha null）。
  // 老代码的 rollbackTo 会拿它当 baseline → 同样 path.join(dir, null) 抛错。
  {
    const p2 = store.createProject('坏日志项目', path.join(TMP, 'workspace2'));
    const f2 = path.join(p2.cwd, 'x.txt');
    const cpDir = path.join(store.projectDir(p2.id), 'checkpoints');
    fs.mkdirSync(cpDir, { recursive: true });
    fs.writeFileSync(
      path.join(cpDir, 'log.jsonl'),
      [
        JSON.stringify({ ts: 1, projectId: p2.id, sessionId: 's', path: f2, kind: 'restored', sha: null, size: 0 }),
        JSON.stringify({ ts: 2, projectId: p2.id, sessionId: 's', path: f2, kind: 'modified', sha: null, size: 0 }),
        '',
      ].join('\n')
    );
    let rb2 = null;
    let threw = null;
    try { rb2 = checkpoints.rollbackTo(p2.id, 's', 0); } catch (e) { threw = e.message; }
    check('日志里混着 restored / sha 为 null 的坏记录时，回滚也不炸（记为跳过）',
      threw === null && rb2 && rb2.skipped.length === 1, { threw, rb2 });
  }

  console.log('\n6) 会话持久化与分叉');
  store.saveSession(project.id, session);
  const list = store.listSessions(project.id);
  check('会话出现在列表', list.some((s) => s.id === session.id));
  const loaded = store.loadSession(project.id, session.id);
  check('重新读取事件数一致', loaded.entries.length === session.entries.length);
  const forked = sessionLib.forkSession(loaded, loaded.entries[0].id);
  check('分叉得到更短的日志', forked.entries.length <= loaded.entries.length && forked.id !== loaded.id);

  // ⚠️ 这一段**故意留着这张表`deleteProject` 的语义**：删除项目 = 只摘索引。
  // 用户要的就是这个（"删除对话只是删除这个对话索引"），所以断言必须钉住"磁盘什么都不删"，
  // 否则以后有人顺手加个 rmSync 就会把用户的会话记录和检查点一起带走。
  console.log('\n6b) 删除项目 = 只摘索引（磁盘一律不删）');
  {
    // 造一个"工作目录在自己真实目录里"的项目：这是最危险的那种（用户选的目录不是我们的）
    const outside = path.join(TMP, 'user-owned-dir');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'user-file.txt'), '用户的文件');
    const victim = store.createProject('待删除项目', outside);
    const vSess = sessionLib.createSession({ projectId: victim.id, name: '待删会话', programId: 'coder' });
    vSess.instruction = require('../core/prompts').PROMPTS.coder;
    store.saveSession(victim.id, vSess);
    const vDir = store.projectDir(victim.id);
    const vSessionFile = store.sessionFile(victim.id, vSess.id);
    check('删除前：项目目录与会话文件都在', fs.existsSync(vDir) && fs.existsSync(vSessionFile), { vDir });

    const info = store.projectDeleteInfo(victim.id);
    check('deleteInfo 报出会话数与工作目录', info && info.sessionCount === 1 && info.cwd === outside,
      info && JSON.stringify({ n: info.sessionCount, cwd: info.cwd }));
    check('deleteInfo 认出工作目录在项目目录之外（=用户自己的目录）',
      info && info.cwdInsideProjectDir === false, info && info.cwdInsideProjectDir);

    // 自动生成的 workspace 那种（cwd 就在项目目录里）也要判对
    const autoProj = store.createProject('自动 workspace 项目', null);
    const autoInfo = store.projectDeleteInfo(autoProj.id);
    check('deleteInfo 认出自动创建的 workspace（在项目目录里）',
      autoInfo && autoInfo.cwdInsideProjectDir === true, autoInfo && JSON.stringify({ cwd: autoInfo.cwd, dir: autoInfo.projectDir }));

    const okDel = store.deleteProject(victim.id);
    check('deleteProject 返回 true', okDel === true);
    check('项目从列表里消失', !store.listProjects().some((p) => p.id === victim.id));
    check('getProject 也读不到了', store.getProject(victim.id) === null);
    check('deleteProject 幂等：删第二次返回 false', store.deleteProject(victim.id) === false);

    // ★ 核心三条：磁盘上什么都不许少
    check('★ 记录目录仍然在（会话/检查点都保留）', fs.existsSync(vDir), vDir);
    check('★ 会话记录文件仍然在', fs.existsSync(vSessionFile), vSessionFile);
    check('★ 用户的工作目录与里面的文件一根汗毛都没动',
      fs.existsSync(outside) && fs.readFileSync(path.join(outside, 'user-file.txt'), 'utf8') === '用户的文件', outside);
    check('会话仍然能被读出来（索引没了但内容还在）',
      (store.listSessions(victim.id) || []).some((s) => s.id === vSess.id));

    // 不能误伤别的项目
    check('别的项目不受影响（原测试项目还在）', store.listProjects().some((p) => p.id === project.id));
    check('deleteInfo 对不存在的项目返回 null', store.projectDeleteInfo('nope-id-xxx') === null);
    store.deleteProject(autoProj.id);   // 收尾：别把自动 workspace 那个项目留在列表里影响后面
  }

  console.log('\n7) 审批闸门');
  const shellTool = tools.resolveTool('shell_command');
  const g1 = await approvals.gate(store.getSettings(), { tool: shellTool, args: { command: 'ls' }, session });
  check('低风险命令直接放行', g1.action === 'allow' && g1.risk === 'low', JSON.stringify(g1));
  const settingsAuto = store.saveSettings({ approval: { mode: 'auto' } });
  const g2 = await approvals.gate(settingsAuto, { tool: shellTool, args: { command: 'rm -rf /' }, session });
  check('极高危命令被拒（auto 模式）', g2.action === 'deny', JSON.stringify(g2));
  store.saveSettings({ approval: { mode: 'always-ask' } });
  const g3 = await approvals.gate(store.getSettings(), { tool: shellTool, args: { command: 'git push --force' }, session });
  check('高风险命令要求人工确认', g3.action === 'ask', JSON.stringify(g3));
  check('always-ask 也先把评审意见取回来（人要有依据再拍板）', g3.reviewer && g3.reviewer.ok === true, JSON.stringify(g3.reviewer));
  const fsTool = tools.resolveTool('write_file');
  const g4 = await approvals.gate(store.getSettings(), { tool: fsTool, args: { relativePath: 'a.txt', content: 'x' }, session });
  // 「每次询问」是用户明选的模式，不能被"项目内文件改动直接放行"越过 ——
  // 否则最常见的写文件恰好都是 fs 模块，全被静默放行，用户等于没被问过。
  check('always-ask 下项目内写文件也要问人', g4.action === 'ask' && g4.risk === 'medium', JSON.stringify(g4));
  const settingsReviewer = store.saveSettings({ approval: { mode: 'reviewer' } });
  const g5 = await approvals.gate(settingsReviewer, { tool: fsTool, args: { relativePath: 'a.txt', content: 'x' }, session });
  check('reviewer 模式下项目内写文件不打扰用户', g5.action === 'allow', JSON.stringify(g5));

  console.log('\n7b) 评审子会话（三轴）');
  store.saveSettings({ approval: { mode: 'reviewer' } });
  // parseResult 的边界：没有 <result>、或 JSON 里没有三轴键，都算解析失败
  check('parseResult 认 <result> 块', JSON.stringify(approvals.parseResult('<result>{"risk":"high","correct":false}</result>')) === '{"risk":"high","correct":false}');
  check('parseResult 拒绝无关 JSON', approvals.parseResult('看到 {"foo":1} 这样的东西') === null);
  check('parseResult 拒绝纯文本', approvals.parseResult('我觉得没问题') === null);
  check('parseResult 容忍前后闲聊', approvals.parseResult('分析如下：\n<result>{"risk":"low","authorization":"neutral","correct":true}</result>\n完毕') !== null);

  // 评审会自己调只读工具取证，再出裁决
  const gRev = await approvals.gate(store.getSettings(), {
    tool: shellTool,
    args: { command: 'npm install REVIEW_READ' },
    session,
  });
  check('reviewer 模式：中等风险命令交给评审', !!gRev.reviewer, JSON.stringify(gRev));
  check('评审拿到了只读工具', (global.__lastReviewTools || []).length === 3 && (global.__lastReviewTools || []).includes('read_file_lines'), JSON.stringify(global.__lastReviewTools));
  check('评审出了可解析的裁决', gRev.reviewer && gRev.reviewer.ok === true, JSON.stringify(gRev.reviewer));
  check('评审多步后仍收敛', gRev.reviewer && gRev.reviewer.steps <= 4, String(gRev.reviewer && gRev.reviewer.steps));
  check('三轴裁决 → 放行', gRev.action === 'allow', JSON.stringify(gRev));

  // 评审坏了：默认必须转人工，而不是默默放行
  const gFail = await approvals.gate(store.getSettings(), {
    tool: shellTool,
    args: { command: 'npm install REVIEW_FAIL' },
    session,
  });
  check('评审输出无法解析 → 转人工（失败安全）', gFail.action === 'ask' && gFail.reviewerFailed === true, JSON.stringify(gFail));
  const allowOnFail = store.saveSettings({ approval: { onReviewerFailure: 'allow' } });
  const gFail2 = await approvals.gate(allowOnFail, {
    tool: shellTool,
    args: { command: 'npm install REVIEW_FAIL' },
    session,
  });
  check('设成 allow 时才放行', gFail2.action === 'allow', JSON.stringify(gFail2));
  store.saveSettings({ approval: { onReviewerFailure: 'ask' } });

  console.log('\n8) 上下文渲染');
  const msgs = sessionLib.renderMessages(session);
  check('第一条是 system', msgs[0].role === 'system' && msgs[0].content.includes('One Harness'));
  check('system 里带环境块', msgs[0].content.includes('<environment>'));
  check('assistant 消息带 tool_calls', msgs.some((m) => m.role === 'assistant' && m.tool_calls));
  check('tool 消息带 tool_call_id', msgs.some((m) => m.role === 'tool' && m.tool_call_id));

  // 闸门的决定要跟着工具结果一起落盘，否则刷新界面后卡片上就看不到「谁放行的」
  const toolRows = sessionLib.renderTranscript(session).filter((r) => r.kind === 'tool');
  check('工具结果里记了闸门决定', toolRows.length > 0 && !!toolRows[0].decision, JSON.stringify(toolRows[0] && toolRows[0].decision));
  check('决定里有 action 与 risk', !!(toolRows[0].decision && toolRows[0].decision.action && toolRows[0].decision.risk), JSON.stringify(toolRows[0] && toolRows[0].decision));

  console.log('\n9) 布局状态（ui-state/*.json）');
  const uistate = require('../core/uistate');
  const uiGlobal0 = uistate.readGlobal();
  check('global 有默认窗口 bounds', uiGlobal0.lastActiveWindowBounds.width === 1360 && uiGlobal0.lastActiveWindowBounds.x === null, JSON.stringify(uiGlobal0.lastActiveWindowBounds));
  const w0 = uistate.readWindow('main');
  check('窗口默认左栏 220 / 右栏 345', w0.workspace.leftSidebarWidth === 220 && w0.workspace.rightPanelWidth === 345);
  check('窗口默认右栏视图是 devRightPanelView=files（名字照抄 Bionic）', w0.workspace.devRightPanelView === 'files');
  check('面板块叫 workspace（对应 Bionic 的 bionic 段）', !!w0.workspace && w0.projectIdentifier === null);
  check('当前项目在顶层 windowContext.activeProjectIdentifier（Bionic 的形状）',
    !!w0.windowContext && w0.windowContext.type === 'workspace' && w0.windowContext.activeProjectIdentifier === null && Array.isArray(w0.windowContext.projectIdentifiers));
  check('global 里没有 expandedKvConfigSections（Bionic 把它放在 window 层）',
    !('expandedKvConfigSections' in uistate.readGlobal()) && Array.isArray(w0.expandedKvConfigSections));

  const w1 = uistate.patchWindow('main', {
    workspace: { leftSidebarWidth: 10, rightPanelWidth: 9999, devRightPanelView: 'tools', leftSidebarIsCollapsed: true },
    windowContext: { type: 'workspace', projectIdentifiers: ['p1', 'p2'], activeProjectIdentifier: 'p2' },
  });
  check('越界宽度被夹回合法区间', w1.workspace.leftSidebarWidth === 168 && w1.workspace.rightPanelWidth === 640, JSON.stringify(w1.workspace));
  check('折叠状态与视图写进去了', w1.workspace.leftSidebarIsCollapsed === true && w1.workspace.devRightPanelView === 'tools');
  check('windowContext 写进去了', w1.windowContext.activeProjectIdentifier === 'p2' && w1.windowContext.projectIdentifiers.length === 2);

  // 旧字段名要能迁移（对齐 Bionic 时改过名，不能让用户已有的布局白丢）
  const wOld = uistate.patchWindow('legacy', { workspace: { rightPanelView: 'tools', activeProjectId: 'proj-x' } });
  check('旧名 rightPanelView 自动迁到 devRightPanelView',
    wOld.workspace.devRightPanelView === 'tools' && !('rightPanelView' in wOld.workspace), JSON.stringify(wOld.workspace));
  check('旧名 workspace.activeProjectId 自动迁到 windowContext',
    wOld.windowContext.activeProjectIdentifier === 'proj-x' && !('activeProjectId' in wOld.workspace));

  const rf = uistate.windowFile('main');
  check('布局文件按 window-<key>.json 命名', path.basename(rf) === 'window-main.json', path.basename(rf));
  const onDisk = JSON.parse(fs.readFileSync(rf, 'utf8'));
  check('重新读盘拿到同样的值', onDisk.workspace.leftSidebarWidth === 168 && onDisk.workspace.devRightPanelView === 'tools');

  uistate.saveWindowBounds({ x: 12, y: 34, width: 1200, height: 800 });
  const uiGlobal1 = uistate.readGlobal();
  check('窗口几何落到 global.lastActiveWindowBounds', uiGlobal1.lastActiveWindowBounds.x === 12 && uiGlobal1.lastActiveWindowBounds.width === 1200, JSON.stringify(uiGlobal1.lastActiveWindowBounds));
  const again = uistate.saveWindowBounds({ x: 12, y: 34, width: 1200, height: 800 });
  check('几何没变时不重复写', again.width === 1200);

  uistate.registerWindow('second');
  check('registerWindow 登记窗口键并建文件', uistate.readGlobal().openedWindowKeys.includes('second') && fs.existsSync(uistate.windowFile('second')));
  uistate.removeWindow('second');
  check('removeWindow 收拾干净', !fs.existsSync(uistate.windowFile('second')) && !uistate.readGlobal().openedWindowKeys.includes('second'));

  server.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常：', e);
  process.exit(1);
});
