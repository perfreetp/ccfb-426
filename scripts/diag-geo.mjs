/** 统计单树几何规模与每帧顶点量 */
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
await sleep(8000);
const r = await client.send('Runtime.evaluate', {
  expression: `(async () => {
    const tg = await import('/src/core/treeGenerator.ts');
    const ds = await import('/src/core/defaultSpecies.ts');
    const sm = window.__sceneManager;
    const out = [];
    let totalVerts = 0;
    for (const sp of ds.DEFAULT_SPECIES.slice(0, 4)) {
      const tpl = tg.getTreeTemplate(sp, sm.scene);
      const v = (g) => g.positions.length / 3;
      const i = (g) => g.indices.length;
      out.push({
        species: sp.name,
        highBranchV: v(tpl.high.branch), highLeafV: v(tpl.high.leaf),
        lowBranchV: v(tpl.low.branch), lowLeafV: v(tpl.low.leaf),
        highTri: (i(tpl.high.branch)+i(tpl.high.leaf))/3,
        lowTri: (i(tpl.low.branch)+i(tpl.low.leaf))/3,
      });
    }
    return out;
  })()`,
  awaitPromise: true, returnByValue: true,
});
console.log(JSON.stringify(r.result.result.value, null, 1));
await fetch(`${BASE}/json/close/${tab.id}`);
client.close();
process.exit(0);
