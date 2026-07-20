#!/usr/bin/env node
// P3 (#381): 合流后自动冒烟脚本。取代"宪宪每次重启后人肉核一遍"的手工流程。
// 每一项检查的是"这个子系统真的活着"，不是"HTTP 200"——具体标准见各 section 注释。
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');

function readEnvValue(key, fallback) {
  const envFile = resolve(projectRoot, '.env');
  if (!existsSync(envFile)) return fallback;
  const lines = readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || match[1] !== key) continue;
    return match[2].replace(/^['"]|['"]$/g, '') || fallback;
  }
  return fallback;
}

const frontendPort = Number(readEnvValue('FRONTEND_PORT', '3003'));
const apiPort = Number(readEnvValue('API_SERVER_PORT', '3004'));
const apiBearerToken = process.env.CLOWDER_API_BEARER_TOKEN || readEnvValue('CLOWDER_API_BEARER_TOKEN', '');
const redisUrl = process.env.REDIS_URL || readEnvValue('REDIS_URL', 'redis://localhost:6399');
const redisKeyPrefix = process.env.REDIS_KEY_PREFIX || readEnvValue('REDIS_KEY_PREFIX', 'cat-cafe:');
const uploadDirSetting = readEnvValue('UPLOAD_DIR', '');
const effectiveUploadDir =
  uploadDirSetting === './uploads'
    ? resolve(projectRoot, 'packages/api/uploads')
    : resolve((uploadDirSetting || '~/.cat-cafe/uploads').replace(/^~(?=$|\/)/, homedir()));

const SMOKE_USER_ID = 'default-user';

// results: 'ok' | 'warn' (通过但降级/需人看) | 'err' (硬失败)
const results = [];

function add(status, label, detail = '') {
  results.push({ status: status === true ? 'ok' : status === false ? 'err' : status, label, detail });
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function listenerPid(port) {
  const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
  return out.split(/\s+/).filter(Boolean)[0] || '';
}

function cwdOfPid(pid) {
  if (!pid) return '';
  const out = run('lsof', ['-p', pid]);
  const line = out.split(/\r?\n/).find((entry) => /\scwd\s/.test(entry));
  if (!line) return '';
  return line.trim().split(/\s+/).at(-1) || '';
}

async function fetchJson(url, init = {}) {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        // 无 Origin 的非浏览器请求走 X-Cat-Cafe-User（request-identity.ts 的 non-browser
        // 分支），跟 mark-all/read-ack 这类没有 defaultUserId 便利兜底的端点对齐。
        'x-cat-cafe-user': SMOKE_USER_ID,
        ...(apiBearerToken && url.includes('/api/') ? { authorization: `Bearer ${apiBearerToken}` } : {}),
        ...init.headers,
      },
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, text, body };
  } catch (err) {
    return { ok: false, status: 0, text: String(err), body: undefined };
  }
}

// ---------------------------------------------------------------------------
// 结构性检查（进程/文件系统）——未改动
// ---------------------------------------------------------------------------

const webPid = listenerPid(frontendPort);
const apiPid = listenerPid(apiPort);
const webCwd = cwdOfPid(webPid);
const apiCwd = cwdOfPid(apiPid);

add(Boolean(webPid), `Web 端口 ${frontendPort}`, webPid ? `pid=${webPid}` : '未监听');
add(Boolean(apiPid), `API 端口 ${apiPort}`, apiPid ? `pid=${apiPid}` : '未监听');
add(webCwd.startsWith(projectRoot), 'Web 启动目录', webCwd || '无法识别');
add(apiCwd.startsWith(projectRoot), 'API 启动目录', apiCwd || '无法识别');

const envPath = resolve(projectRoot, '.env');
const catalogPath = resolve(projectRoot, '.cat-cafe/cat-catalog.json');
const legacyUploadsPath = resolve(projectRoot, 'packages/api/uploads');
const uploadsPath = effectiveUploadDir;
add(existsSync(envPath), '.env', existsSync(envPath) ? '存在' : '缺失');
add(existsSync(catalogPath), '.cat-cafe/cat-catalog.json', existsSync(catalogPath) ? '存在' : '缺失');
add(
  existsSync(legacyUploadsPath) && lstatSync(legacyUploadsPath).isSymbolicLink(),
  'packages/api/uploads symlink',
  existsSync(legacyUploadsPath) ? `${legacyUploadsPath} -> ${uploadsPath}` : '缺失',
);
add(
  existsSync(uploadsPath),
  'uploads 目录',
  existsSync(uploadsPath) ? `${readdirSync(uploadsPath).length} 个条目：${uploadsPath}` : `缺失：${uploadsPath}`,
);

if (existsSync(catalogPath)) {
  try {
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    const rosterCount = Array.isArray(catalog.roster)
      ? catalog.roster.length
      : Object.keys(catalog.roster || {}).length;
    add(rosterCount > 0, '本地 Agent catalog', `${rosterCount} 个 roster 条目`);
  } catch (err) {
    add(false, '本地 Agent catalog', `解析失败：${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// 1. ready — 不只信 HTTP 200，读 body 断言 status==='ready'，checks 明细全打印
// ---------------------------------------------------------------------------

const ready = await fetchJson(`http://localhost:${apiPort}/api/ready`);
if (!ready.body) {
  add(
    false,
    '/api/ready',
    ready.ok ? 'HTTP 200 但 body 不是合法 JSON' : `HTTP ${ready.status}: ${ready.text.slice(0, 200)}`,
  );
} else {
  add(ready.body.status === 'ready', '/api/ready', `status=${ready.body.status}`);
  for (const [name, check] of Object.entries(ready.body.checks ?? {})) {
    add(check.ok, `  ready check: ${name}`, `${check.ms}ms${check.error ? ` — ${check.error}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 2. cats — 非空 + 结构校验（每条有 id，防止空对象数组骗过 length>0）
// ---------------------------------------------------------------------------

const cats = await fetchJson(`http://localhost:${apiPort}/api/cats`);
const catList = Array.isArray(cats.body) ? cats.body : (cats.body?.cats ?? cats.body?.data ?? []);
if (!cats.ok || !Array.isArray(catList)) {
  add(false, '/api/cats', cats.ok ? 'JSON 形状不是数组/{cats:[]}' : `HTTP ${cats.status}: ${cats.text.slice(0, 200)}`);
} else {
  add(catList.length > 0, '/api/cats', `${catList.length} 个 Agent`);
  const withoutId = catList.filter((c) => !c || typeof c.id !== 'string' || c.id.length === 0);
  add(
    catList.length === 0 || withoutId.length === 0,
    '/api/cats 结构',
    withoutId.length > 0 ? `${withoutId.length} 条缺 id（空对象充数）` : '每条都有 id',
  );
}

// ---------------------------------------------------------------------------
// 3. web — 真渲染检查：headless 打开首页，挂 pageerror/console.error 监听，
//    等一个只有真 hydration 才会出现的 DOM 标记。无 Chromium 时降级回裸 HTML
//    检查，但显眼标注"降级模式"，不悄悄放行。
// ---------------------------------------------------------------------------

// 注意：不要选 [data-testid="mark-all-read-btn"] 这类依赖瞬时数据状态（unreadIds.size>0）
// 才渲染的元素当标记——那是"内容对不对"的信号，不是"hydration 有没有崩"的信号，选错
// 会制造假红（本地已踩过一次：正常无未读时按钮不渲染，被误判成 hydration 崩）。
// sidebar.new-thread 是无条件渲染的核心控件（ThreadSidebar.tsx 头部），只要 hydration
// 没崩、数据没崩就一定在。
const HYDRATION_MARKER_SELECTOR = '[data-guide-id="sidebar.new-thread"]';
const NEXT_CRASH_TEXT = 'Application error: a client-side exception has occurred';

async function checkWebRender() {
  let puppeteer;
  try {
    ({ default: puppeteer } = await import('puppeteer'));
  } catch {
    return { degraded: true, reason: 'puppeteer 未安装' };
  }

  let browser;
  const launchOpts = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] };
  try {
    browser = await puppeteer.launch(launchOpts);
  } catch (primaryErr) {
    // puppeteer 自管的 Chromium 不一定装了；本机若有系统 Chrome，退而用它，
    // 不算"降级"（这条路径依然是真 headless 渲染，只是换一个可执行文件）。
    try {
      browser = await puppeteer.launch({ ...launchOpts, channel: 'chrome' });
    } catch (fallbackErr) {
      return {
        degraded: true,
        reason: `puppeteer 自带 Chromium 与系统 Chrome 均不可用：${primaryErr.message} / ${fallbackErr.message}`,
      };
    }
  }

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    let navError = null;
    try {
      await page.goto(`http://localhost:${frontendPort}/`, { waitUntil: 'networkidle0', timeout: 20000 });
    } catch (err) {
      navError = String(err);
    }

    let markerFound = false;
    if (!navError) {
      try {
        await page.waitForSelector(HYDRATION_MARKER_SELECTOR, { timeout: 10000 });
        markerFound = true;
      } catch {
        markerFound = false;
      }
    }

    const bodyText = navError ? '' : await page.evaluate(() => document.body.innerText).catch(() => '');
    const hasCrashText = bodyText.includes(NEXT_CRASH_TEXT);

    return {
      degraded: false,
      navError,
      markerFound,
      hasCrashText,
      pageErrors,
      consoleErrors,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

const webRender = await checkWebRender();
if (webRender.degraded) {
  // 显眼标注：这不是"web 检查通过"，是"没条件做真检查，退回裸 HTML"
  add('warn', 'Web 首页（真渲染）', `【降级模式】${webRender.reason}，退回裸 HTML 检查（不能证明 hydration 未崩）`);
  const html = await fetchJson(`http://localhost:${frontendPort}/`);
  add(html.ok, 'Web 首页（降级：仅 HTTP）', html.ok ? `HTTP ${html.status}` : html.text.slice(0, 200));
} else {
  add(
    !webRender.navError && webRender.markerFound && !webRender.hasCrashText && webRender.pageErrors.length === 0,
    'Web 首页（真渲染）',
    webRender.navError
      ? `导航失败：${webRender.navError}`
      : webRender.hasCrashText
        ? 'Next.js 客户端崩溃页命中'
        : webRender.pageErrors.length > 0
          ? `${webRender.pageErrors.length} 个 pageerror：${webRender.pageErrors[0]}`
          : webRender.markerFound
            ? `hydration 标记 ${HYDRATION_MARKER_SELECTOR} 已出现，0 pageerror`
            : `hydration 标记 ${HYDRATION_MARKER_SELECTOR} 超时未出现`,
  );
  if (webRender.consoleErrors.length > 0) {
    add(
      'warn',
      'Web 首页 console.error',
      `${webRender.consoleErrors.length} 条（非致命，记录供排查）：${webRender.consoleErrors[0]}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4+5. message round-trip + read-state/cursor 管道
//
// 卡点（已跟 @专家-Claude 对齐 2026-07-21）：POST /api/messages 无论是否 @人都会
// resolveTargets() 兜底到 getDefaultCatId() 真实唤起一只 agent（AgentRouter.ts:675）。
// 冒烟脚本若每次跑都走这个公共端点，就是每次合流后都真烧一次额度+冒一条噪音回复——
// 现在 codex/kimi 才刚为额度撞墙，自动化不该再加一个隐性消耗源。
//
// 因此：写入这一步绕开公共 POST 端点，直接用运行中同一个 Redis 实例走仓库真实的
// RedisMessageStore/RedisThreadStore（dist 里现成的类，非 mock）——只做"存储写"，
// 不触发 agent。读回这一步 100% 走真实 GET /api/messages HTTP 端点（历史上真出过
// bug 的地方：分页游标/可见性过滤/thread 归属）。
//
// unread 真注入需要一条 cat/connector 身份消息（RedisThreadReadStateStore 只认
// catId!==null || source 的消息），而唯一公开入口 /api/callbacks/post-message 要
// agent-key principal——置备一次性 smoke-test agent-key 等于往回扩我们这整个
// session 都在收紧的凭证/权限面。所以这里【不做真实未读注入】，只验证已读回执/
// 游标链路本身（ack 单调 CAS + mark-all 批量推进）——诚实标注，不冒充"真未读过关"。
//
// 清理：专用带标记 smoke 线程，写入的消息 + 线程本身在 finally 里硬删除
// （messageStore.deleteByThread + threadStore.delete，非 soft-delete），
// 不在 prod redis 留孤儿数据，即使中途抛错也会走到 finally。
// ---------------------------------------------------------------------------

const SMOKE_THREAD_TITLE = '🔍 smoke-test（自动冒烟，请忽略，脚本会自动清理）';

/**
 * 硬要求（专家-Claude）：即使脚本中途被信号打断（Ctrl+C/父进程杀掉），也不能在 prod
 * redis 留孤儿 smoke 线程/消息——不只靠 try/finally 兜正常异常路径，也挂 SIGINT/SIGTERM。
 * 返回 { cleanup, unregister, setThread }：finally 里调 cleanup() + unregister()。
 */
function registerCrashCleanup(messageStore, threadStore, redis) {
  let thread;
  let cleanedUp = false;
  const cleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      if (thread) {
        await messageStore.deleteByThread(thread.id);
        await threadStore.delete(thread.id);
      }
    } catch {
      /* best-effort — process is already tearing down */
    } finally {
      redis.disconnect();
    }
  };
  const onSignal = () => {
    void cleanup().finally(() => process.exit(1));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return {
    setThread: (t) => {
      thread = t;
    },
    cleanup,
    unregister: () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    },
  };
}

/** 写走 messageStore（零 agent 触发），读走真实 GET /api/messages —— 断言原样读回。 */
async function checkMessageRoundTrip(apiPort, threadId, messageId, expectedContent) {
  const readBack = await fetchJson(
    `http://localhost:${apiPort}/api/messages?threadId=${encodeURIComponent(threadId)}&limit=10`,
  );
  const echoed = readBack.body?.messages?.find((m) => m.id === messageId);
  return {
    ok: readBack.ok && Boolean(echoed) && echoed.content === expectedContent,
    label: 'message round-trip',
    detail: !readBack.ok
      ? `GET /api/messages 失败：HTTP ${readBack.status}`
      : !echoed
        ? '写入的消息未出现在真实 GET /api/messages 读回结果里'
        : echoed.content !== expectedContent
          ? '读回内容与写入不一致'
          : `写入 id=${messageId} 100% 经真实 HTTP 端点读回一致（写入绕开公共 POST 端点，避免每次冒烟真实唤起 agent 烧额度）`,
  };
}

/** PATCH .../read 到 upToMessageId，再用真实 GET /api/threads 读回 lastReadMessageId。 */
async function ackThreadRead(apiPort, threadId, upToMessageId) {
  const ack = await fetchJson(`http://localhost:${apiPort}/api/threads/${encodeURIComponent(threadId)}/read`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upToMessageId }),
  });
  const threads = await fetchJson(
    `http://localhost:${apiPort}/api/threads?q=${encodeURIComponent(SMOKE_THREAD_TITLE)}`,
  );
  const state = threads.body?.threads?.find((t) => t.id === threadId);
  return { ackOk: ack.ok, ackStatus: ack.status, lastReadMessageId: state?.lastReadMessageId };
}

async function runMessageAndReadStatePipeline() {
  const distMessageStorePath = resolve(
    projectRoot,
    'packages/api/dist/domains/cats/services/stores/redis/RedisMessageStore.js',
  );
  const distThreadStorePath = resolve(
    projectRoot,
    'packages/api/dist/domains/cats/services/stores/redis/RedisThreadStore.js',
  );
  if (!existsSync(distMessageStorePath) || !existsSync(distThreadStorePath)) {
    return {
      skipped: true,
      reason: 'packages/api 未构建（dist 缺失 RedisMessageStore/RedisThreadStore），跳过 message/read-state 检查',
    };
  }

  const [{ createRedisClient }, { RedisMessageStore }, { RedisThreadStore }] = await Promise.all([
    import('@cat-cafe/shared/utils'),
    import(distMessageStorePath),
    import(distThreadStorePath),
  ]);

  const redis = createRedisClient({ url: redisUrl, keyPrefix: redisKeyPrefix });
  const messageStore = new RedisMessageStore(redis);
  const threadStore = new RedisThreadStore(redis);
  const crashGuard = registerCrashCleanup(messageStore, threadStore, redis);

  const checks = [];
  try {
    const thread = await threadStore.create(SMOKE_USER_ID, SMOKE_THREAD_TITLE);
    crashGuard.setThread(thread);

    // --- 4. message round-trip：写走 store 层（零 agent 触发），读走真实 HTTP ---
    const smokeContent = `smoke-test round-trip ping ${new Date().toISOString()}`;
    const m1 = await messageStore.append({
      userId: SMOKE_USER_ID,
      catId: null,
      content: smokeContent,
      mentions: [],
      timestamp: Date.now(),
      threadId: thread.id,
    });
    checks.push(await checkMessageRoundTrip(apiPort, thread.id, m1.id, smokeContent));

    // 第二条消息，供下面测 CAS 单调性用（m2 比 m1 新）
    const m2 = await messageStore.append({
      userId: SMOKE_USER_ID,
      catId: null,
      content: `smoke-test round-trip ping ${new Date().toISOString()} #2`,
      mentions: [],
      timestamp: Date.now() + 1,
      threadId: thread.id,
    });

    // --- 5. read-state/cursor 管道（B 方案：不做真实未读注入，只验证已读回执链路）---
    const afterAck = await ackThreadRead(apiPort, thread.id, m2.id);
    checks.push({
      ok: afterAck.ackOk && afterAck.lastReadMessageId === m2.id,
      label: 'read-state ack 推进',
      detail: !afterAck.ackOk
        ? `PATCH .../read 失败：HTTP ${afterAck.ackStatus}`
        : `PATCH ack 到最新消息(${m2.id})后，GET /api/threads 里 lastReadMessageId=${afterAck.lastReadMessageId ?? '(未找到)'}`,
    });

    // 单调 CAS：拿旧消息 id 去 ack，游标不该倒退（ACK_CAS_LUA：新值 <= 旧值即拒绝）
    const afterRegress = await ackThreadRead(apiPort, thread.id, m1.id);
    checks.push({
      ok: afterRegress.ackOk && afterRegress.lastReadMessageId === m2.id,
      label: 'read-state ack 单调性（防倒退）',
      detail: `用更早的消息(${m1.id})重新 ack 后，游标${afterRegress.lastReadMessageId === m2.id ? '保持在' : '被错误回退到'} ${afterRegress.lastReadMessageId ?? '(未找到)'}（期望仍是 ${m2.id}）`,
    });

    // mark-all：只验证端点本身跑通、不报错——不断言这条 smoke 线程的 unreadCount
    // 变化（用户自发消息本来就不计入未读，这不是 bug，是 isUserVisibleUnreadMessage
    // 的设计），这条只保护"批量推进管道没坏"这个真回归面。
    const markAll = await fetchJson(`http://localhost:${apiPort}/api/threads/read/mark-all`, { method: 'POST' });
    checks.push({
      ok:
        markAll.ok && typeof markAll.body?.advancedCount === 'number' && typeof markAll.body?.totalThreads === 'number',
      label: 'mark-all-read 管道',
      detail: markAll.ok
        ? `advancedCount=${markAll.body?.advancedCount}, totalThreads=${markAll.body?.totalThreads}（【诚实标注】未做真实未读注入——需 agent-key 置备，冒烟脚本刻意不扩权限面；只验证已读回执/游标链路本身）`
        : `HTTP ${markAll.status}`,
    });

    return { skipped: false, checks };
  } finally {
    // 清理必须保证：即使上面任何一步抛错，也要把注入的消息+smoke 线程从 prod redis 里
    // 真删掉（硬删除，非 soft-delete），不留孤儿数据。
    await crashGuard.cleanup();
    crashGuard.unregister();
  }
}

try {
  const pipeline = await runMessageAndReadStatePipeline();
  if (pipeline.skipped) {
    add('warn', 'message round-trip + read-state 管道', pipeline.reason);
  } else {
    for (const c of pipeline.checks) add(c.ok, c.label, c.detail);
  }
} catch (err) {
  add(
    false,
    'message round-trip + read-state 管道',
    `执行异常（清理已在 finally 里尝试过）：${err.stack || err.message}`,
  );
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

console.log('Clowder Runtime Doctor');
console.log('======================');
for (const item of results) {
  const marker = item.status === 'ok' ? 'OK  ' : item.status === 'warn' ? 'WARN' : 'ERR ';
  console.log(`${marker} ${item.label}${item.detail ? ` — ${item.detail}` : ''}`);
}

const failed = results.filter((item) => item.status === 'err');
const warned = results.filter((item) => item.status === 'warn');
if (failed.length > 0) {
  console.log('');
  console.log(
    `发现 ${failed.length} 个硬失败${warned.length > 0 ? `，另有 ${warned.length} 个降级/警告` : ''}。建议从正确目录执行：`,
  );
  console.log(`cd ${projectRoot}`);
  console.log('pnpm start:direct -- --daemon');
  process.exit(1);
}

console.log('');
if (warned.length > 0) {
  console.log(
    `运行态基本完整，但有 ${warned.length} 项降级/警告（见上方 WARN，不能证明对应子系统 100% 健康，需要人看）。`,
  );
} else {
  console.log('运行态完整：Web/API/Agent/主题/本地资源/消息读写/已读游标 均验证真实活着。');
}
