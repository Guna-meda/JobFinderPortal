import robotsParser from 'robots-parser';
import { FetchError, siteKey } from './urlSafety.js';
import {
  loadHtml, extractLinks, classifyLinks, findRoles, findEmails, findFundingLeads, PAGE_KINDS, isAtsHost,
} from './researchExtract.js';

/** Messages shown in the UI. They never contain stack traces, IPs, cookies or internal paths. */
const MESSAGES = {
  invalid_url: ['The website URL is not valid. Fix it and retry.', false],
  blocked_scheme: ['Only http and https websites can be researched.', false],
  blocked_port: ['That port is not allowed (only standard web ports are used).', false],
  blocked_host: ['That website points to an internal or private address, so it was not fetched.', false],
  blocked_address: ['That website resolves to a private or internal address, so it was not fetched.', false],
  dns_failed: ['The website domain could not be found (DNS lookup failed).', true],
  timeout: ['The website took too long to respond.', true],
  connection_failed: ['Could not connect to the website.', true],
  tls_error: ['The website HTTPS certificate could not be verified.', false],
  access_denied: ['The website refused access (login or bot protection). It was not bypassed.', false],
  not_found_page: ['The page was not found (404).', false],
  rate_limited: ['The website asked us to slow down (429). Try again later.', true],
  server_error: ['The website returned a server error.', true],
  http_error: ['The website returned an unexpected HTTP status.', false],
  not_html: ['The URL did not return a web page.', false],
  unsupported_encoding: ['The website sent a compressed response that is not supported.', false],
  redirect_offsite: ['The website redirects to a different site. If that is correct, update the website URL.', false],
  redirect_limit: ['The website redirected too many times.', false],
  robots_disallowed: ['The site robots.txt disallows automated access, so it was not fetched.', false],
  robots_unavailable: ['robots.txt could not be read (server error or timeout), so research was not attempted.', true],
  request_limit: ['The per-company request limit was reached.', false],
  internal: ['Research failed unexpectedly. Try again later.', true],
};

export function describeError(e) {
  const code = e instanceof FetchError ? e.code : 'internal';
  const [message, retryable] = MESSAGES[code] || MESSAGES.internal;
  const out = { code: MESSAGES[code] ? code : 'internal', message, retryable };
  if (code === 'redirect_offsite' && e.location) out.message = `${message} (it redirects to ${new URL(e.location).hostname})`;
  return out;
}

function httpError(status) {
  if (status === 401 || status === 403) return new FetchError('access_denied');
  if (status === 404 || status === 410) return new FetchError('not_found_page');
  if (status === 429) return new FetchError('rate_limited');
  if (status >= 500) return new FetchError('server_error', undefined, { retryable: true });
  return new FetchError('http_error');
}

const pathOf = (u) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search || '/';
  } catch {
    return u;
  }
};

/**
 * One bounded research pass over a company's own website. Produces candidate FINDINGS only; nothing is
 * written to the company. Every finding carries the URL it was observed on and when.
 */
export async function runResearch({ company, fetcher, config, onProgress = async () => {}, now = () => new Date() }) {
  const log = [];
  const findings = [];
  const notFound = [];
  const budget = { used: 0, max: config.maxRequests };
  const deadline = Date.now() + config.deadlineMs;
  let pages = 0;
  let degraded = false; // some page we wanted could not be read

  const result = (status, extra = {}) => ({ status, error: null, findings, notFound, log, pages, ...extra });
  const fail = (e, extra = {}) => {
    const err = describeError(e);
    log.push(`Stopped: ${err.message}`);
    return result('failed', { error: err, ...extra });
  };
  const add = (f) => findings.push({ observedAt: now(), ...f });

  let site;
  try {
    site = fetcher.validate(company.website);
  } catch (e) {
    return fail(e);
  }
  const siteHost = site.hostname;

  // robots.txt per origin, cached for this run.
  const robotsCache = new Map();
  async function robotsFor(url) {
    const u = new URL(url);
    if (robotsCache.has(u.origin)) return robotsCache.get(u.origin);
    let rules = null;
    // Network errors here (unreachable, timeout, blocked) propagate as-is: the site cannot be researched either way.
    const r = await fetcher.get(`${u.origin}/robots.txt`, { siteHost, budget, kind: 'text', maxBytes: 500_000 });
    if (r.status >= 500) throw new FetchError('robots_unavailable', undefined, { retryable: true });
    if (r.status >= 200 && r.status < 300) {
      rules = robotsParser(`${u.origin}/robots.txt`, r.text);
      const delay = rules.getCrawlDelay(config.robotsToken);
      if (delay) fetcher.setHostDelay(u.hostname, delay * 1000);
      log.push(`Read ${u.origin}/robots.txt`);
    } else {
      log.push(`No robots.txt at ${u.origin} (HTTP ${r.status}); no restrictions assumed.`);
    }
    robotsCache.set(u.origin, rules);
    return rules;
  }

  async function readPage(url, label) {
    if (pages >= config.maxPages) throw new FetchError('request_limit');
    if (Date.now() > deadline) throw new FetchError('timeout', undefined, { retryable: true });
    const rules = await robotsFor(url);
    if (rules && rules.isAllowed(url, config.robotsToken) === false) throw new FetchError('robots_disallowed');
    await onProgress(`Reading ${label}`);
    const r = await fetcher.get(url, { siteHost, budget });
    if (r.status < 200 || r.status >= 300) throw httpError(r.status);
    pages++;
    log.push(`Read ${r.url}${r.truncated ? ' (truncated at size limit)' : ''}`);
    return { ...r, $: loadHtml(r.text) };
  }

  // 1. Homepage. Failing here fails the whole run (and is retryable when the cause is transient).
  let home;
  try {
    home = await readPage(site.href, 'homepage');
  } catch (e) {
    if (e instanceof FetchError && e.code === 'redirect_offsite') {
      add({
        kind: 'website', value: e.location, sourceUrl: site.href, basis: 'redirect', confidence: 'unverified',
        evidence: `${site.hostname} redirects to ${new URL(e.location).hostname}. Not followed; confirm it is the right website.`,
      });
    }
    return fail(e);
  }
  const homeHost = new URL(home.url).hostname;

  const extractFrom = (page) => {
    const { emails, personalSkipped } = findEmails(page.$, homeHost);
    for (const m of emails) {
      add({
        kind: 'email', value: m.email, sourceUrl: page.url, basis: m.via === 'mailto' ? 'official-page-mailto' : 'official-page-text',
        confidence: 'verified', meta: { label: m.label },
        evidence: `Publicly listed on ${pathOf(page.url)}${m.label === 'recruiting' ? ' (recruiting-style address)' : ''}.`,
      });
    }
    if (personalSkipped) log.push(`Skipped ${personalSkipped} personal-looking address(es) on ${pathOf(page.url)} (not stored).`);
    for (const f of findFundingLeads(page.$, company.name)) {
      add({
        kind: 'funding', value: f.sentence, sourceUrl: page.url, basis: 'company-statement', confidence: 'unverified',
        meta: { stage: f.stage, amount: f.amount, date: f.date },
        evidence: "The company's own statement; not independently verified.",
      });
    }
  };
  extractFrom(home);

  // 2. Plan a small set of same-site pages from links found on the homepage.
  const plan = classifyLinks(extractLinks(home.$, home.url), homeHost, home.url);
  const queue = [];
  for (const kind of ['careers', 'contact', 'about', 'team', 'press']) {
    const l = plan[kind].site[0];
    if (l) queue.push({ kind, link: l });
  }
  const careersExternal = plan.careers.external[0];

  let careersPage = null;
  const careersLinkSeen = !!plan.careers.site[0] || !!careersExternal;
  for (const { kind, link } of queue) {
    if (pages >= config.maxPages) {
      log.push(`Page limit reached; skipped ${kind} page.`);
      degraded = true;
      break;
    }
    try {
      const page = await readPage(link.href, `${kind} page`);
      if (kind === 'careers') {
        careersPage = page;
        add({
          kind: 'careers', value: page.url, sourceUrl: home.url, basis: 'official-link', confidence: 'verified',
          evidence: `Linked as "${link.text || pathOf(link.href)}" on the company website; the page loaded (HTTP ${page.status}).`,
        });
        for (const r of findRoles(page.$, page.url, homeHost, { keywords: config.roleKeywords, maxRoles: config.maxRoles })) {
          add({
            kind: 'role', value: r.url, title: r.title, sourceUrl: page.url, basis: 'keyword-match', confidence: 'inferred',
            meta: { matched: r.matched },
            evidence: `Link text matched keyword(s): ${r.matched.join(', ')}. A lead only: not confirmed to be open, current or right for you.`,
          });
        }
      }
      if (kind !== 'careers') extractFrom(page);
      else {
        // The careers page can also list a hiring-platform board.
        const ext = classifyLinks(extractLinks(page.$, page.url), homeHost, page.url).careers.external[0];
        if (ext && !careersExternal) plan.careers.external.push(ext);
      }
    } catch (e) {
      if (!(e instanceof FetchError)) throw e;
      if (e.code === 'robots_unavailable') return fail(e, {});
      degraded = true;
      const err = describeError(e);
      log.push(`Could not read ${kind} page (${pathOf(link.href)}): ${err.message}`);
      if (kind === 'careers') {
        add({
          kind: 'careers', value: link.href, sourceUrl: home.url, basis: 'official-link', confidence: 'unverified',
          evidence: `Linked from the company website but the page could not be loaded: ${err.message}`,
        });
      }
    }
  }

  // 3. A hiring-platform link seen on the official site is recorded but never fetched (it is off-site).
  const ext = plan.careers.external[0];
  if (ext && !careersPage) {
    add({
      kind: 'careers', value: ext.href, sourceUrl: home.url, basis: 'official-link', confidence: 'inferred',
      evidence: `Linked as "${ext.text || 'Careers'}" on the company website to a hiring platform (${isAtsHost(ext.host) ? ext.host : 'external site'}). Not fetched.`,
    });
  }

  // 4. What was not detected. "Not detected" never means "does not exist".
  if (!careersLinkSeen && !ext) notFound.push('careers');
  if (careersPage && !findings.some((f) => f.kind === 'role')) notFound.push('roles');
  if (!findings.some((f) => f.kind === 'email')) notFound.push('email');
  if (siteKey(homeHost) !== siteKey(siteHost)) log.push(`Homepage is on ${homeHost}.`);

  return result(degraded ? 'partial' : findings.length ? 'researched' : 'not_found');
}
