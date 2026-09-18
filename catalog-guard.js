export function createCatalogGuard() {
  const normalize = value => String(value || '').trim().toLowerCase();
  const parse = text => [...new Set(String(text || '').split(/[\s,;]+/).map(s => s.replace(/^act_/, '').trim()).filter(Boolean))];
  const snapshot = cats => JSON.stringify(cats.map(c => [String(c.id), String(c.name || ''), String(c.rel || '')]).sort((a, b) => a[0].localeCompare(b[0])));
  function plan(cats, lines, keep) {
    if (!lines.length) throw new Error('Вставь список актуальных имён или catalog_id.');
    const selected = new Set(), missing = [], ambiguous = [];
    for (const line of lines) {
      const byId = cats.filter(c => String(c.id) === line);
      const hits = byId.length ? byId : cats.filter(c => normalize(c.name) === normalize(line));
      if (!hits.length) missing.push(line);
      if (!keep && hits.length > 1) ambiguous.push(line);
      hits.forEach(c => selected.add(String(c.id)));
    }
    // A partially stale keep-list is just as dangerous as an entirely wrong one.
    if (missing.length) throw new Error('Удаление заблокировано: не найдены ' + missing.length + ' строк: ' + missing.slice(0, 20).join(', ') + '. После Rename используй новые имена или постоянные catalog_id; исправь список и проверь снова.');
    if (ambiguous.length) throw new Error('Неоднозначные имена: ' + ambiguous.join(', ') + '. Укажи настоящие catalog_id.');
    const remove = cats.filter(c => keep ? !selected.has(String(c.id)) : selected.has(String(c.id)));
    return { remove, kept: cats.length - remove.length };
  }
  function assertFresh(expected, actual) {
    if (expected !== actual) throw new Error('Каталоги или их названия изменились после проверки. Ничего не удалено — нажми «Проверить» снова.');
  }
  return { parse, snapshot, plan, assertFresh };
}
