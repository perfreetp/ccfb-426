/**
 * 浏览器冒烟测试（通过 Chrome DevTools Protocol 驱动真实 Chrome）
 * 用法：node scripts/smoke.mjs
 */
const BASE = 'http://127.0.0.1:9222';
const APP = 'http://localhost:5247/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function put(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'PUT' });
  return res.json();
}

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  function send(method, params = {}) {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params }));
    return new Promise((res) => pending.set(mid, res));
  }
  return {
    send,
    events,
    close: () => ws.close(),
  };
}

const failures = [];
const log = (...a) => console.log(...a);

async function evalJs(client, expression, awaitPromise = true) {
  const r = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (r.result.exceptionDetails) {
    const ed = r.result.exceptionDetails;
    throw new Error(ed.exception?.description || ed.text);
  }
  return r.result.result.value;
}

async function main() {
  const tab = await put(`/json/new?${encodeURIComponent(APP)}`);
  log('tab:', tab.id);
  const client = await cdp(tab.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  await client.send('Console.enable');
  await client.send('Page.enable');

  const errors = [];
  const origEvents = client.events;
  client.events.length = 0;

  // 等待应用初始化（最多 20 秒）
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const ready = await evalJs(client, `!!document.querySelector('canvas')`).catch(() => false);
    if (ready) break;
  }

  // 收集 console / pageerror
  for (const ev of client.events) {
    if (ev.method === 'Runtime.exceptionThrown') {
      errors.push('exception: ' + (ev.params.exceptionDetails.exception?.description || ev.params.exceptionDetails.text));
    }
    if (ev.method === 'Log.entryAdded' && (ev.params.entry.level === 'error' || ev.params.entry.level === 'warning')) {
      errors.push('log[' + ev.params.entry.level + ']: ' + ev.params.entry.text);
    }
    if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      errors.push('console: ' + ev.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  }
  client.events.length = 0;
  if (errors.length) {
    log('启动期错误:\n' + errors.join('\n'));
    failures.push(...errors.slice(0, 5).map((e) => '启动错误: ' + e.split('\n')[0]));
  }

  const state1 = await evalJs(client, `(() => ({
    title: document.title,
    hasCanvas: !!document.querySelector('canvas'),
    tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent),
    planCards: document.querySelectorAll('.card').length,
    fpsText: document.querySelector('.hud')?.textContent || '',
  }))()`);
  log('初始状态:', JSON.stringify(state1));
  if (!state1.hasCanvas) failures.push('canvas 未创建');
  if (state1.tabs.length !== 5) failures.push('页签数量不是 5');

  // 切到场地编辑页
  await evalJs(client, `[...document.querySelectorAll('.tab')].find(t=>t.textContent==='场地编辑').click()`);
  await sleep(800);
  const tools = await evalJs(client, `[...document.querySelectorAll('.toolbtn')].map(b=>b.textContent.trim())`);
  log('工具按钮:', tools);
  if (tools.length !== 4) failures.push('场地工具按钮缺失');

  // 点种模式，直接调 store 批量种 3000 棵（绕开 3000 次点击）
  await evalJs(client, `[...document.querySelectorAll('.toolbtn')].find(b=>b.textContent.includes('点种')).click()`);
  await sleep(300);
  const plantResult = await evalJs(client, `(async () => {
    const mod = await import('/src/state/store.ts');
    const store = mod.store;
    const plan = store.currentPlan;
    const sp = store.species[0].id;
    const half = plan.site.size / 2 - 2;
    const trees = [];
    for (let i = 0; i < 3000; i++) {
      trees.push({
        id: 'perf-' + i,
        speciesId: i % 3 === 0 ? store.species[1].id : sp,
        x: (Math.random() * 2 - 1) * half,
        z: (Math.random() * 2 - 1) * half,
        rotation: Math.random() * Math.PI * 2,
        scale: 0.9 + Math.random() * 0.2,
      });
    }
    store.updatePlan(p => { p.trees = trees; });
    return { count: store.currentPlan.trees.length, conflicts: store.currentPlan.conflicts.length };
  })()`);
  log('批量种植:', JSON.stringify(plantResult));
  if (plantResult.count !== 3000) failures.push('树木数量不是 3000');

  await sleep(3000);

  // 性能与渲染统计
  const perf = await evalJs(client, `(() => {
    const hud = document.querySelector('.hud').textContent;
    const engine = window.__sceneEngine || null;
    const meshes = [...document.querySelectorAll('canvas')].length;
    return { hud, meshes };
  })()`);
  log('3000 棵时 HUD:', perf.hud);
  const fpsMatch = perf.hud.match(/FPS\s*(\d+)/);
  const drawMatch = perf.hud.match(/Draw Calls\s*(\d+)/);
  const fps = fpsMatch ? parseInt(fpsMatch[1]) : 0;
  const draws = drawMatch ? parseInt(drawMatch[1]) : 0;
  log(`FPS=${fps} DrawCalls=${draws}`);
  if (fps < 30) failures.push(`3000 棵时 FPS=${fps} 低于 30`);
  if (draws > 80) failures.push(`DrawCalls=${draws} 过高（期望 < 80）`);

  // 切季节
  await evalJs(client, `[...document.querySelectorAll('.tab')].find(t=>t.textContent==='四季预览').click()`);
  await sleep(500);
  for (const s of ['冬', '秋', '春', '夏']) {
    await evalJs(client, `[...document.querySelectorAll('.season-btn')].find(b=>b.textContent.includes('${s}')).click()`);
    await sleep(600);
  }
  await sleep(1000);

  // 调风
  const wind = await evalJs(client, `(async () => {
    const mod = await import('/src/state/store.ts');
    const store = mod.store;
    store.updatePlan(p => p.site.windStrength = 0.8);
    return store.currentPlan.site.windStrength;
  })()`);
  log('风力调到:', wind);
  await sleep(1500);

  // 回到夏季检查 FPS
  const perf2 = await evalJs(client, `document.querySelector('.hud').textContent`);
  log('季节切换后 HUD:', perf2);

  // 树种库预览
  await evalJs(client, `[...document.querySelectorAll('.tab')].find(t=>t.textContent==='树种库').click()`);
  await sleep(600);
  await evalJs(client, `document.querySelectorAll('.card')[1]?.click()`);
  await sleep(2500);
  const preview = await evalJs(client, `document.querySelector('.hud').textContent`);
  log('树种预览 HUD:', preview);

  // 导出页
  await evalJs(client, `[...document.querySelectorAll('.tab')].find(t=>t.textContent==='导出').click()`);
  await sleep(500);
  const exportBtns = await evalJs(client, `[...document.querySelectorAll('button.primary')].map(b=>b.textContent)`);
  log('导出按钮:', exportBtns);
  if (exportBtns.length < 3) failures.push('导出按钮不足 3 个');

  // GLB 导出真实执行
  const glb = await evalJs(client, `(async () => {
    const exp = await import('/src/export/exporter.ts');
    const sm = window.__sceneManager;
    const storeMod = await import('/src/state/store.ts');
    const store = storeMod.store;
    const blob = await exp.exportGLB(sm, store.currentPlan, store.species);
    return { size: blob.size, type: blob.type };
  })()`);
  log('GLB 导出:', JSON.stringify(glb));
  if (!glb.size || glb.size < 1000) failures.push('GLB 导出体积异常');

  // 鸟瞰截图
  const shot = await evalJs(client, `(async () => {
    const exp = await import('/src/export/exporter.ts');
    const url = await exp.exportBirdseye(window.__sceneManager);
    return { prefix: url.slice(0, 30), length: url.length };
  })()`);
  log('鸟瞰截图:', JSON.stringify(shot));
  if (!shot.length || shot.length < 1000) failures.push('鸟瞰截图失败');

  // 方案 JSON 导出
  const planJson = await evalJs(client, `(async () => {
    const exp = await import('/src/export/exporter.ts');
    const storeMod = await import('/src/state/store.ts');
    const store = storeMod.store;
    const json = exp.planToJSON(store.currentPlan, store.species);
    const parsed = JSON.parse(json);
    return { format: parsed.format, trees: parsed.plan.trees.length, species: parsed.species.length };
  })()`);
  log('方案 JSON:', JSON.stringify(planJson));
  if (planJson.format !== 'garden-plan/v1') failures.push('方案格式标识错误');
  if (planJson.trees !== 3000) failures.push('导出树木数不符');

  // 收集期间错误
  for (const ev of client.events) {
    if (ev.method === 'Runtime.exceptionThrown') {
      errors.push('exception: ' + (ev.params.exceptionDetails.exception?.description || ev.params.exceptionDetails.text));
    }
    if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
      errors.push('log: ' + ev.params.entry.text);
    }
  }

  log('\n===== 结果 =====');
  log('运行时错误:', errors.length ? '\n' + errors.join('\n') : '无');
  log('失败项:', failures.length ? '\n- ' + failures.join('\n- ') : '无');
  if (errors.length) failures.push(...errors.slice(0, 5).map((e) => '运行时错误: ' + e.split('\n')[0]));

  await fetch(`${BASE}/json/close/${tab.id}`);
  client.close();
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟测试脚本异常:', e);
  process.exit(2);
});

// 全局 90 秒超时兜底
setTimeout(() => {
  console.error('冒烟测试超时退出');
  process.exit(3);
}, 90000);
