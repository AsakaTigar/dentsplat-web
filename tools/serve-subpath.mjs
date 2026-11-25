/**
 * tools/serve-subpath.mjs — serve dist/ under a repository-style subpath, the way GitHub Pages does.
 *
 * GitHub Pages publishes this app at https://<user>.github.io/<repo>/, and it answers a missing file with
 * a real 404 rather than the dev server's index.html fallback. Both differences matter: an absolute
 * '/assets/...' reference looks fine on `npm run preview` and fails here, and a fetch that gets HTML back
 * with status 200 fails much later, inside JSON.parse. So the pre-deploy check runs against this server,
 * not against the preview server.
 *
 *   node tools/serve-subpath.mjs [--port 5288] [--prefix dentsplat-web] [--root dist]
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (f, d) => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('--port', 5288));
const PREFIX = arg('--prefix', 'dentsplat-web');
const DIST = resolve(root, arg('--root', 'dist'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary', '.dspk': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
};

createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  const notFound = (why) => {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${why}: ${url}`);
    console.log(`404 ${url}`);
  };
  if (!url.startsWith(`/${PREFIX}/`) && url !== `/${PREFIX}`) return notFound('outside the subpath');
  let rel = url.slice(PREFIX.length + 1);                 // '/repo/' -> ''
  if (rel === '' || rel === '/') rel = 'index.html';
  const file = normalize(join(DIST, rel));
  if (!file.startsWith(DIST)) return notFound('escapes dist');
  if (!existsSync(file) || statSync(file).isDirectory()) return notFound('no such file');
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': statSync(file).size,
    'cache-control': 'no-store',
  });
  console.log(`200 ${url}`);
  createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving ${DIST} at http://127.0.0.1:${PORT}/${PREFIX}/`);
});
