/** 单独验证 GLB 导出耗时与结果 */
const BASE = 'http://127.0.0.1:9222';
const APP = 'http://localhost:5247/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else if (msg.method) events.push(msg);
  };
  const send = (method, params = {}) => {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params }));
    return new Promise((res) => pending.set(mid, res));
  };
  return { send, events, close: () => ws.close() };
}

const tab = await (await fetch(`${BASE}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json();
const client = await cdp(tab.webSocketDebuggerUrl);
await client.send('Runtime.enable');
await sleep(8000);

// 种 100 棵小树做导出测试
await client.send('Runtime.evaluate', {
  expression: `(async () => {
    const mod = await import('/src/state/store.ts');
    const store = mod.store;
    const sp = store.species[0].id;
    const trees = [];
    for (let i = 0; i < 100; i++) {
      trees.push({ id: 't'+i, speciesId: sp, x: (Math.random()*2-1)*20, z: (Math.random()*2-1)*20, rotation: 0, scale: 1 });
    }
    store.updatePlan(p => { p.trees = trees; });
  })()`,
  awaitPromise: true,
});
await sleep(2000);

const t0 = Date.now();
const r = await client.send('Runtime.evaluate', {
  expression: `(async () => {
    const exp = await import('/src/export/exporter.ts');
    const storeMod = await import('/src/state/store.ts');
    try {
      const blob = await exp.exportGLB(window.__sceneManager, storeMod.store.currentPlan, storeMod.store.species);
      return { ok: true, size: blob.size, ms: 0 };
    } catch (e) {
      return { ok: false, err: String(e && e.stack || e) };
    }
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
console.log('GLB 结果(含等待):', JSON.stringify(r.result?.result?.value), '总耗时ms=', Date.now() - t0);

for (const ev of client.events) {
  if (ev.method === 'Runtime.exceptionThrown') {
    console.log('EXCEPTION:', ev.params.exceptionDetails.exception?.description || ev.params.exceptionDetails.text);
  }
  if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
    console.log('CONSOLE.ERROR:', ev.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400));
  }
}
await fetch(`${BASE}/json/close/${tab.id}`);
client.close();
process.exit(0);
