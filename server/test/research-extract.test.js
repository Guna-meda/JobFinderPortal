import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadHtml, extractLinks, classifyLinks, findRoles, findEmails, findFundingLeads, compileKeywords,
} from '../src/lib/researchExtract.js';
import { DEFAULT_ROLE_KEYWORDS } from '../src/config/research.js';

const BASE = 'https://acme.io/';
const roles = (html, opts = {}) =>
  findRoles(loadHtml(html), 'https://acme.io/careers', 'acme.io', { keywords: DEFAULT_ROLE_KEYWORDS, ...opts });

// ---------- links ----------

test('classifies careers, contact, about, team and press links; external non-ATS links are ignored', () => {
  const $ = loadHtml(`<nav>
    <a href="/careers">Careers</a><a href="/contact-us">Contact</a><a href="/about">About us</a>
    <a href="/team">Team</a><a href="/press">Press</a>
    <a href="https://jobs.lever.co/acme">We're hiring</a><a href="https://twitter.com/acme">Careers on X</a>
    <a href="mailto:hi@acme.io">Email</a><a href="/careers.pdf">Careers PDF</a><a href="#top">Top</a>
  </nav>`);
  const c = classifyLinks(extractLinks($, BASE), 'acme.io', BASE);
  assert.equal(c.careers.site[0].href, 'https://acme.io/careers');
  assert.equal(c.contact.site[0].path, '/contact-us');
  assert.equal(c.about.site[0].path, '/about');
  assert.equal(c.team.site[0].path, '/team');
  assert.equal(c.press.site[0].path, '/press');
  assert.equal(c.careers.external.length, 1);
  assert.equal(c.careers.external[0].host, 'jobs.lever.co');
  assert.ok(!extractLinks($, BASE).some((l) => /twitter|mailto|\.pdf|#/.test(l.href) && l.host === 'acme.io'));
  assert.ok(![...c.careers.site, ...c.careers.external].some((l) => l.host === 'twitter.com'));
});

test('subdomain careers sites count as same-site', () => {
  const $ = loadHtml('<a href="https://careers.acme.io/">Join us</a><a href="https://acme.io.evil.com/careers">Careers</a>');
  const c = classifyLinks(extractLinks($, BASE), 'acme.io', BASE);
  assert.deepEqual(c.careers.site.map((l) => l.host), ['careers.acme.io']);
});

// ---------- roles ----------

test('role keyword matches are leads: titles cleaned, deduped, with the matched keywords', () => {
  const found = roles(`
    <a href="/careers/1"><span>Backend Engineer</span><span>Berlin</span><span>Learn more →</span></a>
    <a href="/careers/1">Backend Engineer</a>
    <a href="https://boards.greenhouse.io/acme/jobs/9">Machine Learning Intern</a>
    <a href="/careers/3">Account Executive</a>
    <a href="/blog/engineering-culture">Engineering culture at Acme</a>
    <a href="/careers/4">Engineering</a>`);
  assert.deepEqual(found.map((r) => r.title), ['Backend Engineer Berlin', 'Machine Learning Intern']);
  assert.deepEqual(found[0].matched, ['backend', 'engineer']);
  assert.ok(found[1].matched.includes('machine learning'));
  assert.equal(found[0].url, 'https://acme.io/careers/1');
});

test('role keywords are configurable and match whole words only', () => {
  const html = '<a href="/c/1">Product Designer</a><a href="/c/2">Backend Engineer</a><a href="/c/3">Chair Assistant</a>';
  assert.deepEqual(roles(html, { keywords: ['designer'] }).map((r) => r.title), ['Product Designer']);
  assert.deepEqual(roles(html).map((r) => r.title), ['Backend Engineer']); // "ai" must not match inside "Chair"
  assert.deepEqual(roles(html, { keywords: [] }), []);
  assert.deepEqual(roles(html, { keywords: ['designer', 'engineer'], maxRoles: 1 }).length, 1);
  assert.ok(compileKeywords(['full stack']).test('Full-Stack Developer'));
});

test('role links must be same-site job-like pages or known hiring platforms', () => {
  const found = roles('<a href="https://news.example.org/x">Software Engineer story</a><a href="https://jobs.lever.co/a/1">Software Engineer</a>');
  assert.deepEqual(found.map((r) => r.url), ['https://jobs.lever.co/a/1']);
});

// ---------- emails ----------

test('emails: only role-style addresses on the company domain; personal and foreign ones are never stored', () => {
  const $ = loadHtml(`<body>
    <a href="mailto:Careers@acme.io?subject=Hi">Apply</a>
    <p>Reach us at hello@acme.io, or Jobs@Careers.acme.io.</p>
    <p>Founder: jane.doe@acme.io and contact@gmail.com and support@acme.io</p>
    <p>obfuscated: people [at] acme.io</p>
    <script>var x = "secret@acme.io"</script>
    <img src="logo@2x.png"></body>`);
  const { emails, personalSkipped } = findEmails($, 'www.acme.io');
  assert.deepEqual(emails.map((e) => e.email).sort(), ['careers@acme.io', 'hello@acme.io', 'jobs@careers.acme.io']);
  assert.equal(emails.find((e) => e.email === 'careers@acme.io').label, 'recruiting');
  assert.equal(emails.find((e) => e.email === 'careers@acme.io').via, 'mailto');
  assert.equal(emails.find((e) => e.email === 'hello@acme.io').label, 'general');
  assert.ok(personalSkipped >= 2); // jane.doe@ and support@ counted, not stored
});

test('emails are not glued to neighbouring text', () => {
  const { emails } = findEmails(loadHtml('<p>Questions</p><p>hello@acme.io</p>'), 'acme.io');
  assert.deepEqual(emails.map((e) => e.email), ['hello@acme.io']);
});

// ---------- funding ----------

test('funding leads contain only what the sentence literally says', () => {
  const $ = loadHtml(`<p>Acme raised a $5M seed round in March 2024. We closed our Series A led by Foo Capital.</p>
    <p>Startups raised $10M last year. We are raising a seed round soon. Our customers secured funding too.</p>`);
  const leads = findFundingLeads($, 'Acme Robotics');
  assert.equal(leads.length, 2);
  assert.deepEqual([leads[0].stage, leads[0].amount, leads[0].date], ['seed', '$5M', 'March 2024']);
  assert.deepEqual([leads[1].stage, leads[1].amount, leads[1].date], ['series-a', undefined, undefined]);
  assert.ok(!leads.some((l) => /Startups raised/.test(l.sentence))); // not about the company
  assert.ok(!leads.some((l) => /are raising/.test(l.sentence))); // not a completed round
});

test('no funding sentence means no funding lead', () => {
  assert.deepEqual(findFundingLeads(loadHtml('<p>We build robots for warehouses.</p>'), 'Acme'), []);
});

// ---------- malformed input ----------

test('malformed, empty, hostile and huge HTML never throws', () => {
  const inputs = [
    '', '   ', null, undefined, '<<<>>>', '<a href="/careers>Careers', '<div><a href=/x>Unclosed <b>bold <i>', '\u0000\u0001<a href="/careers">Careers',
    '<a href="javascript:alert(1)">Careers</a>', '<a href="http://[::1">x</a>', '<a>no href</a>', '<script>while(true){}</script><a href="/jobs">Jobs</a>',
    '<a href="/careers">'.repeat(5000), `<p>${'x'.repeat(2_000_000)}</p>`, '<table><tr><td><a href="/jobs">Jobs',
  ];
  for (const html of inputs) {
    const $ = loadHtml(html);
    assert.doesNotThrow(() => {
      const links = extractLinks($, BASE);
      classifyLinks(links, 'acme.io', BASE);
      findRoles($, 'https://acme.io/careers', 'acme.io', { keywords: DEFAULT_ROLE_KEYWORDS });
      findEmails($, 'acme.io');
      findFundingLeads($, 'Acme');
    });
  }
  // Unclosed markup is repaired, so the link is still found; scripts are never executed.
  const c = classifyLinks(extractLinks(loadHtml('<table><tr><td><a href="/jobs">Jobs'), BASE), 'acme.io', BASE);
  assert.equal(c.careers.site[0].path, '/jobs');
});
