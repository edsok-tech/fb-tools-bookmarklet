// Issue date is card.issue_date (Unix seconds), displayed in UTC by LeadingCards.
// Verified against the public Cards table and app-dt-date component on 2026-09-21.
export function createLeadingCardsDateTools(env) {
  function parseDate(value) {
    const text = String(value || '').trim();
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const local = text.match(/^(\d{1,2})([./])(\d{1,2})\2(\d{2}|\d{4})$/);
    if (!iso && !local) throw new Error('Введи дату выпуска: ДД.ММ.ГГ, например 24.08.26.');
    const y = iso ? +iso[1] : (local[4].length === 2 ? 2000 + +local[4] : +local[4]);
    const m = iso ? +iso[2] : +local[3], d = iso ? +iso[3] : +local[1];
    const date = new Date(Date.UTC(y, m - 1, d));
    if (y < 2000 || y > 2099 || date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw new Error('Такой даты нет. Проверь день, месяц и год.');
    return date.toISOString().slice(0, 10);
  }
  function displayDate(key) { return key.split('-').reverse().join('.'); }
  function issueDate(card) {
    const value = card && card.issue_date;
    if (value === null || value === undefined || value === '' || !['number', 'string'].includes(typeof value)) return null;
    const seconds = Number(value), date = new Date(seconds * 1000);
    if (!Number.isFinite(seconds) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2099 || !Number.isFinite(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  }
  function status(card) { return card && card.status_dict && card.status_dict.status; }
  function assertContext(scope) {
    const now = env.context();
    if (!scope.team || !scope.user || now.team !== scope.team || now.user !== scope.user) throw new Error('Команда или пользователь изменились. Обнови страницу и открой закладку снова.');
  }
  function assertRunning(scope) {
    assertContext(scope);
    if (env.stopped()) throw new Error('Остановлено. Новый поиск обязателен перед повторным запуском.');
  }
  function own(card, scope) {
    return card.assignee && card.assignee.uuid === scope.user && (!card.team_uuid || card.team_uuid === scope.team);
  }
  function allowed(card, action) {
    const s = status(card);
    if (action === 'pause') return s === 'ACTIVE';
    return (s === 'ACTIVE' || s === 'PAUSED') && !(card.is_closable && card.is_closable.allowed === false);
  }
  function fingerprint(cards) {
    return JSON.stringify(cards.map(c => [c.uuid, issueDate(c), c.nickname || '', status(c), c.assignee.uuid, c.is_closable && c.is_closable.allowed]).sort((a, b) => a[0].localeCompare(b[0])));
  }
  async function load(scope) {
    const cards = new Map();
    for (const state of ['ACTIVE', 'PAUSED']) {
      let expectedPages = null;
      for (let page = 1; ; page++) {
        assertRunning(scope);
        env.progress && env.progress('Загружаю ' + state + ': страница ' + page + '…');
        const data = await env.api('GET', env.q('cards', { status: state, ordering: '-date_entered_utc', count: '100', page: String(page) }));
        assertRunning(scope);
        const pages = Number(data.total_pages);
        if (!Array.isArray(data.results) || !Number.isInteger(pages) || pages < 0 || pages > 10000 || (!pages && data.results.length)) throw new Error('Не удалось подтвердить полный список страниц карт. Поиск не завершён.');
        if (expectedPages !== null && expectedPages !== pages) throw new Error('Список карт изменился во время загрузки. Повтори поиск.');
        expectedPages = pages;
        if (page < pages && !data.results.length) throw new Error('Получена пустая промежуточная страница. Повтори поиск.');
        for (const card of data.results) {
          if (!own(card, scope)) continue;
          if (!card.uuid || !issueDate(card)) throw new Error('У одной из твоих карт отсутствует ID или Issue Date. Полный отбор по дате не подтверждён.');
          if (cards.has(card.uuid)) throw new Error('Страницы карт пересеклись во время загрузки. Повтори поиск.');
          cards.set(card.uuid, card);
        }
        if (page >= pages) break;
      }
    }
    return [...cards.values()];
  }
  async function find(value, action) {
    if (!['pause', 'close'].includes(action)) throw new Error('Выбери действие с картами.');
    const date = parseDate(value), scope = { ...env.scope };
    assertRunning(scope);
    const rows = (await load(scope)).filter(c => issueDate(c) === date);
    const selected = rows.filter(c => allowed(c, action));
    return { date, action, scope, rows, selected, fingerprint: fingerprint(selected) };
  }
  async function run(plan, onResult) {
    assertRunning(plan.scope);
    const fresh = await find(plan.date, plan.action);
    if (fresh.fingerprint !== plan.fingerprint) throw new Error('Состав, название или статус карт изменились после поиска. Проверь новый список — действия ещё не отправлялись.');
    const result = { done: 0, skipped: 0, errors: 0, stopped: false };
    const target = plan.action === 'pause' ? 'PAUSED' : 'CLOSED';
    for (const card of plan.selected) {
      if (env.stopped()) { result.stopped = true; break; }
      assertContext(plan.scope);
      onResult(card, 'working', plan.action === 'pause' ? 'Ставлю на паузу…' : 'Закрываю…');
      try {
        const reply = await env.api('GET', env.q('cards/' + encodeURIComponent(card.uuid)));
        assertRunning(plan.scope);
        const current = reply.card;
        if (!current || current.uuid !== card.uuid || !own(current, plan.scope) || issueDate(current) !== plan.date || (current.nickname || '') !== (card.nickname || '')) throw new Error('Карта изменилась или принадлежит другому пользователю. Пропущена.');
        if (status(current) === target) {
          result.skipped++; onResult(card, 'skip', 'Уже ' + target); continue;
        }
        if (!allowed(current, plan.action)) throw new Error('Действие недоступно для текущего состояния карты: ' + (status(current) || 'неизвестно'));
        assertRunning(plan.scope);
        // Never turn a refused close into a pause, and never call close from pause mode.
        await env.api('PUT', env.q('cards/' + encodeURIComponent(card.uuid) + (plan.action === 'pause' ? '/block/' : '/close/')), {});
        assertContext(plan.scope);
        const verified = await env.api('GET', env.q('cards/' + encodeURIComponent(card.uuid)));
        assertContext(plan.scope);
        if (!verified.card || verified.card.uuid !== card.uuid || !own(verified.card, plan.scope) || status(verified.card) !== target) throw new Error('Запрос отправлен, но статус ' + target + ' ещё не подтверждён. Проверь карту перед повтором.');
        result.done++; onResult(card, 'ok', target === 'PAUSED' ? 'На паузе · подтверждено' : 'Закрыта · подтверждено');
      } catch (error) {
        result.errors++; onResult(card, 'err', error.message);
        assertContext(plan.scope);
      }
      if (env.stopped()) { result.stopped = true; break; }
      await env.sleep(500);
    }
    return result;
  }
  return { parseDate, displayDate, issueDate, status, allowed, find, run };
}

export function mountLeadingCardsDateActions(env) {
  const box = env.box, doc = box.ownerDocument;
  const pane = doc.createElement('div');
  pane.id = 'lcTabDate'; pane.className = 'bd'; pane.style.display = 'none';
  pane.innerHTML = '<div class="mh b">Карты текущего пользователя в выбранной команде. Отбор строго за один день, как в колонке <b>Issue Date</b> (UTC), независимо от названия карты.</div>' +
    '<div class="g" style="grid-template-columns:1fr 1fr"><div><label for="lcDDate">Дата выпуска · Issue Date</label><input id="lcDDate" type="text" placeholder="24.08.26" autocomplete="off"><div class="log">ДД.ММ.ГГ или ДД.ММ.ГГГГ</div></div><div><label for="lcDAction">Действие</label><select id="lcDAction"><option value="pause">Поставить на паузу</option><option value="close">Закрыть навсегда</option></select></div></div>' +
    '<div id="lcDHint" class="log"></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="lcDFind">Найти карты</button><button class="btn p" id="lcDGo" disabled>Поставить на паузу</button><button class="btn" id="lcDStop" style="display:none">Стоп</button></div>' +
    '<div class="log" id="lcDLog" role="status"></div><div class="clist" id="lcDList"></div><div id="lcDConfirm" style="display:none"></div>';
  box.appendChild(pane);
  const tab = doc.createElement('div'); tab.className = 'tab'; tab.dataset.t = pane.id; tab.textContent = 'По дате выпуска'; box.querySelector('.tabs').appendChild(tab);
  const $ = id => pane.querySelector('#' + id);
  let phase = '', plan = null, stopped = false, held = [];
  const log = (text, type = '') => { $('lcDLog').textContent = text; $('lcDLog').className = 'log ' + type; };
  const tools = createLeadingCardsDateTools({ ...env, stopped: () => stopped, progress: text => log(text) });
  function lock(next) {
    phase = next;
    for (const id of ['lcDDate', 'lcDAction', 'lcDFind']) $(id).disabled = !!next;
    $('lcDGo').disabled = !!next || !plan || !plan.selected.length;
    $('lcDStop').style.display = next === 'find' || next === 'run' ? '' : 'none';
    if (next && !held.length) {
      held = ['lcGo', 'lcCheck', 'lcDet', 'lcCFind', 'lcCGo'].map(id => { const el = box.querySelector('#' + id); const was = el.disabled; el.disabled = true; return [el, was]; });
    } else if (!next) { held.forEach(([el, was]) => { el.disabled = was; }); held = []; }
  }
  function hint() {
    const close = $('lcDAction').value === 'close';
    $('lcDHint').textContent = close ? 'Закрытие необратимо. Карты, для которых LeadingCards запрещает закрытие, будут отмечены в списке.' : 'Временная пауза: карту можно возобновить в LeadingCards. Уже приостановленные карты повторно не обрабатываются.';
    $('lcDGo').textContent = close ? 'Закрыть навсегда' : 'Поставить на паузу';
    $('lcDGo').className = 'btn ' + (close ? 'r' : 'p');
  }
  function invalidate() { plan = null; $('lcDList').textContent = ''; $('lcDGo').disabled = true; log('Дата или действие изменены — нажми «Найти карты».'); hint(); }
  $('lcDDate').oninput = invalidate; $('lcDAction').onchange = invalidate;
  function render() {
    const root = $('lcDList'); root.textContent = '';
    if (!plan || !plan.rows.length) return;
    const append = (values, kind) => {
      const row = doc.createElement('div'); row.className = 'ci ' + kind;
      row.style.gridTemplateColumns = '1.4fr .7fr .9fr .7fr 1.8fr';
      values.forEach(value => { const cell = doc.createElement('span'); cell.textContent = value; row.appendChild(cell); }); root.appendChild(row);
    };
    append(['Название', 'Карта', 'Issue Date', 'Статус', 'Результат / действие'], 'h');
    for (const card of plan.rows) {
      const selected = tools.allowed(card, plan.action);
      const note = card._dateResult || (selected ? (plan.action === 'pause' ? 'Будет на паузе' : 'Будет закрыта навсегда') : tools.status(card) === 'PAUSED' && plan.action === 'pause' ? 'Уже на паузе' : 'Недоступно: ' + ((card.is_closable && (card.is_closable.reason || card.is_closable.details)) || 'запрет LeadingCards'));
      const shownStatus = ['ok', 'skip'].includes(card._dateState) ? (plan.action === 'pause' ? 'PAUSED' : 'CLOSED') : tools.status(card);
      append([card.nickname || '(без названия)', card.censored_number || (card.last4 ? '…' + card.last4 : '—'), tools.displayDate(tools.issueDate(card)), shownStatus || '—', note], card._dateState === 'err' ? 'er' : card._dateState === 'ok' ? 'ok' : '');
    }
  }
  function available() {
    if (phase || env.locked()) { log('Дождись завершения текущей операции с картами.', 'wa'); return false; }
    return true;
  }
  $('lcDFind').onclick = async function () {
    if (!available()) return;
    stopped = false; plan = null; $('lcDList').textContent = ''; lock('find');
    try {
      plan = await tools.find($('lcDDate').value, $('lcDAction').value); render();
      log('Дата ' + tools.displayDate(plan.date) + ': найдено ' + plan.rows.length + ', к действию ' + plan.selected.length + ', без изменения ' + (plan.rows.length - plan.selected.length) + '. Проверь список.', plan.selected.length ? 'wa' : 'ok');
    } catch (error) { log(error.message, 'er'); }
    finally { lock(''); }
  };
  $('lcDStop').onclick = function () { stopped = true; log('Останавливаю после текущего запроса…', 'wa'); };
  $('lcDGo').onclick = function () {
    if (!available() || !plan || !plan.selected.length) return;
    lock('confirm');
    const close = plan.action === 'close', count = plan.selected.length, root = $('lcDConfirm');
    root.style.display = ''; root.className = 'mh ' + (close ? 'r' : 'b');
    root.innerHTML = '<b id="lcDConfirmText"></b><p>' + (close ? 'Закрытые карты нельзя восстановить.' : 'Оплата этими картами будет приостановлена.') + '</p><label class="rd"><input type="checkbox" id="lcDChecked"> Я проверил список карт</label>' +
      (close ? '<label for="lcDCount" style="margin-top:8px">Введи количество карт для подтверждения</label><input id="lcDCount" inputmode="numeric" autocomplete="off">' : '') +
      '<div style="display:flex;gap:8px;margin-top:10px"><button class="btn" id="lcDCancel">Отмена</button><button class="btn ' + (close ? 'r' : 'p') + '" id="lcDYes" disabled>Подтвердить</button></div>';
    $('lcDConfirmText').textContent = (close ? 'Закрыть навсегда ' : 'Поставить на паузу ') + count + ' карт за ' + tools.displayDate(plan.date) + '?';
    const update = () => { $('lcDYes').disabled = !$('lcDChecked').checked || (close && $('lcDCount').value.trim() !== String(count)); };
    $('lcDChecked').onchange = update; if (close) $('lcDCount').oninput = update;
    $('lcDCancel').onclick = () => { root.style.display = 'none'; lock(''); log('Отменено — карты не изменялись.'); };
    $('lcDYes').onclick = async function () {
      if (this.disabled || phase !== 'confirm') return;
      this.disabled = true; root.style.display = 'none'; stopped = false; lock('run');
      try {
        const result = await tools.run(plan, (card, state, text) => { card._dateState = state; card._dateResult = text; render(); });
        log((result.stopped ? 'Остановлено. ' : 'Готово. ') + 'Подтверждено: ' + result.done + ', уже в нужном статусе: ' + result.skipped + ', ошибок: ' + result.errors + '. Для повторного запуска выполни новый поиск.', result.errors ? 'wa' : 'ok');
      } catch (error) { log(error.message, 'er'); }
      finally { plan = null; lock(''); }
    };
  };
  hint();
  return { busy: () => !!phase };
}
