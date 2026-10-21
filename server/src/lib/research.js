import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';
import { normalizeUrl, domainOf } from './csv.js';

const UA = 'StartupFinderBot/1.0 (personal job-search tool; few polite requests per company)';
const TIMEOUT_MS = 8000;
const MAX_BYTES = 1_000_000;
const MAX_PAGES = 4; // hard cap per company
const ROLE_RX = /\b(engineer|developer|software|backend|back-end|frontend|front-end|full[\s-]?stack|sde|swe|machine learning|devops|sre|intern)\b/i;
const CAREER_LINK_RX = /career|jobs|join[\s-]?us|work[\s-]?with[\s-]?us|hiring|open[\s-]?positions/i;
const CONTACT_LINK_RX = /contact|about/i;
const GENERIC_EMAIL_RX = /^(careers?|jobs?|hiring|hr|recruit(ing|ment)?|talent|people|hello|contact|info|team|founders?|support)@/i;
const EMAIL_RX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const HIRING_RX = /career|job|hiring|recruit|talent|people|hr@/;

function isPrivateIp(ip) {
  if (net.isIPv6(ip)) return ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith('::ffff:127.');
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function assertPublic(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs allowed');
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('Refusing to fetch private/internal address');
}

async function fetchText(url) {
  await assertPublic(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const type = res.headers.get('content-type') || '';
  if (!res.ok) return { ok: false, status: res.status, url: res.url };
  if (!type.includes('html')) return { ok: false, status: res.status, url: res.url, reason: 'not html' };
  const buf = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_BYTES);
  return { ok: true, status: res.status, url: res.url, html: buf.toString('utf8') };
}

/** Minimal robots.txt check: honours Disallow for "*" and our UA. If robots.txt is absent, allow. */
async function robotsAllows(url) {
  try {
    const u = new URL(url);
    const res = await fetch(`${u.origin}/robots.txt`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return true;
    let applies = false;
    for (const raw of (await res.text()).split(/\r?\n/)) {
      const m = raw.split('#')[0].trim().match(/^([a-z-]+)\s*:\s*(.*)$/i);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key === 'user-agent') applies = m[2] === '*' || /startupfinder/i.test(m[2]);
      else if (applies && key === 'disallow' && m[2] && u.pathname.startsWith(m[2])) return false;
    }
    return true;
  } catch {
    return true;
  }
}

function findLink($, base, rx) {
  let best = null;
  $('a[href]').each((_, el) => {
    if (best) return;
    const href = $(el).attr('href') || '';
    if (!(rx.test($(el).text()) || rx.test(href))) return;
    try {
      const abs = new URL(href, base);
      if (/^https?:$/.test(abs.protocol)) best = abs.href.split('#')[0];
    } catch {
      /* ignore bad hrefs */
    }
  });
  return best;
}

export function findEmails($, siteDomain) {
  const found = new Set();
  $('a[href^="mailto:"]').each((_, el) => {
    const e = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (e) found.add(e);
  });
  $('script,style,noscript').remove();
  const text = ($('body').html() || '').replace(/<[^>]+>/g, ' ');
  for (const m of text.match(EMAIL_RX) || []) found.add(m.toLowerCase());
  return [...found]
    .filter((e) => !/\.(png|jpe?g|gif|svg|webp)$/.test(e))
    .filter((e) => e.endsWith(`@${siteDomain}`) || e.endsWith(`.${siteDomain}`) || GENERIC_EMAIL_RX.test(e));
}

const ATS_HOSTS = /(^|\.)(lever\.co|greenhouse\.io|ashbyhq\.com|workable\.com|bamboohr\.com|recruitee\.com|smartrecruiters\.com|breezy\.hr|wellfound\.com|keka\.com|zohorecruit\.com)$/i;
const JOB_PATH = /career|job|position|opening|apply|role|vacanc/i;

// Only links that look like job postings: same site (job-like path) or a known ATS host.
export function findRoles($, base) {
  const roles = new Map();
  $('a[href]').each((_, el) => {
    const title = $(el).text().replace(/\s+/g, ' ').trim().replace(/[→>»]+$/, '').trim();
    if (title.length < 4 || title.length > 100 || !ROLE_RX.test(title)) return;
    try {
      const u = new URL($(el).attr('href'), base);
      const host = u.hostname.replace(/^www\./, '');
      const internal = host === domainOf(base) && JOB_PATH.test(u.pathname);
      if (internal || ATS_HOSTS.test(host)) roles.set(title, u.href);
    } catch {
      /* ignore */
    }
  });
  return [...roles].slice(0, 15).map(([title, url]) => ({ title, url }));
}

/**
 * Best-effort, polite research of a company's own website.
 * Returns only values actually observed, each with the URL it came from. Never guesses,
 * and never touches funding fields.
 */
export async function researchCompany(company) {
  const log = [];
  const out = { researchStatus: 'failed', researchLog: log };
  const site = normalizeUrl(company.website);
  if (!site) {
    log.push('No valid website URL on record; nothing to research.');
    return out;
  }
  let pages = 0;
  const get = async (url) => {
    if (pages >= MAX_PAGES) {
      log.push(`Page limit (${MAX_PAGES}) reached; skipped ${url}`);
      return null;
    }
    if (!(await robotsAllows(url))) {
      log.push(`robots.txt disallows ${url}; skipped`);
      return null;
    }
    pages++;
    try {
      const r = await fetchText(url);
      log.push(r.ok ? `Fetched ${r.url} (${r.status})` : `Could not fetch ${url} (${r.status}${r.reason ? ', ' + r.reason : ''})`);
      return r.ok ? r : null;
    } catch (e) {
      log.push(`Error fetching ${url}: ${e.cause?.code || e.message}`);
      return null;
    }
  };

  const home = await get(site);
  if (!home) return out;
  const $home = cheerio.load(home.html);
  const siteDomain = domainOf(home.url) || domainOf(site);
  let found = 0;

  // Careers page: a link observed on the homepage, fetched to confirm it loads.
  const careersLink = findLink($home, home.url, CAREER_LINK_RX);
  if (careersLink) {
    const page = await get(careersLink);
    if (page) {
      out.careersUrl = page.url;
      out.careersSourceUrl = home.url;
      out.careersVerified = true;
      found++;
      const roles = findRoles(cheerio.load(page.html), page.url);
      out.openRoles = roles;
      out.hasRelevantRoles = roles.length ? 'yes' : 'unknown';
      log.push(
        roles.length
          ? `Found ${roles.length} engineering-looking link(s) on the careers page (text match; verify manually).`
          : 'No engineering-looking role links on the careers page (it may be JS-rendered; this is not proof of no openings).'
      );
    } else {
      log.push(`Careers link ${careersLink} was seen on the homepage but did not load; not saved.`);
    }
  } else {
    log.push('No careers link found on the homepage.');
  }

  // Emails: homepage first, then one contact/about page on the same site.
  let emails = findEmails($home, siteDomain).map((e) => ({ e, src: home.url }));
  if (!emails.length) {
    const contactLink = findLink($home, home.url, CONTACT_LINK_RX);
    if (contactLink && domainOf(contactLink) === domainOf(home.url)) {
      const page = await get(contactLink);
      if (page) emails = findEmails(cheerio.load(page.html), siteDomain).map((e) => ({ e, src: page.url }));
    }
  }
  if (emails.length) {
    emails.sort((a, b) => Number(HIRING_RX.test(b.e)) - Number(HIRING_RX.test(a.e)));
    out.contactEmail = emails[0].e;
    out.contactEmailSourceUrl = emails[0].src;
    found++;
    log.push(`Public email ${emails[0].e} found on ${emails[0].src}${emails.length > 1 ? ` (+${emails.length - 1} other)` : ''}.`);
  } else {
    log.push('No public email found on fetched pages.');
  }

  out.researchStatus = found >= 2 ? 'researched' : 'partial';
  return out;
}
