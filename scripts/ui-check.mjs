// Optional end-to-end check of the REAL UI in a real browser (headless Edge or Chrome on Windows), driven through
// the DevTools protocol with no extra dependencies. It writes data, so run it against a throwaway database:
//
//   MONGO_URI=mongodb://127.0.0.1:27017/ui-check  (start `npm run dev` with this set, on an empty database)
//   node scripts/ui-check.mjs
//
// Needs internet (it researches linear.app) and writes screenshots to UI_OUT (default: a temp folder).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.UI_BASE || 'http://localhost:5173';
const OUT = process.env.UI_OUT || path.join(os.tmpdir(), 'startup-finder-ui');
const PORT = 9333;
fs.mkdirSync(OUT, { recursive: true });

const exe = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!exe) throw new Error('Edge or Chrome not found');

// Safety: this script WRITES data (imports, applications, drafts). Refuse to run against anything that does not
// look like a throwaway database, so it can never put demo data into your real one.
{
  let name;
  try { name = (await (await fetch(`${BASE}/api/health`)).json()).database; } catch { /* handled below */ }
  if (!name) { console.error(`Cannot reach ${BASE}/api/health. Start the app first (see the header of this file).`); process.exit(3); }
  if (!/check|test|scratch|demo/i.test(name) && process.env.UI_ALLOW_ANY_DB !== '1') {
    console.error(`REFUSING TO RUN: the app is connected to database "${name}", which does not look like a throwaway database.\nStart it with MONGO_URI=mongodb://127.0.0.1:27017/ui-check instead.`);
    process.exit(3);
  }
  console.log(`Using database "${name}".`);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-browser-'));
const browser = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const consoleProblems = [];
const dialogs = [];
let cdp;

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* browser still starting */ }
    await sleep(250);
  }
  throw new Error('browser did not start');
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else listeners.forEach((l) => l(m));
  });
  const opened = new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  return { opened, send, on: (l) => listeners.push(l), close: () => ws.close() };
}

const HELPERS = `window.__h = {
  q: (s) => document.querySelector(s),
  qa: (s) => [...document.querySelectorAll(s)],
  byText: (sel, t) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === t) || [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(t)),
  click: (el) => { if (!el) throw new Error('click: element not found'); el.click(); },
  set: (el, v) => {
    if (!el) throw new Error('set: element not found');
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
  },
  // textContent, not innerText: innerText applies CSS text-transform (uppercase labels would not match).
  text: () => document.body.textContent.replace(/\\s+/g, ' '),
};`;

const ev = async (body) => {
  const r = await cdp.send('Runtime.evaluate', { expression: `(async () => { ${body} })()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || r.exceptionDetails.text} in: ${body.slice(0, 120)}`);
  return r.result.value;
};
const waitFor = async (body, what, timeout = 20_000) => {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { last = await ev(body); if (last) return last; } catch (e) { last = e.message; }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for: ${what}${typeof last === 'string' ? ` (${last.slice(0, 160)})` : ''}`);
};
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `  -> ${detail}`}`);
};
const step = async (name, fn) => {
  try { await fn(); } catch (e) { check(name, false, e.message); }
};
const shot = async (name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
};
const viewport = (width, height, mobile = false) => cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
const noHScroll = () => ev('return document.documentElement.scrollWidth <= window.innerWidth + 1');
const rows = () => ev("return __h.qa('tbody tr').length");
const click = (sel, text) => ev(`__h.click(__h.byText(${JSON.stringify(sel)}, ${JSON.stringify(text)}))`);
const setBy = (sel, value) => ev(`__h.set(__h.q(${JSON.stringify(sel)}), ${JSON.stringify(value)})`);
const upload = async (file) => {
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
  if (!nodeId) throw new Error('file input not found');
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [path.join(ROOT, file).replace(/\//g, '\\')] });
};
const ymd = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const openCompany = async (name) => {
  await click('tbody tr button', name);
  await waitFor(`return __h.q('[aria-label="Applications"]') !== null`, `${name} drawer`);
};
const closeDrawer = () => ev("__h.click(__h.q('button[aria-label=\"Close\"]'))");

async function main() {
  cdp = client(await connect());
  await cdp.opened;
  for (const d of ['Page', 'Runtime', 'DOM', 'Log', 'Network']) await cdp.send(`${d}.enable`);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS });
  cdp.on((m) => {
    if (m.method === 'Page.javascriptDialogOpening') { dialogs.push(m.params.message); cdp.send('Page.handleJavaScriptDialog', { accept: true }); }
    if (m.method === 'Runtime.exceptionThrown') consoleProblems.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleProblems.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 200)}`);
  });
  await viewport(1280, 900);

  // ---- 1. Empty state ----
  await step('empty state', async () => {
    await cdp.send('Page.navigate', { url: BASE });
    await waitFor("return __h.text().includes('No companies yet')", 'empty state');
    check('Empty state explains how to import and the page title is set', (await ev('return document.title')) === 'Startup Finder' && (await ev("return __h.text().includes('Company Name')")));
    check('Dashboard tiles show zero companies', await ev("return /Companies\\s*0/.test(__h.text())"));
    await shot('01-empty-desktop');
    await viewport(390, 844, true);
    await sleep(300);
    check('Mobile (390px): no horizontal page scroll on the empty state', await noHScroll());
    await shot('02-empty-mobile');
    await viewport(1280, 900);
  });

  // ---- 2. Import the clean sample through the wizard ----
  await step('import clean sample', async () => {
    await click('button', 'Import CSV');
    await waitFor("return __h.q('[role=dialog]') !== null", 'wizard');
    await upload('sample_startups.csv');
    await waitFor("return __h.text().includes('12 rows')", 'mapping step');
    check('Mapping step maps Company Name -> company name automatically', await ev("return __h.q('select[aria-label=\"Map column Company Name\"]').value === 'name'"));
    await shot('03-import-map-desktop');
    await click('button', 'Review import');
    await waitFor("return /Will create\\s*12/.test(__h.text())", 'review step');
    check('Review (dry run) says it will create 12 and nothing is saved yet', (await ev("return (await fetch('/api/stats').then((r) => r.json())).total")) === 0);
    await shot('04-import-review-desktop');
    await click('button', 'Import now');
    await waitFor("return __h.text().includes('Import finished')", 'finished');
    await click('button', 'Close');
    await waitFor('return __h.qa("tbody tr").length === 12', '12 rows');
    check('12 companies are listed after the import', (await rows()) === 12);
    check('Dashboard shows 12 companies', await ev("return /Companies\\s*12/.test(__h.text())"));
    await shot('05-list-desktop');
    await viewport(390, 844, true);
    await sleep(300);
    check('Mobile (390px): list page has no horizontal page scroll (table scrolls inside its box)', await noHScroll());
    await shot('06-list-mobile');
    await viewport(1280, 900);
  });

  // ---- 3. Search and filters ----
  await step('search and filters', async () => {
    await setBy('input[type=search]', 'linear');
    await waitFor('return __h.qa("tbody tr").length === 1', 'search narrows to 1');
    check('Search finds Linear', await ev("return __h.q('tbody tr').innerText.includes('Linear')"));
    await setBy('input[type=search]', '');
    await waitFor('return __h.qa("tbody tr").length === 12', 'search cleared');
    await setBy('select[aria-label="Location"]', 'India');
    await waitFor('return __h.qa("tbody tr").length === 1', 'location filter');
    check('Location filter -> Northwind Robotics only', await ev("return __h.q('tbody tr').innerText.includes('Northwind')"));
    await setBy('select[aria-label="Location"]', '');
    await setBy('select[aria-label="Stage"]', 'seed');
    await waitFor('return __h.qa("tbody tr").length === 2', 'stage filter');
    check('Stage filter "seed" -> 2 companies', (await rows()) === 2);
    await setBy('select[aria-label="Stage"]', '');
    await click('button', 'Applied');
    await waitFor("return __h.text().includes('No companies match these filters')", 'filtered empty state');
    check('A filter with no matches shows a clear "no matches" state with a way out', await ev("return __h.byText('button', 'Clear filters') !== undefined"));
    await click('button', 'All');
    await waitFor('return __h.qa("tbody tr").length === 12', 'all again');
  });

  // ---- 4. Messy import: duplicates, bad rows, decisions ----
  await step('messy import', async () => {
    await click('button', 'Import CSV');
    await waitFor("return __h.q('[role=dialog]') !== null", 'wizard');
    await upload('sample_startups_messy.csv');
    await waitFor("return __h.text().includes('8 rows')", 'messy mapping');
    check('A bare "Status" column with valid statuses is mapped to application status', await ev("return __h.q('select[aria-label=\"Map column Status\"]').value === 'appStatus'"));
    check('Job Title column is mapped', await ev("return __h.q('select[aria-label=\"Map column Job Title\"]').value === 'jobTitle'"));
    await click('button', 'Review import');
    await waitFor("return /Will create\\s*5/.test(__h.text())", 'messy review');
    const t = await ev('return __h.text()');
    check('Review: 5 to create, 2 skipped as duplicates, 1 failed, 3 possible duplicates', /Will create\s*5/.test(t) && /Will skip\s*2/.test(t) && /Failed rows\s*1/.test(t) && /Possible duplicates\s*3/.test(t), t.slice(0, 200));
    check('Duplicate reasons are shown', t.includes('Same website domain') && t.includes('different website'));
    check('Failed row is explained and an error CSV can be downloaded', t.includes('Missing company name') && t.includes('Download error CSV'));
    check('Unusable values are listed as warnings (kept as extra data)', /value warnings/.test(t));
    await shot('07-import-review-duplicates');
    await ev("__h.set(__h.q('select[aria-label=\"Action for row 9\"]'), 'skip')");
    await waitFor("return /Will create\\s*4/.test(__h.text())", 'row decision updates the plan');
    check('Choosing "Skip" for the possible duplicate updates the plan to 4 creates', true);
    await ev("__h.set(__h.q('select[aria-label=\"Action for row 9\"]'), 'create')");
    await waitFor("return /Will create\\s*5/.test(__h.text())", 'back to 5');
    await click('button', 'Import now');
    await waitFor("return __h.text().includes('Import finished')", 'messy finished');
    await click('button', 'Close');
    await waitFor('return __h.qa("tbody tr").length === 17', '17 rows');
    check('17 companies after the second import; the Unicode name is intact', (await rows()) === 17 && (await ev("return __h.text().includes('Zürich Robotik 東京')")));
  });

  // ---- 5. Applications ----
  await step('applications', async () => {
    await openCompany('Linear');
    await shot('08-drawer-desktop');
    await click('button', 'Add application');
    await ev("__h.set(__h.q('input[placeholder=\"Leave empty for a general application\"]'), 'Backend Intern')");
    await ev("__h.set(__h.qa('[aria-label=\"Applications\"] select')[0], 'To Apply')");
    await ev(`__h.set(__h.qa('[aria-label="Applications"] input[type=date]')[0], ${JSON.stringify(ymd(-3))})`);
    await ev("__h.click(__h.byText('[aria-label=\"Applications\"] form button', 'Add'))");
    await waitFor("return __h.text().includes('Applications (1)')", 'first application');
    await waitFor("return __h.text().includes('Follow-up overdue 3d')", 'overdue label');
    check('A follow-up 3 days ago shows "Follow-up overdue 3d"', true);
    await waitFor("return /1 follow-up due \\(1 overdue\\)/.test(__h.text())", 'banner');
    check('The dashboard banner lists the overdue follow-up', true);
    await click('button', 'Add application');
    await ev("__h.set(__h.q('input[placeholder=\"Leave empty for a general application\"]'), 'AI Engineer Intern')");
    await ev("__h.set(__h.qa('[aria-label=\"Applications\"] select')[0], 'Applied')");
    await ev("__h.click(__h.byText('[aria-label=\"Applications\"] form button', 'Add'))");
    await waitFor("return __h.text().includes('Applications (2)')", 'second application');
    check('Two roles at one company are tracked separately', true);
    await click('button', 'Add application');
    await ev("__h.set(__h.q('input[placeholder=\"Leave empty for a general application\"]'), 'backend  INTERN')");
    await ev("__h.click(__h.byText('[aria-label=\"Applications\"] form button', 'Add'))");
    await waitFor("return __h.text().includes('You already track this role')", 'duplicate refused');
    check('Adding the same role again is refused with a clear message', true);
    await click('button', 'Cancel');
    await ev("__h.set(__h.q('select[aria-label=\"Status for Backend Intern\"]'), 'Interview')");
    await waitFor("return __h.q('select[aria-label=\"Status for Backend Intern\"]').value === 'Interview'", 'status change');
    // The card that was just added starts expanded; only expand it if it is not already open.
    if (!(await ev("return __h.text().includes('Status: To Apply → Interview')"))) {
      await ev("__h.click(__h.byText('[aria-label=\"Applications\"] li button', 'Backend Intern'))");
    }
    await waitFor("return __h.text().includes('Status: To Apply → Interview')", 'history entry');
    check('The status change is in the activity history', true);
    await shot('09-applications-desktop');
    await viewport(390, 844, true);
    await sleep(300);
    check('Mobile (390px): the drawer fits the screen', await ev("const d = __h.q('form.fixed, form'); return __h.qa('form').some((f) => f.getBoundingClientRect().width <= window.innerWidth + 1) && document.documentElement.scrollWidth <= window.innerWidth + 1"));
    await shot('10-drawer-mobile');
    await viewport(1280, 900);
    await closeDrawer();
    await waitFor("return __h.text().includes('Interview · 2 roles')", 'company summary');
    check('The company row shows the furthest status and the number of roles', true);
    await click('button', 'Follow-up due');
    await waitFor('return __h.qa("tbody tr").length === 1', 'follow-up filter');
    check('Quick filter "Follow-up due" shows only Linear', await ev("return __h.q('tbody tr').innerText.includes('Linear')"));
    await click('button', 'All');
    await waitFor('return __h.qa("tbody tr").length === 17', 'all');
  });

  // ---- 6. Outreach draft ----
  await step('outreach', async () => {
    await openCompany('Linear');
    await click('button', 'Write a draft');
    await ev("__h.set(__h.q('[aria-label=\"Outreach drafts\"] select'), 'role_application')");
    await click('button', 'Generate from template');
    await waitFor("return __h.text().includes('Fill in the highlighted details')", 'missing info prompt');
    check('Missing role is asked for instead of guessed', await ev("return __h.text().includes('Which role is this about?')"));
    await ev("__h.set(__h.q('input[placeholder=\"e.g. Backend Intern\"]'), 'Backend Intern')");
    await ev("__h.set(__h.qa('[aria-label=\"Outreach drafts\"] input[maxlength=\"100\"]')[0], 'Sam Lee')");
    await click('button', 'Generate from template');
    await waitFor("return __h.text().includes('Generated text: template')", 'draft generated');
    const body = await ev("return __h.q('[aria-label=\"Outreach drafts\"] textarea').value");
    check('Draft mentions the company, the role, the sender, and the real background', /Linear/.test(body) && /Backend Intern/.test(body) && /Sam Lee/.test(body) && /DIGIT/.test(body) && /Remore/.test(body));
    check('Draft contains no funding claims or invented numbers', !/raised|funding|series|\d{3,}/i.test(body));
    check('The facts used are listed', await ev("return __h.text().includes('Facts used')"));
    check('Copy subject / Copy body buttons exist', await ev("return !!__h.byText('button', 'Copy subject') && !!__h.byText('button', 'Copy body')"));
    await shot('11-outreach-draft');
    await click('button', 'Save draft');
    await waitFor("return __h.text().includes('Draft saved')", 'saved');
    await click('button', 'I sent this');
    await waitFor("return __h.text().includes('Sent manually')", 'marked sent');
    check('"I sent this" records the date after a confirmation; the app sends nothing', dialogs.some((d) => /sent it yourself/.test(d)));
    await closeDrawer();
  });

  // ---- 7. Research: a failure with retry, then a real success ----
  await step('research failure and retry', async () => {
    await openCompany('Northwind Robotics');
    await click('button', 'Run research');
    await waitFor("return __h.text().includes('domain could not be found') || __h.text().includes('Could not connect')", 'research error', 40_000);
    check('A failing website gives a clear error and a Retry button', await ev("return !!__h.byText('button', 'Retry')"));
    await closeDrawer();
  });
  await step('research success', async () => {
    await openCompany('Linear');
    await click('button', 'Run research');
    await waitFor("return __h.text().includes('Last researched')", 'research finished', 90_000);
    check('Research finishes and shows when it ran', true);
    await waitFor("return __h.text().includes('Careers page (')", 'careers finding');
    check('Findings show confidence, evidence and a source link', await ev("return __h.text().includes('verified') && __h.qa('a').some((a) => a.textContent.includes('↗'))"));
    check('Nothing was applied to the company before accepting', await ev("return __h.qa('input').filter((i) => i.value.includes('linear.app/careers')).length === 0"));
    await ev("__h.click(__h.byText('[aria-label=\"Website research\"] button', 'Accept'))");
    await waitFor("return __h.text().includes('Applied to this company')", 'accepted');
    check('Accepting a finding fills the field with its source', await ev("return __h.qa('input').some((i) => i.value === 'https://linear.app/careers')"));
    check('All external links open safely (rel=noopener)', await ev("return __h.qa('a[target=_blank]').every((a) => /noopener/.test(a.rel))"));
    await shot('12-research-desktop');
    await closeDrawer();
  });

  // ---- 8. Export and persistence ----
  await step('export and persistence', async () => {
    const exp = await ev("const r = await fetch('/api/export'); const buf = new Uint8Array(await r.clone().arrayBuffer()); const t = await r.text(); return { ok: r.ok, type: r.headers.get('content-type'), bom: buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, linear: t.includes('Linear'), zurich: t.includes('Zürich Robotik 東京'), lines: t.trim().split('\\n').length }");
    check('Export is UTF-8 CSV with a BOM and includes the data', exp.ok && /text\/csv/.test(exp.type) && exp.bom && exp.linear && exp.zurich, JSON.stringify(exp));
    await setBy('select[aria-label="Stage"]', 'seed');
    // Northwind and Fjord (clean sample) plus Acme (its messy-sheet "Seed" in the Funding column was kept as a stage).
    await waitFor('return __h.qa("tbody tr").length === 3', 'filter before export');
    check('The export link carries the active filter', await ev("return __h.byText('a', 'Export CSV').getAttribute('href').includes('fundingStage=seed')"));
    await setBy('select[aria-label="Stage"]', '');
    await waitFor('return __h.qa("tbody tr").length === 17', 'all rows');
    await cdp.send('Page.navigate', { url: BASE });
    await waitFor('return __h.qa("tbody tr").length === 17', 'reload keeps data');
    check('After a page reload all 17 companies and the Linear summary are still there', await ev("return __h.text().includes('Interview · 2 roles')"));
  });

  // ---- 9. Error and loading states ----
  await step('error and loading states', async () => {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/companies?*' }] });
    cdp.on((m) => { if (m.method === 'Fetch.requestPaused') setTimeout(() => cdp.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {}), 1500); });
    await cdp.send('Page.navigate', { url: BASE });
    await waitFor("return __h.text().includes('Loading')", 'loading state', 8000);
    check('A loading state is shown while the data loads', true);
    await waitFor('return __h.qa("tbody tr").length === 17', 'loaded');
    await cdp.send('Fetch.disable');
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await setBy('input[type=search]', 'x');
    await waitFor("return __h.text().includes('Cannot reach the API')", 'offline error', 8000);
    check('When the API is unreachable a clear error banner appears (role=alert)', await ev("return !!__h.q('[role=alert]')"));
    await shot('13-offline-error');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} UI checks passed. Screenshots: ${OUT}`);
  if (consoleProblems.length) console.log(`Browser console problems (${consoleProblems.length}):\n  - ${[...new Set(consoleProblems)].join('\n  - ')}`);
  else console.log('Browser console: no errors or exceptions.');
  process.exitCode = failed.length ? 1 : 0;
}

try {
  await main();
} catch (e) {
  console.error(`UI check aborted: ${e.message}`);
  process.exitCode = 2;
} finally {
  try { cdp?.close(); } catch { /* ignore */ }
  // Edge starts several processes; kill the whole tree so no headless browser is left holding the debug port.
  try { spawn('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { browser.kill(); }
  await sleep(1500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the folder may still be locked: harmless */ }
  setTimeout(() => process.exit(), 500);
}
