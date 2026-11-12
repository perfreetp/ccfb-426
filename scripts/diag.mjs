/** 最小诊断：打开页面，10 秒后 dump 状态与所有错误 */
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
console.log('tab', tab.id);
const client = await cdp(tab.webSocketDebuggerUrl);
await client.send('Runtime.enable');
await client.send('Log.enable');
await client.send('Page.enable');

await sleep(10000);

const r = await client.send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    bodyStart: document.body.innerHTML.slice(0, 300),
    canvas: !!document.querySelector('canvas'),
    tabs: document.querySelectorAll('.tab').length,
    sceneReady: !!window.__sceneManager,
  })`,
  returnByValue: true,
});
console.log('页面状态:', r.result?.result?.value);

for (const ev of client.events) {
  if (ev.method === 'Runtime.exceptionThrown') {
    const ed = ev.params.exceptionDetails;
    console.log('EXCEPTION:', ed.exception?.description || ed.text);
  }
  if (ev.method === 'Log.entryAdded') {
    console.log('LOG[' + ev.params.entry.level + ']:', ev.params.entry.text.slice(0, 300));
  }
  if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
    console.log('CONSOLE.ERROR:', ev.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 500));
  }
}

await fetch(`${BASE}/json/close/${tab.id}`);
client.close();
process.exit(0);
