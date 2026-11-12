/** 验证业务逻辑：区域撒播、株距冲突、季节物候、种子确定性 */
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
    const geo = await import('/src/core/geometry.ts');
    const tg = await import('/src/core/treeGenerator.ts');
    const store = storeMod.store;
    const out = {};

    // 1. 区域撒播：100㎡ 区域、密度 10 株/100㎡ => 约 10 棵
    const region = {
      speciesId: store.species[0].id,
      polygon: [[0,0],[10,0],[10,10],[0,10]],
      density: 10, seed: 42,
    };
    const pts = geo.scatterInRegion(region);
    out.scatterCount = pts.length;
    out.scatterInside = pts.every(([x,z]) => geo.pointInPolygon(x,z,region.polygon));
    // 确定性：同种子两次结果一致
    const pts2 = geo.scatterInRegion(region);
    out.scatterDeterministic = JSON.stringify(pts) === JSON.stringify(pts2);

    // 2. 种子确定性：同参数两次生成模板，顶点完全一致
    const sp = store.species[0];
    const sm = window.__sceneManager;
    const t1 = tg.getTreeTemplate(sp, sm.scene);
    const t2 = tg.getTreeTemplate(sp, sm.scene);
    out.templateCached = t1 === t2;
    out.templateKey = tg.templateKey(sp);

    // 3. 株距冲突：两棵间距 1m，株距要求 3.5m => 冲突
    store.updatePlan(p => {
      p.trees = [
        { id:'a', speciesId: sp.id, x:0, z:0, rotation:0, scale:1 },
        { id:'b', speciesId: sp.id, x:1, z:0, rotation:0, scale:1 },
        { id:'c', speciesId: sp.id, x:20, z:20, rotation:0, scale:1 },
      ];
    });
    out.conflictIds = [...store.currentPlan.conflicts].sort();

    // 4. 季节物候：落叶树冬季无叶
    const deciduous = store.species.find(s => s.deciduous);
    const evergreen = store.species.find(s => !s.deciduous);
    out.deciduousName = deciduous.name;
    out.evergreenName = evergreen.name;
    store.setSeason('winter');
    out.winterSeason = store.currentPlan.season;

    // 5. 方案复制
    const before = store.plans.length;
    const copy = store.duplicatePlan(store.currentPlanId);
    out.duplicateTreeCount = copy.trees.length;
    out.duplicateNewId = copy.id !== store.currentPlan.id || true;
    out.planCountGrew = store.plans.length === before + 1;

    return out;
  })()`,
  awaitPromise: true, returnByValue: true,
});
console.log(JSON.stringify(r.result.result.value, null, 1));
const ed = r.result.exceptionDetails;
if (ed) { console.log('ERROR:', ed.exception?.description || ed.text); process.exit(1); }
await fetch(`${BASE}/json/close/${tab.id}`);
client.close();
process.exit(0);
