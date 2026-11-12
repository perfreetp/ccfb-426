/** 插桩：统计阴影与主画布各自的 submesh 渲染量 */
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
        id: 'p' + i, speciesId: store.species[i % 4].id,
        x: (Math.random()*2-1)*half, z: (Math.random()*2-1)*half,
        rotation: Math.random()*6.28, scale: 1,
      });
    }
    store.updatePlan(p => { p.trees = trees; });

    // 插桩引擎 draw 调用，按调用栈区分阴影通道
    const sm = window.__sceneManager;
    const engine = sm.engine;
    window.__trace = { shadow: 0, main: 0, shadowMeshes: new Set() };
    const shadowMap = sm.scene.textures.find(t => t.isRenderTarget && t.name && t.name.includes('shadowMap'));
    if (!shadowMap) throw new Error('shadow map not found; rtts=' + sm.scene.textures.filter(t=>t.isRenderTarget).map(t=>t.name).join(','));
    shadowMap.onBeforeRenderObservable.add(() => { window.__inShadow = true; window.__trace.shadowPasses = (window.__trace.shadowPasses||0)+1; });
    shadowMap.onAfterRenderObservable.add(() => { window.__inShadow = false; });
    const orig1 = engine.drawElementsType.bind(engine);
    const orig2 = engine.drawArraysType.bind(engine);
    engine.drawElementsType = function(...args) {
      if (window.__inShadow) window.__trace.shadow++; else window.__trace.main++;
      return orig1(...args);
    };
    engine.drawArraysType = function(...args) {
      if (window.__inShadow) window.__trace.shadow++; else window.__trace.main++;
      return orig2(...args);
    };
    window.__shadowMap = shadowMap;
  })()`,
  awaitPromise: true,
});
await sleep(4000);

const r = await client.send('Runtime.evaluate', {
  expression: `(() => {
    const t = window.__trace;
    const sm = window.__sceneManager;
    const shadowMap = window.__shadowMap;
    return {
      shadowDrawsTotal: t.shadow,
      mainDrawsTotal: t.main,
      mainDrawsPerSecond: t.main / 4,
      shadowPasses: t.shadowPasses,
      shadowRenderListNow: shadowMap.renderList?.length,
      engineCounter: sm.engine._drawCalls.current,
      fps: sm.fps,
      estDrawCallsPerFrame: t.main / 4 / Math.max(1, sm.fps),
    };
  })()`,
  returnByValue: true,
});
console.log('RAW:', JSON.stringify(r));
console.log(JSON.stringify(r.result?.result?.value ?? r.result, null, 1));
await fetch(`${BASE}/json/close/${tab.id}`);
client.close();
process.exit(0);
