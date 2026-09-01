/** CDP 关闭整个浏览器实例（勿 taskkill 误杀用户实例）：node gb-close-browser.js <port> */
const WebSocket = require('ws');
const PORT = (() => {
  const raw = process.argv[2] || '9333';
  if (!/^\d+$/.test(raw)) throw new Error('port must be digits only');
  const p = parseInt(raw, 10);
  if (p < 2000 || p > 65535) throw new Error('port out of range');
  return raw;
})();
(async () => {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise(r => { ws.once('open', r); ws.once('error', r); });
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  setTimeout(() => process.exit(0), 1500);
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
