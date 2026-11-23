// Preview only the public build, including a GitHub Pages style project subpath.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('dist');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.otf': 'font/otf', '.wasm': 'application/wasm' };
http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  let name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (name === '/') { res.writeHead(302, { Location: '/yejian/' }); res.end(); return; }
  if (!name.startsWith('/yejian/')) { res.writeHead(404); res.end(); return; }
  name = name.slice('/yejian/'.length) || 'index.html';
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    if (!(await stat(file)).isFile()) throw new Error();
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    console.log(req.method, name);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(4173, '127.0.0.1', () => console.log('Static preview: http://127.0.0.1:4173/yejian/'));
