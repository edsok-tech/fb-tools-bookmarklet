// The payment threshold is configured through Meta's own billing dialog.
// No undocumented write endpoint, spend_cap, or card spending limit is used.
export function createPaymentThresholdTools(env) {
  const norm = s => String(s || '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim();
  const textOf = el => norm(typeof el.innerText === 'string' ? el.innerText : el.textContent);
  const visible = env.visible;
  const all = (root, selector) => Array.from(root.querySelectorAll(selector)).filter(visible);
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = /^(you'll pay when|when you'll pay|payment threshold)$/i;
  const dialogTitle = /^(billing date and threshold|edit payment threshold|change payment threshold)$/i;
  function currencyCode(currency) {
    if (!/^[A-Z]{3}$/.test(currency || '')) throw new Error('Валюта кабинета не подтверждена.');
    if (Intl.supportedValuesOf && !Intl.supportedValuesOf('currency').includes(currency)) throw new Error('Неизвестная валюта кабинета: ' + currency);
    return currency;
  }
  function amount(value, currency) {
    currencyCode(currency);
    const raw = String(value).trim().replace(',', '.');
    if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error('Введи положительную сумму без разделителей тысяч: ' + currency);
    const digits = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    if ((raw.split('.')[1] || '').length > digits) throw new Error('Для ' + currency + ' допустимо знаков после точки: ' + digits);
    const valueNumber = Number(raw);
    if (!(valueNumber > 0) || !Number.isSafeInteger(Math.round(valueNumber * (10 ** digits)))) throw new Error('Некорректная сумма порога.');
    return valueNumber;
  }
  function money(text, currency) {
    currencyCode(currency);
    text = norm(text);
    const codes = text.match(/\b[A-Z]{3}\b/g) || [];
    const known = Intl.supportedValuesOf ? Intl.supportedValuesOf('currency') : ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'RUB'];
    if (codes.some(c => known.includes(c) && c !== currency)) return null;
    const tokens = [currency];
    for (const display of ['symbol', 'narrowSymbol']) {
      const part = new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: display }).formatToParts(1).find(p => p.type === 'currency');
      if (part) tokens.push(part.value);
    }
    const token = [...new Set(tokens)].sort((a, b) => b.length - a.length).map(escape).join('|');
    const number = '(\\d+(?:,\\d{3})*(?:\\.\\d+)?)';
    const rx = new RegExp('(?:' + token + ')\\s*' + number + '|' + number + '\\s*(?:' + token + ')', 'g');
    const values = [...text.matchAll(rx)].map(m => Number((m[1] || m[2]).replace(/,/g, '')));
    return values.length && new Set(values).size === 1 ? values[0] : null;
  }
  function buttonName(button) { return norm(button.getAttribute('aria-label') || textOf(button)); }
  function section(doc, currency, needEdit) {
    const anchors = all(doc, 'h1,h2,h3,h4,h5,h6,div,span,p').filter(el => heading.test(textOf(el)));
    for (const anchor of anchors) {
      let root = anchor;
      for (let i = 0; root && i < 7; i++, root = root.parentElement) {
        const text = textOf(root);
        // Never widen the search into an unrelated payment/spending control.
        if (text.length > 1000 || /account spending limit|daily spending limit|payment methods|add payment method/i.test(text)) break;
        const edits = all(root, 'button,[role="button"]').filter(b => /^(edit|change|manage)( payment threshold| billing date and threshold)?$/i.test(buttonName(b)));
        const current = money(text, currency);
        if (needEdit ? edits.length === 1 : current !== null) return { root, edit: edits.length === 1 ? edits[0] : null, current };
      }
    }
    return null;
  }
  function getDialog(doc) {
    const matches = all(doc, '[role="dialog"]').filter(d => dialogTitle.test(norm(d.getAttribute('aria-label'))) || all(d, 'h1,h2,h3,[role="heading"]').some(h => dialogTitle.test(textOf(h))));
    return matches.length === 1 ? matches[0] : null;
  }
  function getAmountInput(dialog) {
    const inputs = all(dialog, 'input').filter(input => {
      if (!['', 'text', 'number', 'tel'].includes(input.getAttribute('type') || '')) return false;
      const labels = Array.from(dialog.querySelectorAll('label')).filter(l => l.contains(input) || (input.id && l.getAttribute('for') === input.id));
      const labelled = (input.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => input.ownerDocument.getElementById(id)).filter(Boolean);
      const names = [input.getAttribute('aria-label'), input.getAttribute('placeholder'), ...labels.map(l => l.textContent), ...labelled.map(l => l.textContent)];
      return names.some(n => /^(enter an amount|payment threshold|threshold amount)(?:\s*\([A-Z]{3}\))?$/i.test(norm(n)));
    });
    return inputs.length === 1 ? inputs[0] : null;
  }
  function failure(status, detail, desired, currency, current) { return { status, detail, desired, currency, current }; }
  async function apply(accountId, requested, currency) {
    let desired, submitted = false;
    try {
      desired = amount(requested, currency);
      await env.navigate(accountId);
      let doc = env.document();
      const before = section(doc, currency, false);
      if (before && before.current === desired) return { status: 'confirmed', already: true, current: desired, desired, currency };
      const control = section(doc, currency, true);
      if (!control || !control.edit || control.edit.disabled || control.edit.getAttribute('aria-disabled') === 'true') return failure('unavailable', 'Не найден доступный Edit в разделе You\'ll pay when. Порог не отправлен; проверь настройки оплаты вручную.', desired, currency, before && before.current);
      control.edit.click();
      const dialog = await env.wait(() => getDialog(env.document()), 12000);
      const input = getAmountInput(dialog);
      if (!input) return failure('unavailable', 'В диалоге Billing date and threshold не найдено однозначное поле Enter an amount. Ничего не сохранено.', desired, currency);
      const currencyText = textOf(dialog) + ' ' + all(dialog, '*').filter(el => !el.children.length).map(textOf).join(' ');
      const currencyMentions = currencyText.match(/\b[A-Z]{3}\b/g) || [];
      const known = Intl.supportedValuesOf ? Intl.supportedValuesOf('currency') : ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'RUB'];
      if (currencyMentions.some(c => known.includes(c) && c !== currency)) return failure('unavailable', 'Валюта диалога не совпадает с валютой кабинета. Ничего не сохранено.', desired, currency);
      for (const bound of ['min', 'max']) {
        const raw = input.getAttribute(bound);
        if (raw !== null && raw !== '' && Number.isFinite(Number(raw)) && (bound === 'max' ? desired > Number(raw) : desired < Number(raw))) return failure('rejected', 'Meta задаёт ' + bound + ' = ' + raw + ' ' + currency + '. Запрошено ' + desired + '; сумма автоматически не заменялась.', desired, currency);
      }
      if (env.stopped()) throw new Error('Остановлено до сохранения порога.');
      env.setInput(input, String(desired));
      await env.sleep(350);
      if (Number(input.value) !== desired || (input.checkValidity && !input.checkValidity())) return failure('rejected', 'Поле суммы отклонило значение: ' + (input.validationMessage || 'проверь допустимый порог в Meta'), desired, currency);
      const saves = all(dialog, 'button,[role="button"]').filter(b => /^(save|save changes)$/i.test(buttonName(b)) && !b.disabled && b.getAttribute('aria-disabled') !== 'true');
      if (saves.length !== 1) return failure('unavailable', 'Не найдена однозначная активная кнопка Save внутри диалога порога. Ничего не сохранено.', desired, currency);
      if (env.stopped()) throw new Error('Остановлено до сохранения порога.');
      saves[0].click();
      submitted = true;
      const result = await env.wait(() => {
        const errors = all(dialog, '[role="alert"],[aria-live="assertive"]').map(e => norm(e.textContent)).filter(Boolean);
        if (errors.length) return { error: errors.join(' ').slice(0, 250) };
        return !dialog.isConnected || !visible(dialog) ? { closed: true } : null;
      }, 15000);
      if (result.error) return failure('rejected', 'Meta: ' + result.error, desired, currency);
      // Reopen the account page. Neither a click nor closing a dialog is success.
      await env.navigate(accountId);
      doc = env.document();
      const after = section(doc, currency, false);
      if (after && after.current === desired) return { status: 'confirmed', current: after.current, desired, currency };
      return failure('unconfirmed', 'После сохранения и обновления страницы фактический порог ' + (after ? after.current + ' ' + currency : 'не удалось прочитать') + '. Значение ' + desired + ' ' + currency + ' не подтверждено: Meta может ограничивать или повышать его постепенно.', desired, currency, after && after.current);
    } catch (error) {
      return failure(submitted ? 'unconfirmed' : 'unavailable', (submitted ? 'Сохранение было отправлено, результат не подтверждён. ' : 'Порог не сохранён. ') + error.message, desired, currency);
    }
  }
  return { amount, money, section, getDialog, getAmountInput, apply };
}
