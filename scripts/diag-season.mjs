/** 验证冬季落叶/常绿叶显隐与太阳阴影方向 */
const BASE = 'http://127.0.0.1:9222';
const APP = 'http://localhost:5247/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); };
  const send = (method, params = {}) => { const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params })); return new Promise((res) => pending.set(mid, res)); };
  return { send, events, close: () => ws.close() };
}
const tab = await (await fetch(`${BASE}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' })).json();
const client = await cdp(tab.webSocketDebuggerUrl);
await client.send('Runtime.enable');
await sleep(7000);

const r = await client.send('Runtime.evaluate', {
  expression: `(async () => {
    const storeMod = await import('/src/state/store.ts');
    const store = storeMod.store;
    const out = {};
    // 种 1 棵落叶（银杏 ginkgo）+ 1 棵常绿（香樟 camphor）
    store.updatePlan(p => {
      p.trees = [
        { id:'d1', speciesId:'ginkgo', x:-5, z:0, rotation:0, scale:1 },
        { id:'e1', speciesId:'camphor', x:5, z:0, rotation:0, scale:1 },
      ];
    });
    const sm = window.__sceneManager;
    const leafState = () => {
      const scene = sm.scene;
      const find = (n) => scene.getMeshByName(n);
      return {
        ginkgoHighLeaf: find('hl-ginkgo')?.isEnabled(),
        ginkgoLowLeaf: find('ll-ginkgo')?.isEnabled(),
        ginkgoBillboard: find('bb-mesh-ginkgo')?.isEnabled(),
        camphorHighLeaf: find('hl-camphor')?.isEnabled(),
        camphorBillboard: find('bb-mesh-camphor')?.isEnabled(),
      };
    };
    store.setSeason('summer');
    await new Promise(r => setTimeout(r, 800));
    out.summer = leafState();
    store.setSeason('winter');
    await new Promise(r => setTimeout(r, 800));
    out.winter = leafState();

    // 太阳位置随方位角变化
    store.updatePlan(p => { p.site.sunAzimuth = 0; p.site.sunElevation = 0.5; });
    sm.applySun();
    const sun1 = { x: sm.sun.position.x, z: sm.sun.position.z };
    store.updatePlan(p => { p.site.sunAzimuth = Math.PI; });
    sm.applySun();
    const sun2 = { x: sm.sun.position.x, z: sm.sun.position.z };
    out.sunMovesOpposite = Math.sign(sun1.x) !== Math.sign(sun2.x) || Math.sign(sun1.z) !== Math.sign(sun2.z);

    return out;
  })()`,
  awaitPromise: true, returnByValue: true,
});
console.log(JSON.stringify(r.result.result.value, null, 1));
if (r.result.exceptionDetails) { console.log('ERROR:', r.result.exceptionDetails.exception?.description); process.exit(1); }
await fetch(`${BASE}/json/close/${tab.id}`);
client.close();
process.exit(0);
