import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.match(/<script id="src" type="text\/plain">([\s\S]*?)<\/script>/)[1].replace(/^javascript:/,'');
test('install links preserve multiline JavaScript including comments after URL decoding',()=>{
  const {document}=parseHTML(html);
  const install=html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(install,{document,location:{hash:''},window:{addEventListener:()=>{}},encodeURIComponent});
  for(const [link,script] of [['bm','src'],['bm2','src2'],['bmLC','srcLC']]){
    const encoded=document.getElementById(link).getAttribute('href');
    assert.ok(encoded.startsWith('javascript:'));
    const decoded=decodeURIComponent(encoded.slice(11));
    assert.equal(decoded,document.getElementById(script).textContent.trim().replace(/^javascript:/,''));
    assert.doesNotThrow(()=>new Function(decoded));
  }
});
async function app(){
  const {document,window:dom}=parseHTML('<html><body><script type="text/plain">"DTSGInitialData",[],{"token":"fixture-not-a-real-token"}</script></body></html>');
  let billingDoc=null;
  const create=document.createElement.bind(document);
  document.createElement=name=>{
    const el=create(name);
    if(name==='iframe'){
      billingDoc=parseHTML('<html><head></head><body></body></html>').document;
      billingDoc.open=()=>{};billingDoc.close=()=>{};
      billingDoc.write=markup=>{billingDoc.documentElement.replaceWith(parseHTML(markup).document.documentElement)};
      Object.defineProperty(el,'contentDocument',{value:billingDoc});
    }
    return el;
  };
  document.cookie='c_user=123456';
  let cats=[{id:'1001',name:'80001',rel:'OWNER'},{id:'1002',name:'80002',rel:'OWNER'},{id:'1003',name:'unused',rel:'OWNER'}];
  const accounts=[{id:'asset1',acc:'400001',status:'DISABLED'},{id:'asset2',acc:'400002',status:'DISABLED'}];
  const calls=[],alerts=[],storage=new Map();
  const localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
  const response=data=>({status:200,text:async()=>JSON.stringify(data)});
  const fetch=async(url,options={})=>{
    const u=new URL(url);calls.push({url:u.pathname,method:options.method||'GET'});
    if(u.hostname==='graph.facebook.com'){
      if(u.pathname.endsWith('/owned_product_catalogs'))return response({data:cats.map(c=>({id:c.id,name:c.name}))});
      const id=u.pathname.split('/').at(-1),cat=cats.find(c=>c.id===id);
      if(cat&&options.method==='POST'){cat.name=options.body.get('name');return response({success:true})}
      if(cat)return response({id:cat.id,name:cat.name});
      throw new Error('Unexpected mocked graph call: '+u.pathname);
    }
    const form=new URLSearchParams(options.body),name=form.get('fb_api_req_friendly_name'),vars=JSON.parse(form.get('variables'));
    calls.at(-1).name=name;
    if(name==='BizKitSettingsBusinessAssetsListPaginationQuery'){
      const edges=vars.assetTypes[0]==='AD_ACCOUNT'?accounts.map(a=>({node:{assetID:a.id,business_object_relationship_to_business:'OWNER'},nameColumn:{legacy_account_id:a.acc,bizkit_settings_render_strategy_no_business_id:{business_object:{business_object_name:a.acc}}}})):cats.map(c=>({node:{assetID:c.id,business_object_relationship_to_business:c.rel},nameColumn:{bizkit_settings_render_strategy_no_business_id:{business_object:{business_object_name:c.name}}}}));
      return response({data:{node:{connected_objects:{edges,page_info:{has_next_page:false}}}}});
    }
    if(name==='BizKitSettingsBusinessAssetsListItemAdditionalStatusQuery')return response({data:{business_object_rendered_in_ui:{accountStatus:accounts.find(a=>a.id===vars.assetID).status}}});
    if(name==='BizKitSettingsRemoveAdAccountMutation')return response({data:{business_settings_remove_ad_account:{removed_admarket_id:vars.adAccountID}}});
    if(name==='BizKitSettingsRemoveAssetFromBusinessMutation'){cats=cats.filter(c=>c.id!==vars.assetID);return response({data:{business_settings_remove_object_from_business:{removed_asset_id:vars.assetID}}})}
    throw new Error('Unexpected mocked mutation: '+name);
  };
  const window={__accessToken:'EAA'+'0'.repeat(120)};
  const sandbox={window,document,localStorage,location:new URL('https://business.facebook.com/latest/settings/?business_id=123456'),navigator:{clipboard:{writeText:async()=>{}}},URL,FormData,fetch,console,Event:dom.Event,HTMLInputElement:dom.HTMLInputElement,setTimeout:fn=>{fn();return 0},clearTimeout:()=>{},confirm:()=>true,alert:s=>alerts.push(s)};
  await vm.runInNewContext(source,sandbox);
  assert.deepEqual(alerts,[],'bookmarklet should initialize without exceptions');
  for(const el of document.querySelectorAll('select'))Object.defineProperty(el,'value',{configurable:true,get(){return (this.querySelector('option[selected]')||this.querySelector('option'))?.getAttribute('value')||''},set(v){for(const option of this.querySelectorAll('option')){if(option.getAttribute('value')===v)option.setAttribute('selected','');else option.removeAttribute('selected')}}});
  const q=s=>document.querySelector(s);
  q('#d_bm').value='123456';q('#c_bm').value='123456';q('#d_rows').value='80001\n80002';
  return {q,calls,dom,document,accounts,billing:()=>billingDoc,cats:()=>cats,mutate:fn=>fn(cats),async check(){await q('#d_check').onclick()},async remove(){await q('#d_go').onclick()}};
}
const removals=a=>a.calls.filter(c=>c.name==='BizKitSettingsRemoveAssetFromBusinessMutation');
test('full bookmarklet keeps nine tabs and our Rename block',async()=>{
  const a=await app();assert.equal(a.document.querySelectorAll('[id^=fb_tab]').length,9);assert.ok(a.q('#c_rename_go'));assert.ok(a.q('#c_rename_copy'));
});
test('Billing initializes threshold controls with 100 USD and no write requests',async()=>{
  const a=await app();a.q('#fb_tabB').onclick();
  const d=a.billing();assert.ok(d);assert.equal(d.getElementById('card-threshold-default').value,'100');
  assert.ok(d.getElementById('card-threshold-enabled').hasAttribute('checked'));
  assert.equal(d.getElementById('card-threshold-continue').hasAttribute('checked'),false);
  assert.equal(typeof d.getElementById('card-threshold-check').onclick,'function');
  assert.equal(typeof d.getElementById('card-threshold-only').onclick,'function');
  assert.equal(a.calls.length,0);
});
test('editing deletion input disables the checked plan',async()=>{
  const a=await app();await a.check();assert.equal(a.q('#d_go').disabled,false);
  a.q('#d_rows').value='80001';a.q('#d_rows').dispatchEvent(new a.dom.Event('input'));
  assert.equal(a.q('#d_go').disabled,true);await a.remove();assert.equal(removals(a).length,0);
});
test('direct BM edits are detected even without a DOM input event',async()=>{
  const a=await app();await a.check();a.q('#d_bm').value='999999';await a.remove();assert.equal(removals(a).length,0);assert.match(a.q('#d_status').textContent,/устарел/);
});
test('external rename between check and delete results in zero mutation calls',async()=>{
  const a=await app();await a.check();a.mutate(cats=>{cats[0].name='90001'});await a.remove();
  assert.equal(removals(a).length,0);assert.match(a.q('#d_status').textContent,/изменились/);
});
test('a valid checked keep-list deletes only the unlisted catalog',async()=>{
  const a=await app();await a.check();await a.remove();assert.equal(removals(a).length,1);assert.deepEqual(a.cats().map(c=>c.id),['1001','1002']);
});
test('our Rename updates names, preserves IDs and invalidates deletion plans',async()=>{
  const a=await app();await a.check();a.q('#c_rename_old').value='80001\n80002';a.q('#c_rename_new').value='90001\n90002';
  await a.q('#c_rename_go').onclick();
  assert.deepEqual(a.cats().slice(0,2).map(c=>[c.id,c.name]),[['1001','90001'],['1002','90002']]);
  assert.equal(a.q('#d_go').disabled,true);assert.equal(a.q('#c_rename_copy').disabled,false);
  await a.check();assert.equal(a.q('#d_go').disabled,true);assert.match(a.q('#d_status').textContent,/не найдены/);
  assert.equal(removals(a).length,0);
});
test('DISABLED status is checked again immediately before each account removal',async()=>{
  const a=await app();a.q('#d_kind').value='acc';a.q('#d_rows').value='';await a.check();
  a.accounts[0].status='ACTIVE';await a.remove();
  assert.equal(a.calls.filter(c=>c.name==='BizKitSettingsRemoveAdAccountMutation').length,1);
  assert.match(a.q('#d_log').textContent,/400001: Текущий статус ACTIVE/);
});
test('Ads Manager hidden-results notice is informational, while real card alerts still fail',()=>{
  const fn=source.slice(source.indexOf('function paymentError(d)'),source.indexOf('async function attachCard('));
  const read=vm.runInNewContext('('+fn.trim()+')',{isVisible:el=>!el.hidden});
  const {document}=parseHTML('<html><body><div role="alert">Total results hiddenCloseYour total results are hidden in order to improve load time. To see them, click View results in the Results summary row.</div></body></html>');
  assert.equal(read(document),null);
  const error=document.createElement('div');error.setAttribute('role','alert');error.textContent='Your card was declined';document.body.appendChild(error);
  assert.equal(read(document),'Your card was declined');
});
test('threshold-only action runs checked accounts without card details or card attachment',async()=>{
  const a=await app();a.q('#fb_tabB').onclick();const d=a.billing();
  const calls=[],rows=[{id:'400001',currency:'USD',requested:'100',cell:d.createElement('td')},{id:'400002',currency:'USD',requested:'50',cell:d.createElement('td')}];
  const start=source.indexOf("$('card-threshold-only').onclick="),end=source.indexOf("$('card-stop').onclick",start);
  vm.runInNewContext(source.slice(start,end),{
    $:id=>d.getElementById(id),cardAccountIds:()=>rows.map(r=>r.id),thresholdRequests:(ids,only)=>{assert.equal(only,true);return rows},
    thresholdSetBusy:on=>calls.push(['busy',on]),ensureWorker:async()=>calls.push(['worker']),
    applyCardThreshold:async row=>{calls.push(['threshold',row.id]);return {status:row.id==='400001'?'confirmed':'unavailable'}},log:()=>{}
  });
  assert.equal(d.getElementById('card-cards').value,'');
  await d.getElementById('card-threshold-only').onclick();
  assert.deepEqual(calls,[['busy',true],['worker'],['threshold','400001'],['threshold','400002'],['busy',false]]);
  assert.match(d.getElementById('card-threshold-status').textContent,/подтверждено 1, не подтверждено 1/);
});
test('navigation requires a fresh billing document for the exact requested account',async()=>{
  const fn=source.slice(source.indexOf('async function navigateAndWait(url)'),source.indexOf('function findInputs(d)'));
  const target='https://adsmanager.facebook.com/adsmanager/billing_hub/payment_settings/?asset_id=400001';
  for(const mode of ['ready','wrong-page','wrong-account','stale-document']){
    let clock=0;
    const worker={closed:false,document:{readyState:'complete'},location:{href:target,replace(){
      if(mode!=='stale-document')delete worker.__bmNav;
      this.href=mode==='wrong-page'?target.replace('billing_hub/payment_settings','manage/campaigns'):mode==='wrong-account'?target.replace('400001','4000010'):target;
    }}};
    const navigate=vm.runInNewContext('('+fn.trim()+')',{worker,cardStopped:false,Date:{now:()=>clock},Math,URL,isCrossOrigin:()=>false,sleep:async ms=>{clock+=ms}});
    if(mode==='ready')await navigate(target);else await assert.rejects(navigate(target),/не загрузились/);
  }
});
