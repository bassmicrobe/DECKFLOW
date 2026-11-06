import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {extname, resolve, sep} from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 4188);
const fixturePaths = new Set(['/tests/library-store.browser.html', '/tests/library-store.browser.mjs']);
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8'};
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');

// Serve only the browser fixture and runtime assets, never repository metadata.
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(root, '.' + path);
    const runtime = path.startsWith('/dist/') && file.startsWith(resolve(root, 'dist') + sep);
    if (request.method !== 'GET' || (!fixturePaths.has(path) && !runtime)) {
      response.writeHead(404).end('Not found');
      return;
    }
    const content = await readFile(file);
    response.writeHead(200, {'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}).end(content);
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof URIError)) console.error('Browser test asset read failed:', error.code || error.name);
    response.writeHead(404).end('Not found');
  }
});
server.on('error', error => { console.error('Browser test server failed:', error.message); process.exitCode = 1; });
server.listen(port, '127.0.0.1', () => console.log(`Browser storage tests: http://127.0.0.1:${port}/tests/library-store.browser.html`));
