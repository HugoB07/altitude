// PDF rendering through headless Chrome driven over CDP (no npm dependencies).
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
// resolve() accepts relative, Windows and POSIX paths alike.
const HTML = resolve(process.argv[2] ?? 'altitude-plan.html');
const OUT = resolve(process.argv[3] ?? 'Altitude-Plan-de-developpement.pdf');
const PORT = 9333;

const profile = mkdtempSync(join(tmpdir(), 'altitude-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  pathToFileURL(HTML).href,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.url.startsWith('file:'));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* Chrome not ready yet */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint not found');
}

const wsUrl = await findPage();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');

// Wait for full load plus web fonts
for (let i = 0; i < 80; i++) {
  const { result } = await send('Runtime.evaluate', {
    expression: 'document.readyState === "complete" && document.fonts.status === "loaded"',
    returnByValue: true,
  });
  if (result.value === true) break;
  await sleep(250);
}
await sleep(1200); // settle final layout

const style = 'font-family:Inter,-apple-system,"Segoe UI",sans-serif;font-size:7px;color:#94A3B8;width:100%;padding:0 14mm;-webkit-print-color-adjust:exact;';

const { data } = await send('Page.printToPDF', {
  printBackground: true,
  preferCSSPageSize: true,
  displayHeaderFooter: true,
  headerTemplate: `<div style="${style}"></div>`,
  footerTemplate: `<div style="${style}display:flex;justify-content:space-between;align-items:center;">
      <span style="letter-spacing:.12em;text-transform:uppercase;">Altitude — Plan de développement v1.0</span>
      <span style="color:#0284C7;font-weight:700;"><span class="pageNumber"></span> / <span class="totalPages"></span></span>
    </div>`,
});

writeFileSync(OUT, Buffer.from(data, 'base64'));
ws.close();
chrome.kill();
console.log(`OK -> ${OUT}`);
process.exit(0);
