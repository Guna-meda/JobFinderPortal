import test from 'node:test';
import assert from 'node:assert/strict';
import {
  roleKey, jobUrlKey, cleanApplicationInput, planUpdate, planCreate, rollup, isOverdue, isDue, appendHistory, HISTORY_CAP,
} from '../src/lib/applications.js';
import { STATUSES } from '../src/lib/csv.js';

const NOW = new Date('2026-10-22T10:00:00Z');
const d = (s) => new Date(`${s}T00:00:00Z`);
const base = (o = {}) => ({ status: 'To Apply', role: 'Backend Intern', jobUrl: '', appliedDate: null, lastContactDate: null, followUpDate: null, ...o });
const rejectsWith = (fn, re) => assert.throws(fn, (e) => e.status === 400 && re.test(e.message));

// ---------- keys ----------

test('role keys ignore case, punctuation and spacing but keep different roles apart', () => {
  assert.equal(roleKey('  Backend  Engineer (Intern) '), roleKey('backend engineer - intern'));
  assert.equal(roleKey(''), '');
  assert.notEqual(roleKey('Backend Engineer'), roleKey('Backend Engineer II'));
  assert.notEqual(roleKey('AI Engineer'), roleKey('Backend Engineer'));
  assert.equal(roleKey('Ingénieur Logiciel'), roleKey('ingénieur   logiciel!'));
});

test('job URL keys ignore www, trailing slashes, fragments and tracking parameters only', () => {
  const k = jobUrlKey('https://www.acme.io/jobs/123/?utm_source=x&ref=y#apply');
  assert.equal(k, jobUrlKey('http://acme.io/jobs/123'));
  assert.notEqual(k, jobUrlKey('https://acme.io/jobs/124'));
  assert.notEqual(jobUrlKey('https://acme.io/jobs?id=1'), jobUrlKey('https://acme.io/jobs?id=2'));
  assert.equal(jobUrlKey('not a url'), '');
});

// ---------- validation ----------

test('input is validated and normalised', () => {
  const out = cleanApplicationInput({
    role: '  AI Intern ', jobUrl: 'acme.io/jobs/1', status: 'Applied', appliedDate: '2026-10-01', followUpDate: '2026-11-01',
    lastContactDate: '2026-10-05', contactName: ' Priya ', contactEmail: 'priya@acme.io', contactUrl: 'linkedin.com/in/priya', nextAction: 'Email Priya', notes: '  keep spacing ', ignored: 'x',
  }, { now: NOW });
  assert.deepEqual(
    [out.role, out.jobUrl, out.status, out.contactName, out.contactUrl, out.notes, 'ignored' in out],
    ['AI Intern', 'https://acme.io/jobs/1', 'Applied', 'Priya', 'https://linkedin.com/in/priya', '  keep spacing ', false]
  );
  assert.equal(out.appliedDate.toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(out.followUpDate.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.deepEqual(cleanApplicationInput({ followUpDate: '', appliedDate: null, jobUrl: '' }, { now: NOW }), { followUpDate: null, appliedDate: null, jobUrl: '' });
});

test('invalid URLs, dates, statuses, emails and types are rejected', () => {
  const bad = (body, re) => rejectsWith(() => cleanApplicationInput(body, { now: NOW }), re);
  bad({ jobUrl: 'not a url' }, /valid web address/);
  bad({ jobUrl: 'javascript:alert(1)' }, /valid web address/);
  bad({ contactUrl: 'http://' }, /valid web address/);
  bad({ appliedDate: '2026-02-31' }, /real date/);
  bad({ appliedDate: '10/05/2026' }, /real date/);
  bad({ followUpDate: 'tomorrow' }, /real date/);
  bad({ followUpDate: 20261001 }, /must be a date/);
  bad({ appliedDate: '2026-12-25' }, /future/);
  bad({ lastContactDate: '2027-01-01' }, /future/);
  bad({ status: 'Hired' }, /Invalid status/);
  bad({ status: { $ne: 'x' } }, /Invalid status/);
  bad({ contactEmail: 'nope' }, /email/);
  bad({ role: { $gt: '' } }, /must be text/);
  bad({ notes: ['a'] }, /must be text/);
  bad({ role: 'x'.repeat(201) }, /too long/);
  bad({ notes: 'x'.repeat(5001) }, /too long/);
  bad(null, /JSON object/);
  bad([], /JSON object/);
  // A follow-up in the future is normal; so is "today" in any time zone.
  assert.doesNotThrow(() => cleanApplicationInput({ followUpDate: '2027-01-01', appliedDate: '2026-10-23' }, { now: NOW }));
});

// ---------- status transitions and history ----------

test('every status can move to every other status, each recorded in the history', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const { set, history } = planUpdate(base({ status: from }), { status: to }, NOW);
      if (from === to) {
        assert.deepEqual([set, history], [{}, []]);
      } else {
        assert.equal(set.status, to);
        assert.equal(history[0].type, 'status');
        assert.deepEqual([history[0].from, history[0].to], [from, to]);
      }
    }
  }
});

test('moving to Applied or later records the applied date once, without inventing one on other moves', () => {
  const applied = planUpdate(base(), { status: 'Applied' }, NOW);
  assert.equal(applied.set.appliedDate.toISOString(), '2026-10-22T00:00:00.000Z');
  assert.deepEqual(applied.history.map((h) => h.type), ['status', 'applied']);
  for (const status of ['Replied', 'Interview', 'Offer']) assert.ok(planUpdate(base(), { status }, NOW).set.appliedDate, status);
  for (const status of ['Not Applied', 'To Apply', 'Rejected']) assert.ok(!planUpdate(base({ status: 'Applied' }), { status }, NOW).set.appliedDate, status);
  // an existing or explicit date is respected
  assert.ok(!('appliedDate' in planUpdate(base({ appliedDate: d('2026-09-01') }), { status: 'Applied' }, NOW).set));
  assert.equal(planUpdate(base(), { status: 'Applied', appliedDate: d('2026-10-01') }, NOW).set.appliedDate.toISOString(), '2026-10-01T00:00:00.000Z');
  // moving backwards never erases dates
  const back = planUpdate(base({ status: 'Interview', appliedDate: d('2026-10-01'), lastContactDate: d('2026-10-10') }), { status: 'To Apply' }, NOW);
  assert.ok(!('appliedDate' in back.set) && !('lastContactDate' in back.set));
});

test('replies, interviews, offers and rejections fill a missing last-contact date only', () => {
  for (const status of ['Replied', 'Interview', 'Offer', 'Rejected']) {
    assert.equal(planUpdate(base({ status: 'Applied', appliedDate: d('2026-10-01') }), { status }, NOW).set.lastContactDate.toISOString(), '2026-10-22T00:00:00.000Z');
  }
  const kept = planUpdate(base({ status: 'Applied', appliedDate: d('2026-10-01'), lastContactDate: d('2026-10-05') }), { status: 'Replied' }, NOW);
  assert.ok(!('lastContactDate' in kept.set));
});

test('follow-up, applied, contact and detail changes are logged; notes and no-ops are not', () => {
  const cur = base({ status: 'Applied', appliedDate: d('2026-10-01') });
  assert.match(planUpdate(cur, { followUpDate: d('2026-10-15') }, NOW).history[0].summary, /Follow-up set for 2026-10-15/);
  const moved = planUpdate({ ...cur, followUpDate: d('2026-10-15') }, { followUpDate: d('2026-10-30') }, NOW);
  assert.deepEqual([moved.history[0].type, moved.history[0].from, moved.history[0].to], ['followUp', '2026-10-15', '2026-10-30']);
  assert.match(planUpdate({ ...cur, followUpDate: d('2026-10-15') }, { followUpDate: null }, NOW).history[0].summary, /cleared/);
  assert.match(planUpdate(cur, { appliedDate: d('2026-09-28') }, NOW).history[0].summary, /2026-10-01 → 2026-09-28/);
  assert.match(planUpdate(cur, { lastContactDate: d('2026-10-10') }, NOW).history[0].summary, /Last contact recorded: 2026-10-10/);
  const details = planUpdate(cur, { role: 'AI Intern', jobUrl: 'https://acme.io/j/1' }, NOW);
  assert.deepEqual(details.history.map((h) => h.type), ['details', 'details']);
  assert.equal(details.set.roleKey, roleKey('AI Intern'));
  assert.ok(details.set.jobUrlKey);
  assert.deepEqual(planUpdate(cur, { notes: 'new note', nextAction: 'ping', contactName: 'P' }, NOW).history, []);
  assert.deepEqual(planUpdate(cur, { status: 'Applied', followUpDate: null, role: 'Backend Intern' }, NOW), { set: {}, history: [] });
});

test('a follow-up before the applied date is rejected', () => {
  rejectsWith(() => planUpdate(base({ appliedDate: d('2026-10-10') }), { followUpDate: d('2026-10-01') }, NOW), /before the applied date/);
  rejectsWith(() => planUpdate(base({ followUpDate: d('2026-10-01') }), { appliedDate: d('2026-10-10') }, NOW), /before the applied date/);
  rejectsWith(() => planCreate({ appliedDate: d('2026-10-10'), followUpDate: d('2026-10-01') }, { now: NOW }), /before the applied date/);
  assert.doesNotThrow(() => planUpdate(base({ appliedDate: d('2026-10-10') }), { followUpDate: d('2026-10-10') }, NOW));
});

test('new applications default to To Apply and only user-created ones autofill dates', () => {
  assert.equal(planCreate({}, { now: NOW }).status, 'To Apply');
  const user = planCreate({ status: 'Interview' }, { now: NOW });
  assert.ok(user.appliedDate && user.lastContactDate);
  const migrated = planCreate({ status: 'Interview' }, { now: NOW, autofill: false });
  assert.ok(!migrated.appliedDate && !migrated.lastContactDate);
  assert.equal(planCreate({ role: 'A  B' }, { now: NOW }).roleKey, 'a b');
});

// ---------- rollup and overdue ----------

const A = (status, extra = {}) => ({ status, ...extra });

test('rollup picks the furthest status and ignores finished applications for follow-ups', () => {
  assert.deepEqual(rollup([]), { appStatus: 'Not Applied', appStatuses: [], applicationCount: 0, appliedDate: null, followUpDate: null, lastContactDate: null });
  assert.equal(rollup([A('Applied'), A('Interview'), A('Rejected')]).appStatus, 'Interview');
  assert.equal(rollup([A('Rejected'), A('To Apply')]).appStatus, 'To Apply');
  assert.equal(rollup([A('Rejected'), A('Rejected')]).appStatus, 'Rejected');
  assert.equal(rollup([A('Applied'), A('Offer')]).appStatus, 'Offer');
  const r = rollup([
    A('Applied', { appliedDate: d('2026-10-05'), followUpDate: d('2026-10-20'), lastContactDate: d('2026-10-06') }),
    A('Interview', { appliedDate: d('2026-09-30'), followUpDate: d('2026-10-25'), lastContactDate: d('2026-10-12') }),
    A('Rejected', { followUpDate: d('2026-10-01') }),
    A('Offer', { followUpDate: d('2026-10-02') }),
  ]);
  assert.equal(r.applicationCount, 4);
  assert.deepEqual(r.appStatuses.sort(), ['Applied', 'Interview', 'Offer', 'Rejected']);
  assert.equal(r.appliedDate.toISOString().slice(0, 10), '2026-09-30');
  assert.equal(r.followUpDate.toISOString().slice(0, 10), '2026-10-20'); // earliest OPEN follow-up
  assert.equal(r.lastContactDate.toISOString().slice(0, 10), '2026-10-12');
  assert.equal(rollup([A('Rejected', { followUpDate: d('2026-10-01') })]).followUpDate, null);
});

test('overdue and due follow-ups', () => {
  const app = (status, date) => ({ status, followUpDate: date ? d(date) : null });
  assert.equal(isOverdue(app('Applied', '2026-10-21'), NOW), true);
  assert.equal(isOverdue(app('Applied', '2026-10-22'), NOW), false); // due today, not overdue
  assert.equal(isDue(app('Applied', '2026-10-22'), NOW), true);
  assert.equal(isDue(app('Applied', '2026-10-23'), NOW), false);
  for (const status of ['Rejected', 'Offer']) {
    assert.equal(isOverdue(app(status, '2026-01-01'), NOW), false);
    assert.equal(isDue(app(status, '2026-01-01'), NOW), false);
  }
  assert.equal(isOverdue(app('Applied', null), NOW), false);
});

test('history is capped, keeping the most recent entries', () => {
  const many = Array.from({ length: HISTORY_CAP + 10 }, (_, i) => ({ type: 'note', summary: `n${i}` }));
  const out = appendHistory([], many, NOW);
  assert.equal(out.length, HISTORY_CAP);
  assert.equal(out.at(-1).summary, `n${HISTORY_CAP + 9}`);
});
