import { readFileSync, writeFileSync } from 'node:fs';
const target = new URL('../index.html', import.meta.url);
let html = readFileSync(target, 'utf8');
for (const name of ['catalog-guard', 'payment-threshold']) {
  const begin = '// BEGIN ' + name;
  const end = '// END ' + name;
  const source = readFileSync(new URL('../src/' + name + '.js', import.meta.url), 'utf8').replace(/^export /gm, '').trim();
  const a = html.indexOf(begin), b = html.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('Missing source markers: ' + name);
  html = html.slice(0, a) + begin + '\n' + source + '\n' + html.slice(b);
}
for (const match of html.matchAll(/<script id="([^"]+)" type="text\/plain">([\s\S]*?)<\/script>/g)) {
  new Function(match[2].replace(/^javascript:/, ''));
  console.log('Syntax OK:', match[1]);
}
writeFileSync(target, html);
