import * as cheerio from 'cheerio';
import { sameSite, siteKey } from './urlSafety.js';
import { normalizeFundingStage } from './csv.js';

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Text of a node with a space between child elements, so "Engineer<span>Berlin</span>" doesn't glue together. */
export function textOf($, el) {
  const html = $(el).html() || '';
  return collapse(cheerio.load(`<div>${html.replace(/<[^>]+>/g, ' ')}</div>`).text());
}

export function loadHtml(html) {
  // cheerio only parses; scripts are never executed. Malformed markup is repaired, never thrown on.
  return cheerio.load(String(html || ''));
}

const MAX_LINKS = 2000;
const SKIP_EXT = /\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|mov|docx?|xlsx?|pptx?|rar|gz|dmg|exe)(\?|$)/i;

export function extractLinks($, baseUrl) {
  const seen = new Set();
  const links = [];
  $('a[href]').each((_, el) => {
    if (links.length >= MAX_LINKS) return false;
    const raw = ($(el).attr('href') || '').trim();
    if (!raw || /^(mailto|tel|javascript|data):/i.test(raw) || raw.startsWith('#')) return;
    let u;
    try {
      u = new URL(raw, baseUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(u.protocol) || SKIP_EXT.test(u.pathname)) return;
    u.hash = '';
    const href = u.href;
    const text = textOf($, el);
    const key = `${href}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ href, text, host: u.hostname, path: u.pathname });
  });
  return links;
}

const KINDS = {
  careers: { text: /\b(careers?|jobs?|join (us|our team|the team)|work (with|at|for) us|we'?re hiring|open positions?|openings?)\b/i, path: /\/(careers?|jobs?|join(-us)?|work-with-us|hiring|openings?|positions?)(\/|$)/i },
  contact: { text: /\b(contact( us)?|get in touch|reach us)\b/i, path: /\/(contact(-us)?|get-in-touch)(\/|$)/i },
  about: { text: /\b(about( us)?|our (story|company)|company|who we are)\b/i, path: /\/(about(-us)?|company|who-we-are|our-story)(\/|$)/i },
  team: { text: /\b(team|people|leadership|founders)\b/i, path: /\/(team|people|leadership|founders)(\/|$)/i },
  press: { text: /\b(press|news(room)?|media)\b/i, path: /\/(press|news(room)?|media)(\/|$)/i },
};
export const PAGE_KINDS = Object.keys(KINDS);

const ATS_HOSTS = /(^|\.)(lever\.co|greenhouse\.io|ashbyhq\.com|workable\.com|bamboohr\.com|recruitee\.com|smartrecruiters\.com|breezy\.hr|wellfound\.com|keka\.com|zohorecruit\.com|jobs\.gem\.com|rippling\.com|teamtailor\.com|personio\.(de|com))$/i;
export const isAtsHost = (host) => ATS_HOSTS.test(String(host).replace(/^www\./, ''));

/**
 * Classify the links of the official site into page kinds. Same-site links can be fetched (within limits);
 * external links are only recorded, never fetched, except that nothing outside the company site is crawled.
 */
export function classifyLinks(links, siteHost, pageUrl) {
  const out = Object.fromEntries(PAGE_KINDS.map((k) => [k, { site: [], external: [] }]));
  const self = pageUrl ? new URL(pageUrl).href.replace(/\/$/, '') : '';
  for (const l of links) {
    if (l.href.replace(/\/$/, '') === self) continue;
    for (const [kind, rx] of Object.entries(KINDS)) {
      if (!(rx.text.test(l.text) && l.text.length <= 40) && !rx.path.test(l.path)) continue;
      if (sameSite(l.host, siteHost)) out[kind].site.push(l);
      else if (kind === 'careers' && isAtsHost(l.host)) out[kind].external.push(l);
      break;
    }
  }
  return out;
}

// ---------- role leads ----------

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function compileKeywords(keywords) {
  const parts = keywords.map((k) => esc(String(k).toLowerCase().trim()).replace(/(\\ |\s)+/g, '[\\s-]+')).filter(Boolean);
  return parts.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
}

const TITLE_NOISE = /\s*(learn more|apply( now| here)?|view( role| job| details)?|read more|see (role|details)|[→›»>]+)\s*$/i;
const NOT_A_JOB_PATH = /\/(blog|news|press|articles?|posts?|stories|events?|podcast|docs?|changelog)(\/|$)/i;

/**
 * Role LEADS: links on a careers page whose text matches a keyword. Not proof that a job is open or suitable.
 */
export function findRoles($, pageUrl, siteHost, { keywords, maxRoles = 25 }) {
  const rx = compileKeywords(keywords);
  if (!rx) return [];
  const found = new Map();
  for (const l of extractLinks($, pageUrl)) {
    let title = l.text;
    for (let i = 0; i < 3; i++) title = title.replace(TITLE_NOISE, '').trim();
    if (title.length < 4 || title.length > 120 || title.split(' ').length < 2) continue;
    const matched = [...new Set([...title.matchAll(rx)].map((m) => m[0].toLowerCase()))];
    if (!matched.length) continue;
    const internal = sameSite(l.host, siteHost);
    if (!internal && !isAtsHost(l.host)) continue;
    if (internal && (NOT_A_JOB_PATH.test(l.path) || l.href === pageUrl)) continue;
    // One lead per job link, even if it appears several times with different link text.
    if (!found.has(l.href)) found.set(l.href, { title, url: l.href, matched });
    if (found.size >= maxRoles) break;
  }
  return [...found.values()];
}

// ---------- emails ----------

const RECRUITING = /^(careers?|jobs?|hiring|hr|recruit(ing|ment|er|ers)?|talent|people|work)$/i;
const GENERAL = /^(hello|hi|hey|contact|info|team|founders?|mail|office|enquiries|inquiries)$/i;
// The lookbehind makes each start position O(1) to reject and the length caps bound the rest, so a huge
// token with no "@" cannot cause quadratic regex time.
const EMAIL_RX = /(?<![a-z0-9._%+-])[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){1,5}/gi;

/**
 * Only role-style addresses on the company's own domain are reported (careers@, jobs@, hello@, ...).
 * Personal-looking addresses are counted but never stored, and obfuscated addresses are not decoded.
 */
export function findEmails($, siteHost) {
  const key = siteKey(siteHost);
  const found = new Map();
  let personalSkipped = 0;
  const add = (raw, via) => {
    const email = raw.toLowerCase().replace(/[.,;:)>\]]+$/, '');
    const at = email.lastIndexOf('@');
    const local = email.slice(0, at).split('+')[0];
    const domain = email.slice(at + 1);
    if (!domain || siteKey(domain) !== key || /\.(png|jpe?g|gif|svg|webp)$/.test(domain)) return;
    const label = RECRUITING.test(local) ? 'recruiting' : GENERAL.test(local) ? 'general' : null;
    if (!label) {
      personalSkipped++;
      return;
    }
    if (!found.has(email)) found.set(email, { email, label, via });
  };
  $('a[href^="mailto:"]').each((_, el) => {
    const e = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
    if (/^[^@\s]+@[^@\s]+$/.test(e)) add(e, 'mailto');
  });
  $('script,style,noscript').remove();
  const text = ($('body').html() || $.root().html() || '').replace(/<[^>]+>/g, ' ');
  for (const m of text.match(EMAIL_RX) || []) add(m, 'text');
  return { emails: [...found.values()], personalSkipped };
}

// ---------- funding leads (company statements only) ----------

const AMOUNT = /[$€£₹]\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|mm|mn|million|b|bn|billion|crore|lakh)?(?![a-z])/i;
const STAGE = /\b(pre-?seed|seed|series\s?[a-e])\b/i;
const VERB = /\b(raised|raises|secured|closed|announced|funding|funded|investment|led by)\b/i;
const FIRST_PERSON = /\b(we|we've|we have|our)\b/i;
const DATE = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? (?:\d{1,2},? )?\d{4}\b|\b\d{4}-\d{2}(?:-\d{2})?\b/i;

/**
 * Sentences on the company's own pages that talk about raising money. These are the company's own claims,
 * returned as unverified leads with only the values literally present in the sentence. Nothing is inferred.
 */
export function findFundingLeads($, companyName, { max = 3 } = {}) {
  $('script,style,noscript').remove();
  const text = collapse(cheerio.load(`<div>${($.root().html() || '').replace(/<[^>]+>/g, '\n')}</div>`).text());
  const first = String(companyName || '').split(/\s+/)[0] || '';
  const nameRx = first.length >= 3 ? new RegExp(`\\b${esc(first)}\\b`, 'i') : null;
  const leads = [];
  const seen = new Set();
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    const sentence = collapse(s);
    if (sentence.length < 20 || sentence.length > 300) continue;
    if (!VERB.test(sentence) || !(AMOUNT.test(sentence) || STAGE.test(sentence))) continue;
    if (!(FIRST_PERSON.test(sentence) || (nameRx && nameRx.test(sentence)))) continue;
    const k = sentence.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const stage = (sentence.match(STAGE) || [])[0];
    leads.push({
      sentence,
      stage: stage ? normalizeFundingStage(stage) : undefined,
      amount: (sentence.match(AMOUNT) || [])[0]?.trim(),
      date: (sentence.match(DATE) || [])[0],
    });
    if (leads.length >= max) break;
  }
  return leads;
}
