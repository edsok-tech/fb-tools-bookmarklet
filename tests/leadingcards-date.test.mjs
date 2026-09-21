import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { createLeadingCardsDateTools } from '../src/leadingcards-date-actions.js';

const day = '2026-08-24';
const seconds = text => Date.parse(text) / 1000;
const card = (uuid, extra = {}) => ({ uuid, nickname: '123456', issue_date: seconds(day + 'T12:00:00Z'), assignee: { uuid: 'me' }, team_uuid: 'team', status_dict: { status: 'ACTIVE' }, last4: '1234', is_closable: { allowed: true }, ...extra });
function fixture(options = {}) {
  const cards = options.cards || [card('a'), card('b')], calls = [];
  let scope = { team: 'team', user: 'me' }, stopped = false;
  const q = (path, params = {}) => { const url = new URL('https://app.leadingcards.com/v1/' + path); for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v); return url.href; };
  const api = async (method, url) => {
    const u = new URL(url), path = u.pathname.replace('/v1/', ''); calls.push({ method, path, page: u.searchParams.get('page') });
    options.onRequest?.(method, path, { stop: () => { stopped = true; }, changeScope: () => { scope = { ...scope, team: 'other' }; } });
    let data;
    if (path === 'cards') {
      const rows = cards.filter(c => c.status_dict.status === u.searchParams.get('status'));
      const page = +u.searchParams.get('page'), size = options.pageSize || 100;
      if (options.failPage === page) throw new Error('Network error');
      data = { total_pages: Math.max(1, Math.ceil(rows.length / size)), results: rows.slice((page - 1) * size, page * size) };
      options.listReply?.(data, page);
    } else {
      const parts = path.split('/'), current = cards.find(c => c.uuid === parts[1]);
      if (!current) throw new Error('Unknown card');
      if (method === 'PUT') {
        if (options.reject) throw new Error('Provider rejected action');
        if (!options.pending) current.status_dict.status = parts[2] === 'block' ? 'PAUSED' : 'CLOSED';
      }
      data = { card: current };
    }
    return structuredClone(data);
  };
  const tools = createLeadingCardsDateTools({ api, q, scope, context: () => scope, stopped: () => stopped, sleep: async () => {} });
  return { tools, api, cards, calls, stop: () => { stopped = true; }, scope: value => { scope = value; } };
}
const writes = f => f.calls.filter(c => c.method === 'PUT');
test('date input accepts the requested formats and rejects rollover dates', () => {
  const t = fixture().tools;
  for (const value of ['24.08.26', '24.08.2026', '24/08/26', day]) assert.equal(t.parseDate(value), day);
  for (const value of ['', '31.02.26', '29.02.26', '08/24/26', '24.08/26', 'yesterday']) assert.throws(() => t.parseDate(value));
  assert.equal(t.parseDate('29.02.24'), '2024-02-29');
});
test('Issue Date uses UTC Unix seconds, not creation ordering, expiry or local time', () => {
  const t = fixture().tools;
  for (const time of ['00:00:00', '23:59:59']) assert.equal(t.issueDate(card('a', { issue_date: seconds(day + 'T' + time + 'Z') })), day);
  assert.equal(t.issueDate({ date_entered_utc: seconds(day + 'T12:00:00Z'), expiry_date: day }), null);
  for (const value of [null, '', 'nonsense', Date.parse(day), {}, Infinity]) assert.equal(t.issueDate({ issue_date: value }), null);
});
test('exact date finds all own cards, including names without account IDs, across every page', async () => {
  const cards = Array.from({ length: 55 }, (_, i) => card('card-' + i, { nickname: i === 54 ? 'no account id' : '123456' }));
  cards.push(card('other-date', { issue_date: seconds('2026-08-25T00:00:00Z') }), card('other-user', { assignee: { uuid: 'someone-else' } }), card('other-team', { team_uuid: 'other' }), card('paused', { status_dict: { status: 'PAUSED' } }));
  const f = fixture({ cards, pageSize: 1 }), plan = await f.tools.find('24.08.26', 'pause');
  assert.equal(plan.selected.length, 55); assert.equal(plan.rows.length, 56); assert.equal(writes(f).length, 0);
  assert.ok(plan.selected.some(c => c.nickname === 'no account id'));
});
test('a failed or incomplete page cannot produce a runnable plan', async () => {
  for (const options of [{ pageSize: 1, failPage: 2 }, { listReply: data => { delete data.total_pages; } }, { listReply: data => { data.results.push(structuredClone(data.results[0])); } }]) {
    const f = fixture(options); await assert.rejects(f.tools.find(day, 'pause')); assert.equal(writes(f).length, 0);
  }
});
test('missing Issue Date blocks complete selection instead of silently using another date', async () => {
  const f = fixture({ cards: [card('a', { issue_date: null })] }); await assert.rejects(f.tools.find(day, 'pause'), /Issue Date/);
});
test('pause only calls block and confirms each card with a fresh GET', async () => {
  const f = fixture(), plan = await f.tools.find(day, 'pause'), results = [];
  const result = await f.tools.run(plan, (...args) => results.push(args));
  assert.equal(result.done, 2); assert.equal(result.errors, 0);
  assert.deepEqual(writes(f).map(c => c.path), ['cards/a/block/', 'cards/b/block/']);
  for (const uuid of ['a', 'b']) assert.equal(f.calls.filter(c => c.method === 'GET' && c.path === 'cards/' + uuid).length, 2);
  assert.equal(results.filter(r => r[1] === 'ok').length, 2);
});
test('permanent close handles active and paused cards and skips a provider prohibition', async () => {
  const f = fixture({ cards: [card('a'), card('b', { status_dict: { status: 'PAUSED' } }), card('c', { is_closable: { allowed: false } })] });
  const plan = await f.tools.find(day, 'close'); assert.equal(plan.rows.length, 3); assert.equal(plan.selected.length, 2);
  const result = await f.tools.run(plan, () => {}); assert.equal(result.done, 2);
  assert.deepEqual(writes(f).map(c => c.path), ['cards/a/close/', 'cards/b/close/']);
});
test('rejected closure does not fall back to pausing', async () => {
  const f = fixture({ reject: true }), plan = await f.tools.find(day, 'close');
  const result = await f.tools.run(plan, () => {}); assert.equal(result.errors, 2); assert.equal(result.done, 0);
  assert.ok(writes(f).every(c => c.path.endsWith('/close/')));
});
test('an accepted request without the target readback status is not success', async () => {
  const f = fixture({ pending: true }), plan = await f.tools.find(day, 'pause');
  const result = await f.tools.run(plan, () => {}); assert.equal(result.done, 0); assert.equal(result.errors, 2);
});
test('new, removed or renamed matching cards invalidate the preview before any writes', async () => {
  for (const change of [f => f.cards.push(card('new')), f => f.cards.pop(), f => { f.cards[0].nickname = 'renamed'; }]) {
    const f = fixture(), plan = await f.tools.find(day, 'close'); change(f);
    await assert.rejects(f.tools.run(plan, () => {}), /изменились/); assert.equal(writes(f).length, 0);
  }
});
test('owner, date and close permission are checked again immediately before the write', async () => {
  for (const change of [c => { c.assignee.uuid = 'other'; }, c => { c.issue_date = seconds('2026-08-25T00:00:00Z'); }, c => { c.is_closable.allowed = false; }]) {
    const f = fixture({ cards: [card('a')], onRequest: (method, path) => { if (method === 'GET' && path === 'cards/a') change(f.cards[0]); } });
    const plan = await f.tools.find(day, 'close'), result = await f.tools.run(plan, () => {});
    assert.equal(result.errors, 1); assert.equal(writes(f).length, 0);
  }
});
test('changing team during a card read stops the batch before its write', async () => {
  const f = fixture({ onRequest: (method, path, controls) => { if (path === 'cards/a') controls.changeScope(); } });
  const plan = await f.tools.find(day, 'pause'); await assert.rejects(f.tools.run(plan, () => {}), /Команда/); assert.equal(writes(f).length, 0);
});
test('Stop after the first action permits readback but prevents another action', async () => {
  const f = fixture({ onRequest: (method, path, controls) => { if (method === 'PUT') controls.stop(); } });
  const plan = await f.tools.find(day, 'pause'), result = await f.tools.run(plan, () => {});
  assert.equal(result.done, 1); assert.equal(result.stopped, true); assert.equal(writes(f).length, 1);
});

async function app(options = {}) {
  const f = fixture(options), { document } = parseHTML('<html><body></body></html>');
  document.cookie = '';
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const source = html.match(/<script id="srcLC" type="text\/plain">([\s\S]*?)<\/script>/)[1].replace(/^javascript:/, '');
  const context = { document, window: {}, location: new URL('https://app.leadingcards.com/personal/cards'), URL, localStorage: { getItem: k => ({ team_uuid: 'team', user_id: 'me' })[k] || '' }, navigator: { clipboard: { writeText: async () => {} } }, confirm: () => { throw new Error('Unexpected legacy action'); }, setTimeout: fn => { fn(); }, setInterval, clearInterval,
    fetch: async (url, options = {}) => {
      const path = new URL(url).pathname;
      const data = path.includes('/cards') ? await f.api(options.method || 'GET', url) : path.includes('/bins') ? { bins: [] } : path.includes('related_users') ? { related_users: [] } : { teams: [] };
      return { ok: true, text: async () => JSON.stringify(data) };
    }
  };
  vm.runInNewContext(source, context);
  for (const select of document.querySelectorAll('select')) Object.defineProperty(select, 'value', { configurable: true, get() { return (this.querySelector('option[selected]') || this.querySelector('option'))?.getAttribute('value') || ''; }, set(v) { for (const o of this.querySelectorAll('option')) { if (o.getAttribute('value') === v) o.setAttribute('selected', ''); else o.removeAttribute('selected'); } } });
  await new Promise(resolve => setImmediate(resolve));
  const $ = id => document.getElementById(id);
  return { ...f, document, $, async find(action = 'pause') { $('lcDDate').value = '24.08.26'; $('lcDAction').value = action; await $('lcDFind').onclick(); } };
}
test('assembled bookmarklet adds the date tab, invalidates edits and performs no action while finding', async () => {
  const a = await app(); assert.equal(a.document.querySelectorAll('#__lcc .tab').length, 3);
  const tab = a.document.querySelector('[data-t="lcTabDate"]'); a.document.querySelector('.tabs').onclick({ target: tab });
  assert.equal(a.$('lcTabDate').style.display, 'flex'); assert.equal(a.$('lcTabIssue').style.display, 'none');
  await a.find(); assert.equal(a.$('lcDGo').disabled, false); assert.equal(writes(a).length, 0);
  a.$('lcDDate').value = '25.08.26'; a.$('lcDDate').oninput(); assert.equal(a.$('lcDGo').disabled, true);
});
test('close confirmation requires the count, locks other actions and can be cancelled without writes', async () => {
  const a = await app(); await a.find('close'); a.$('lcDGo').onclick();
  assert.equal(a.$('lcDYes').disabled, true); assert.equal(a.$('lcGo').disabled, true); assert.equal(a.$('lcCFind').disabled, true);
  a.$('lcDChecked').checked = true; a.$('lcDChecked').onchange(); assert.equal(a.$('lcDYes').disabled, true);
  a.$('lcDCount').value = '1'; a.$('lcDCount').oninput(); assert.equal(a.$('lcDYes').disabled, true);
  a.$('lcDCount').value = '2'; a.$('lcDCount').oninput(); assert.equal(a.$('lcDYes').disabled, false);
  a.$('lcDCancel').onclick(); assert.equal(writes(a).length, 0); assert.equal(a.$('lcGo').disabled, false);
});
test('assembled pause flow confirms results and requires a new search before retry', async () => {
  const a = await app(); await a.find(); a.$('lcDGo').onclick();
  a.$('lcDChecked').checked = true; a.$('lcDChecked').onchange(); await a.$('lcDYes').onclick();
  assert.deepEqual(writes(a).map(c => c.path), ['cards/a/block/', 'cards/b/block/']);
  assert.match(a.$('lcDLog').textContent, /Подтверждено: 2/); assert.equal(a.$('lcDGo').disabled, true); assert.equal(a.$('lcDDate').disabled, false);
});
