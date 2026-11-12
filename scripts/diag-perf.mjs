/** 验证 3000 棵时的 draw calls 与 LOD 分档 */
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

await client.send('Runtime.evaluate', {
  expression: `(async () => {
    const mod = await import('/src/state/store.ts');
    const store = mod.store;
    const half = store.currentPlan.site.size / 2 - 2;
    const trees = [];
    for (let i = 0; i < 3000; i++) {
      trees.push({
        id: 'p' + i,
        speciesId: store.species[i % 4].id,
        x: (Math.random() * 2 - 1) * half,
        z: (Math.random() * 2 - 1) * half,
        rotation: Math.random() * Math.PI * 2,
        scale: 0.9 + Math.random() * 0.2,
      });
    }
    store.updatePlan(p => { p.trees = trees; });
  })()`,
  awaitPromise: true,
});
await sleep(4000);

const before = await client.send('Runtime.evaluate', {
  expression: `(() => {
    const sm = window.__sceneManager;
    sm.engine._drawCalls._stores.length = 0;
    sm.engine._drawCalls.fetchNewFrame();
    return sm.engine._drawCalls.current;
  })()`,
  returnByValue: true,
});
await sleep(1500);
const stats = await client.send('Runtime.evaluate', {
  expression: `(() => {
    const sm = window.__sceneManager;
    const scene = sm.scene;
    const active = scene.meshes.filter(m => m.isEnabled() && m.isVisible);
    const thin = active.filter(m => m.thinInstanceCount > 0);
    const shadowMap = scene.lights.find(l => l.getShadowMap && l.getShadowMap())?.getShadowMap();
    const shadowRenderList = shadowMap?.renderList?.map(m => m.name + (m.isVisible ? '' : '(invis)')) ?? [];
    return {
      totalMeshes: scene.meshes.length,
      activeVisible: active.length,
      meshNameGroups: scene.meshes.reduce((acc, m) => {
        const key = m.name.replace(/-\d+$/, '').replace(/-[a-f0-9-]+$/, '');
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      thinMeshes: thin.map(m => ({ name: m.name, count: m.thinInstanceCount })),
      engineDrawCalls: sm.engine._drawCalls.current,
      shadowRenderListCount: shadowRenderList.length,
      shadowRenderList: shadowRenderList.slice(0, 8),
      customRTTs: scene.customRenderTargets.length,
      rttTextures: scene.textures.filter(t => t.isRenderTarget).length,
      fps: sm.fps,
    };
  })()`,
  returnByValue: true,
});
console.log(JSON.stringify(stats.result?.result?.value, null, 1));

for (const ev of client.events) {
  if (ev.method === 'Runtime.exceptionThrown') {
    console.log('EXCEPTION:', ev.params.exceptionDetails.exception?.description || ev.params.exceptionDetails.text);
  }
}
await fetch(`${BASE}/json/close/${tab.id}`);
client.close();
process.exit(0);
