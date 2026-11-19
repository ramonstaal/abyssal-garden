// Bundles src/*.js into the single self-contained ../index.html
//   npm run build            minified
//   npm run build:readable   unminified, for debugging
//   npm run build:dev        ../dev.html: unminified, plus the development tools in src/dev.js
//   npm run dev              build:dev, then serve it at http://localhost:5173, rebuilding and reloading the page on every edit
//                            (--port <n> picks another port)
import { readFileSync, writeFileSync, watch } from 'node:fs';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILES = ['quality.js', 'math.js', 'shaders.js', 'world.js', 'main.js', 'audio.js']; // concatenation order matters
const serve = process.argv.includes('--serve');
const dev = serve || process.argv.includes('--dev'), readable = dev || process.argv.includes('--readable');
const out = dev ? 'dev.html' : 'index.html';
if (dev) FILES.push('dev.js');

// everything runs inside one async function; startup errors are shown on screen
const wrap = (body) => `(async()=>{${body}\n})().catch(e=>{console.error(e);document.body.className='l e';document.getElementById('s').textContent=(e.cause?'':'Failed to start: ')+e.message});`;

function build() {
  let js = FILES.map((f) => readFileSync(path.join(here, 'src', f), 'utf8')).join('\n');
  // the cockpit overlay (cockpit.webp, made from assets/cockpit.png) is inlined as a data URI
  const tpl = readFileSync(path.join(here, 'template.html'), 'utf8').replace('/*COCKPIT*/', () => 'data:image/webp;base64,' + readFileSync(path.join(here, 'cockpit.webp')).toString('base64'));
  let html;
  if (readable) {
    html = tpl.replace('/*SCRIPT*/', () => wrap(js));
  } else {
    // shrink the WGSL inside /*wgsl*/ template literals, then minify the JS and the page's CSS
    const minWgsl = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').replace(/ ?([{}()\[\];,:=+\-*\/<>&|!%@]) ?/g, '$1').trim();
    js = js.replace(/\/\*wgsl\*\/`([^`]*)`/g, (_, w) => '`' + minWgsl(w) + '`');
    const code = transformSync(wrap(js), { minify: true, target: 'es2022', legalComments: 'none' }).code.trim();
    const css = (_, s) => '<style>' + transformSync(s, { loader: 'css', minify: true }).code.trim();
    html = tpl.replace(/<style>([^]*?)(?=<\/style>)/, css).replace(/>\s+</g, '><').replace('/*SCRIPT*/', () => code).replace(/<script>\s+/, '<script>').replace(/\s+<\/script>/, '</script>');
  }
  writeFileSync(path.join(here, '..', out), html);
  const gz = gzipSync(Buffer.from(html), { level: 9 }).length;
  console.log(`${out}: ${(html.length / 1024).toFixed(1)} kB${readable ? ' (readable)' : ''}, ${(gz / 1024).toFixed(1)} kB gzipped`);
  return html;
}

let html = build();

if (serve) {
  const pi = process.argv.indexOf('--port'), port = pi > 0 ? +process.argv[pi + 1] : 5173;
  const clients = new Set();
  // the page reloads itself when the server says a rebuild finished
  const client = '<script>new EventSource("/__reload").onmessage=()=>location.reload()</script>';
  const send = (res, type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/__reload') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': ok\n\n'); clients.add(res); req.on('close', () => clients.delete(res));
    } else if (url === '/' || url === '/index.html' || url === '/dev.html') send(res, 'text/html; charset=utf-8', html.replace('</body>', () => client + '</body>'));
    else { res.writeHead(404); res.end('not found'); }
  }).listen(port, () => console.log(`dev server: http://localhost:${port}  (rebuilds and reloads on every change in src/ and template.html)`));
  let timer;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { // editors fire several events per save
      try { html = build(); for (const c of clients) c.write('data: reload\n\n'); }
      catch (e) { console.error('build failed:', e.message); }
    }, 80);
  };
  watch(path.join(here, 'src'), rebuild);
  watch(path.join(here, 'template.html'), rebuild);
  watch(path.join(here, 'cockpit.webp'), rebuild);
}
