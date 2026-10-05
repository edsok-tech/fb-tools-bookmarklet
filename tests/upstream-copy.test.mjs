import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const bytes=readFileSync(new URL('../index.html',import.meta.url));
const html=bytes.toString('utf8');
test('published page is the exact approved upstream snapshot',()=>{
  const sha=createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');
  assert.equal(sha,'e10eb8744cfc36edb786955a2124b9d31518902d');
});
test('all four original bookmarklets parse without executing their actions',()=>{
  const blocks=[...html.matchAll(/<script id="([^"]+)" type="text\/plain">([\s\S]*?)<\/script>/g)];
  assert.deepEqual(blocks.map(m=>m[1]),['src','src2','srcLC','srcKT']);
  for(const m of blocks)new Function(m[2].replace(/^javascript:/,''));
});
test('LeadingCards includes issuance and closing in the same original script',()=>{
  const code=html.match(/<script id="srcLC" type="text\/plain">([\s\S]*?)<\/script>/)[1];
  assert(code.includes('lcGo'));
  assert(code.includes('lcCGo'));
  assert(code.includes('closeCard'));
  assert(html.includes("document.getElementById('bmLC').href = srcLC"));
});
