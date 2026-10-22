// Security regression tests that need no database: network exposure, headers, error hygiene, limits, secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { errorHandler, securityFromEnv, hostGuard, DEFAULT_HOSTS, DEFAULT_ORIGINS } from '../src/middleware/security.js';
import { maskUri } from '../src/lib/mask.js';
import { NO_LIMITS } from './helpers/limits.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');

// Services are stubbed so these tests never touch MongoDB. Anything reaching the database would hang, which
// itself proves the guards run first.
let outreachBoom = null;
const stubs = {
  research: {},
  applications: { removeForCompany: async () => {} },
  outreach: { config: () => { if (outreachBoom) throw outreachBoom; return { aiAvailable: false, model: null, purposes: [] }; }, removeForCompany: async () => {} },
};
const build = (extra = {}) => createApp({ ...stubs, limits: NO_LIMITS, ...extra });
const quiet = async (fn) => { const o = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = o; } };

// ---------- who may talk to the API ----------

test('only this machine\'s own host names are accepted (DNS rebinding)', async () => {
  const app = build();
  for (const host of ['evil.example', 'evil.example:4000', 'localhost.evil.example', '192.168.1.20:4000', '10.0.0.5', 'attacker.com:80']) {
    const r = await request(app).get('/api/health').set('Host', host);
    assert.equal(r.status, 403, host);
    assert.equal(r.body.code, 'host_not_allowed');
  }
  for (const host of ['localhost:4000', 'LOCALHOST:5173', '127.0.0.1:4000', '[::1]:4000', 'localhost']) {
    assert.equal((await request(app).get('/api/health').set('Host', host)).status, 200, host);
  }
});

test('browser requests from other sites are refused; our own page origins work; CORS is never a wildcard', async () => {
  const app = build();
  const evil = await request(app).post('/api/import').set('Origin', 'http://evil.example');
  assert.equal(evil.status, 403);
  assert.equal(evil.body.code, 'origin_not_allowed');
  const pre = await request(app).options('/api/companies/abc').set('Origin', 'http://evil.example').set('Access-Control-Request-Method', 'DELETE');
  assert.equal(pre.status, 403);
  assert.ok(!pre.headers['access-control-allow-origin']);
  assert.equal((await request(app).get('/api/health').set('Origin', 'https://localhost:5173')).status, 403, 'wrong scheme');
  for (const origin of DEFAULT_ORIGINS) {
    const ok = await request(app).get('/api/health').set('Origin', origin);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], origin);
  }
  const noOrigin = await request(app).get('/api/health'); // curl / the Vite proxy
  assert.equal(noOrigin.status, 200);
  assert.notEqual(noOrigin.headers['access-control-allow-origin'], '*');
  assert.ok(!('access-control-allow-credentials' in ok(noOrigin.headers)));
});
const ok = (h) => h;

test('allowed hosts and origins can be configured from the environment, with safe defaults', () => {
  assert.deepEqual(securityFromEnv({}), { allowedHosts: DEFAULT_HOSTS, allowedOrigins: DEFAULT_ORIGINS });
  assert.deepEqual(securityFromEnv({ ALLOWED_HOSTS: 'a.test, b.test', CORS_ORIGINS: 'http://a.test:1' }), { allowedHosts: ['a.test', 'b.test'], allowedOrigins: ['http://a.test:1'] });
  assert.ok(!DEFAULT_HOSTS.includes('*') && !DEFAULT_ORIGINS.includes('*'));
  const guard = hostGuard(['only.test']);
  let status;
  guard({ headers: { host: 'localhost' } }, { status: (s) => ({ json: () => { status = s; } }) }, () => { status = 'next'; });
  assert.equal(status, 403);
});

test('the server listens on this machine only and sets request timeouts', () => {
  const src = fs.readFileSync(path.join(here, '../src/index.js'), 'utf8');
  assert.match(src, /process\.env\.HOST \|\| '127\.0\.0\.1'/);
  assert.match(src, /\.listen\(port, host/);
  assert.match(src, /requestTimeout = 60_000/);
  assert.match(src, /headersTimeout/);
});

// ---------- responses ----------

test('API responses carry hardening headers and no framework banner', async () => {
  const app = build();
  const r = await request(app).get('/api/health');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
  assert.match(r.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.ok(!('x-powered-by' in r.headers));
});

test('unknown paths get a JSON 404, not an HTML error page that echoes the path', async () => {
  const app = build();
  for (const p of ['/nope', '/api/nope', '/<script>alert(1)</script>', '/api/companies/1/2/3/4']) {
    const r = await request(app).get(p);
    assert.equal(r.status, 404, p);
    assert.match(r.headers['content-type'], /json/);
    assert.deepEqual(r.body, { error: 'Not found' });
  }
});

test('malformed and oversized request bodies are rejected without leaking parser internals', async () => {
  const app = build();
  const bad = await request(app).post('/api/companies').set('Content-Type', 'application/json').send('{bad json');
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { error: 'The request body is not valid JSON.', code: 'bad_json' });
  const big = await request(app).post('/api/companies').set('Content-Type', 'application/json').send(JSON.stringify({ name: 'x'.repeat(2 * 1024 * 1024) }));
  assert.equal(big.status, 413);
  assert.ok(!/PayloadTooLarge|limit|bytes/i.test(JSON.stringify(big.body)));
});

test('server errors never expose stack traces, paths, connection strings or hostnames', async () => {
  outreachBoom = new Error('connect ECONNREFUSED mongodb://admin:hunter2@10.0.0.5:27017/prod at /srv/app/node_modules/mongodb/lib/x.js:12:5');
  try {
    const r = await quiet(() => request(build()).get('/api/outreach/config'));
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Internal server error' });
    assert.ok(!/hunter2|10\.0\.0\.5|node_modules|\/srv\/|ECONNREFUSED|at .*\.js/.test(JSON.stringify(r.body)));
  } finally {
    outreachBoom = null;
  }
});

function run(err) {
  let out = {};
  const res = { headersSent: false, status(s) { out.status = s; return this; }, json(b) { out.body = b; return this; } };
  const original = console.error;
  console.error = () => {};
  try { errorHandler(err, { method: 'POST', path: '/x' }, res, () => {}); } finally { console.error = original; }
  return out;
}

test('error handler maps database, upload and parser errors to generic client messages', () => {
  const validation = Object.assign(new Error('Company validation failed: name: Cast to string failed for value "{ $gt: \'\' }" at path "name" for model "Company"'), { name: 'ValidationError', errors: { name: {}, location: {} } });
  const v = run(validation);
  assert.equal(v.status, 400);
  assert.equal(v.body.error, 'Invalid value for: name, location.');
  const c = run(Object.assign(new Error('Cast to ObjectId failed for value "x" (type string) at path "_id" for model "Company"'), { name: 'CastError', path: '_id' }));
  assert.deepEqual([c.status, c.body.error], [400, 'Invalid value for _id.']);
  assert.equal(run(Object.assign(new Error('Unexpected field'), { name: 'MulterError', code: 'LIMIT_UNEXPECTED_FILE' })).status, 400);
  assert.equal(run(Object.assign(new Error('x'), { name: 'MulterError', code: 'LIMIT_FILE_SIZE' })).status, 413);
  assert.equal(run({ type: 'entity.too.large' }).status, 413);
  for (const out of [v, c]) assert.ok(!/model|Cast to|mongoose|path "/i.test(JSON.stringify(out.body)));
  assert.deepEqual(run(new Error('secret db detail')).body, { error: 'Internal server error' });
  assert.equal(run(Object.assign(new Error('nope'), { status: 418 })).status, 418);
  // a deliberately safe 5xx message (partial import) is shown, an ordinary 500 is not
  const partial = run(Object.assign(new Error('The import stopped partway (2 saved).'), { status: 500, expose: true, code: 'partial_import' }));
  assert.deepEqual([partial.status, partial.body.code], [500, 'partial_import']);
});

// ---------- rate limits ----------

test('every API call is rate limited per client', async () => {
  const app = build({ limits: { ...NO_LIMITS, general: { max: 5, windowMs: 60_000 } } });
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await request(app).get('/api/health')).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  const r = await request(app).get('/api/health');
  assert.equal(r.body.code, 'rate_limited');
  assert.ok(Number(r.headers['retry-after']) >= 1);
});

test('expensive endpoints have their own tighter limits (research, batch research, import, drafting)', async () => {
  const tight = { max: 2, windowMs: 60_000 };
  const app = build({ limits: { ...NO_LIMITS, research: tight, batch: tight, import: tight, outreach: tight } });
  // Each request below is rejected by validation before any database work, so only the limiter decides the 3rd.
  const hit = (method, url, body) => request(app)[method](url).send(body);
  const cases = [
    ['post', '/api/companies/not-an-id/research', {}],
    ['post', '/api/research/batch', { ids: [] }],
    ['post', '/api/outreach/generate', {}],
  ];
  for (const [m, u, b] of cases) {
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await hit(m, u, b)).status);
    assert.deepEqual([codes[0] < 429, codes[1] < 429, codes[2]], [true, true, 429], `${u}: ${codes}`);
  }
  // CSV preview and import share one budget: two calls in total, then the limiter answers.
  const imp = [];
  for (const u of ['/api/import', '/api/import/preview', '/api/import']) imp.push((await hit('post', u, {})).status);
  assert.deepEqual([imp[0] < 429, imp[1] < 429, imp[2]], [true, true, 429], `import: ${imp}`);
  // other endpoints are not affected by those limits
  assert.equal((await request(app).get('/api/health')).status, 200);
});

// ---------- upload limits ----------

test('uploads accept one CSV and a few small fields; floods and extra files are refused', async () => {
  const app = build();
  const csv = Buffer.from('Company\nAcme\n');
  let r = request(app).post('/api/import/preview').attach('file', csv, { filename: 'a.csv', contentType: 'text/csv' });
  for (let i = 0; i < 12; i++) r = r.field(`extra${i}`, 'x');
  const flood = await r;
  assert.equal(flood.status, 400);
  assert.equal(flood.body.code, 'bad_upload');
  const two = await request(app).post('/api/import/preview').attach('file', csv, { filename: 'a.csv' }).attach('other', csv, { filename: 'b.csv' });
  assert.equal(two.status, 400);
  const wrongName = await request(app).post('/api/import/preview').attach('notfile', csv, { filename: 'a.csv' });
  assert.equal(wrongName.status, 400);
  const notCsv = await request(app).post('/api/import/preview').attach('file', Buffer.from('MZ\x00\x01'), { filename: 'virus.exe' });
  assert.equal(notCsv.status, 400);
  assert.match(notCsv.body.error, /Only \.csv/);
});

// ---------- secrets ----------

test('connection strings are masked in anything that is printed, even passwords containing @', () => {
  for (const [input, secret] of [
    ['mongodb://user:s3cret@localhost:27017/db', 's3cret'],
    ['mongodb://user:p@ss:w0rd@host/db?authSource=admin', 'w0rd'],
    ['mongodb+srv://u:pw123@cluster0.abc.mongodb.net/db', 'pw123'],
    ['connect failed for mongodb://admin:hunter2@10.0.0.5:27017/prod (timeout)', 'hunter2'],
    ['mongodb://host/db?password=topsecret&x=1', 'topsecret'],
  ]) {
    const out = maskUri(input);
    assert.ok(!out.includes(secret), `${input} -> ${out}`);
    assert.ok(out.includes('***'));
  }
  assert.equal(maskUri('mongodb://127.0.0.1:27017/startup-finder'), 'mongodb://127.0.0.1:27017/startup-finder');
});

const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};

test('no secret-shaped strings exist in the source, docs or examples, and the example key is empty', () => {
  const files = ['server/src', 'server/scripts', 'client/src', 'docs'].flatMap((d) => walk(path.join(ROOT, d)));
  files.push(path.join(ROOT, 'README.md'), path.join(ROOT, 'server/.env.example'), path.join(ROOT, 'docker-compose.yml'));
  assert.ok(files.length > 30);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/sk-ant-[A-Za-z0-9_-]{20,}/.test(text), `Anthropic key shape in ${f}`);
    assert.ok(!/mongodb(\+srv)?:\/\/[^\s/@]+:[^\s/@]{3,}@/.test(text), `credentials in a connection string in ${f}`);
  }
  const example = fs.readFileSync(path.join(ROOT, 'server/.env.example'), 'utf8');
  assert.match(example, /^ANTHROPIC_API_KEY=$/m);
});

test('the browser bundle source reads no secrets and the real .env is not tracked by git', () => {
  for (const f of walk(path.join(ROOT, 'client/src'))) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/import\.meta\.env|process\.env/.test(text), `${f} reads environment variables`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^\.env$/m);
  let tracked = '';
  try { tracked = execFileSync('git', ['ls-files', '--', '**/.env', '.env'], { cwd: ROOT, encoding: 'utf8' }); } catch { /* git unavailable: the .gitignore check above still ran */ }
  assert.equal(tracked.trim(), '');
});
