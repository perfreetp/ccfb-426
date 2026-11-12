/** 对照测试：开/关阴影、风强度，定位 FPS 瓶颈 */
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

async function evalJs(client, expression) {
  const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result.result.value;
}

const tab = await (await fetch(`${BASE}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json();
const client = await cdp(tab.webSocketDebuggerUrl);
await client.send('Runtime.enable');
await sleep(8000);

await evalJs(client, `(async () => {
  const mod = await import('/src/state/store.ts');
  const store = mod.store;
  const half = store.currentPlan.site.size / 2 - 2;
  const trees = [];
  for (let i = 0; i < 3000; i++) {
    trees.push({
      id: 'p'+i, speciesId: store.species[i%4].id,
      x: (Math.random()*2-1)*half, z: (Math.random()*2-1)*half,
      rotation: Math.random()*6.28, scale: 1,
    });
  }
  store.updatePlan(p => { p.trees = trees; p.site.windStrength = 0; });
})()`);

async function measure(label) {
  await sleep(2500);
  const v = await evalJs(client, `(() => {
    const sm = window.__sceneManager;
    // 测单帧 CPU 耗时
    const t0 = performance.now();
    let frames = 0;
    return new Promise(res => {
      const obs = sm.scene.onAfterRenderObservable.add(() => {
        frames++;
        if (frames >= 60) {
          sm.scene.onAfterRenderObservable.remove(obs);
          res({ fps: sm.fps, msPerFrame: (performance.now()-t0)/60 });
        }
      });
    });
  })()`);
  console.log(label, JSON.stringify(v));
}

await measure('无风+阴影:        ');

await evalJs(client, `window.__sceneManager.shadowGen.getShadowMap().refreshRate = 0;`);
await measure('无风+阴影渲染一次: ');

await evalJs(client, `(async () => {
  const mod = await import('/src/state/store.ts');
  mod.store.updatePlan(p => p.site.windStrength = 0.6);
})()`);
await measure('有风+阴影渲染一次: ');

await evalJs(client, `window.__sceneManager.scene.shadowsEnabled = false;`);
await measure('有风+关阴影:      ');

await fetch(`${BASE}/json/close/${tab.id}`);
client.close();
process.exit(0);
