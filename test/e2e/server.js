/** e2e 静态服务器：项目根为 docroot（供 harness 引用 out/ 产物）。 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer((req, res) => {
  try {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    // 只允许 docroot 内的文件（resolve 归一化后必须仍在 ROOT 之下，防 ../ 与同前缀兄弟目录）
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(400).end('bad request');   // decodeURIComponent 畸形输入等
  }
}).listen(8917, '127.0.0.1', () => console.log('e2e server on http://127.0.0.1:8917'));
