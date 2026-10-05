import { readFileSync } from 'node:fs';
const target = new URL('../index.html', import.meta.url);
let html = readFileSync(target, 'utf8');
for (const match of html.matchAll(/<script id="([^"]+)" type="text\/plain">([\s\S]*?)<\/script>/g)) {
  new Function(match[2].replace(/^javascript:/, ''));
  console.log('Syntax OK:', match[1]);
}
