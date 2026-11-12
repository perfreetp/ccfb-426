/** 帧内 draw call 来源打点 */
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
        rotation: Math.random() * 2 * Math.PI,
        scale: 0.9 + Math.random() * 0.2,
      });
    }
    store.updatePlan(p => { p.trees = trees; });
    window.__mark = (label) => {
      const e = window.__sceneManager.engine;
      window.__marks = window.__marks || [];
      window.__marks.push({ label, calls: e._drawCalls.current, total: e._totalDrawCalls });
    };
  })()`,
  awaitPromise: true,
});
await sleep(4000);

const r = await client.send('Runtime.evaluate', {
  expression: `(() => {
    const sm = window.__sceneManager;
    const scene = sm.scene;
    // 阴影 RTT 详情
    const shadowInfo = scene.textures.filter(t => t.isRenderTarget).map(t => ({
      name: t.name,
      refreshRate: t.refreshRate,
      renderListLen: t.renderList?.length ?? -1,
      objectRendererRefresh: t._objectRenderer?.refreshRate,
    }));
    // 主画布每帧可见网格实际 subMesh 数
    const visibleSubMeshes = scene.meshes
      .filter(m => m.isEnabled() && m.isVisible && m.subMeshes)
      .map(m => ({ name: m.name, sub: m.subMeshes.length, thin: m.thinInstanceCount }));
    return {
      shadowInfo,
      visibleSubMeshes,
      drawCalls: sm.engine._drawCalls.current,
      fps: sm.fps,
      activeMeshesEval: scene._activeMeshes?.length ?? -1,
    };
  })()`,
  returnByValue: true,
});
console.log(JSON.stringify(r.result?.result?.value, null, 1));

await fetch(`${BASE}/json/close/${tab.id}`);
client.close();
process.exit(0);
