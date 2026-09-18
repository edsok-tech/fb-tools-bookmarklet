import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createCatalogGuard } from '../src/catalog-guard.js';
import { createPaymentThresholdTools } from '../src/payment-threshold.js';

const guard=createCatalogGuard();
const catalogs=[{id:'1001',name:'80001',rel:'OWNER'},{id:'1002',name:'80002',rel:'OWNER'},{id:'1003',name:'unused',rel:'OWNER'}];
test('keep-list with one stale name blocks the entire destructive plan',()=>{
  assert.throws(()=>guard.plan(catalogs,['80001','old-name'],true),/не найдены 1/);
});
test('stable catalog IDs remain valid after a rename',()=>{
  const renamed=catalogs.map(c=>({...c,name:c.id==='1001'?'90001':c.name}));
  assert.deepEqual(guard.plan(renamed,['1001','80002'],true).remove.map(c=>c.id),['1003']);
  assert.throws(()=>guard.plan(renamed,['80001','80002'],true),/После Rename/);
});
test('ambiguous catalog names cannot delete several objects accidentally',()=>{
  assert.throws(()=>guard.plan([...catalogs,{id:'1004',name:'80001'}],['80001'],false),/Неоднозначные/);
  assert.equal(guard.plan([...catalogs,{id:'1004',name:'80001'}],['1001'],false).remove.length,1);
});
test('rename, relationship change and additions invalidate a checked snapshot',()=>{
  const snap=guard.snapshot(catalogs);
  assert.doesNotThrow(()=>guard.assertFresh(snap,guard.snapshot([...catalogs].reverse())));
  for(const change of [catalogs.map((c,i)=>i?c:{...c,name:'new'}),catalogs.map((c,i)=>i?c:{...c,rel:'PARTNER'}),[...catalogs,{id:'new',name:'new'}]])assert.throws(()=>guard.assertFresh(snap,guard.snapshot(change)),/изменились/);
});
test('empty input never means delete all catalogs',()=>assert.throws(()=>guard.plan(catalogs,[],true)));

// Synthetic UI contract based on the user's dialog description, NOT a live Meta capture.
function fixture(options={}){
  let doc,navigations=0,edits=0,saves=0,inputValue='',wrongSaves=0,pendingPage=null;
  const currency=options.currency||'USD';
  const visible=el=>el.isConnected&&!el.hidden&&!el.closest('[hidden]');
  function makePage(current){
    const text=options.unreadable?'amount unavailable':current+' '+currency;
    const {document}=parseHTML('<html><body><section><h3>You\'ll pay when</h3><p>Your balance reaches '+text+'</p>'+(options.noEdit?'':'<button id="edit" aria-label="Edit">✎</button>')+'</section><section><h3>Account spending limit</h3><input value="500"><button id="wrong">Save</button></section></body></html>');
    if(options.wrapped){
      const h=document.querySelector('h3');h.outerHTML='<div>'.repeat(12)+'<span>You’ll pay when</span>'+'</div>'.repeat(12);
      const note=document.createElement('p');note.textContent='Learn about payment methods. '.repeat(45);document.querySelector('section').appendChild(note);
    }
    document.querySelector('#wrong').onclick=()=>{wrongSaves++};
    const edit=document.querySelector('#edit');
    if(edit&&options.labelledEdit){edit.removeAttribute('aria-label');edit.setAttribute('aria-labelledby','edit-caption');const label=document.createElement('span');label.id='edit-caption';label.textContent='Edit';document.querySelector('section').appendChild(label)}
    if(edit&&options.disabledEdit)edit.setAttribute('aria-disabled','true');
    if(edit)edit.onclick=()=>{
      edits++;
      const modal=document.createElement('div');modal.setAttribute('role','dialog');
      modal.innerHTML='<h2>'+(options.title||'Billing date and threshold')+'</h2><p>'+(options.dialogCurrency||currency)+'</p><label for="amount">Enter an amount</label><input id="amount" type="text"'+(options.max?' max="'+options.max+'"':'')+'>'+ (options.ambiguous?'<label>Enter an amount<input type="number"></label>':'')+'<button id="save">Save</button>';
      document.body.appendChild(modal);
      modal.querySelector('#save').onclick=()=>{
        saves++;inputValue=modal.querySelector('#amount').value;
        if(options.error){const e=document.createElement('div');e.setAttribute('role','alert');e.textContent=options.error;modal.appendChild(e)}else modal.remove();
      };
    };
    return document;
  }
  const tools=createPaymentThresholdTools({
    visible,document:()=>doc,stopped:()=>!!options.stopped,
    sleep:async()=>{},setInput:(input,value)=>{input.value=value},
    navigate:async()=>{navigations++;const page=makePage(navigations===1?(options.current??2):(options.persisted??100));if(options.delayed){doc=parseHTML('<html><body><div>Loading…</div></body></html>').document;pendingPage=page}else doc=page},
    wait:async fn=>{for(let i=0;i<4;i++){const result=fn();if(result)return result;if(pendingPage&&i===1){doc=pendingPage;pendingPage=null}}throw new Error('UI contract not matched')}
  });
  return {tools,state:()=>({navigations,edits,saves,inputValue,wrongSaves})};
}
test('USD 100 is confirmed only after save and fresh readback; spend cap untouched',async()=>{
  const f=fixture(),r=await f.tools.apply('123456','100','USD');
  assert.equal(r.status,'confirmed',r.detail);assert.equal(r.current,100);
  assert.deepEqual(f.state(),{navigations:2,edits:1,saves:1,inputValue:'100',wrongSaves:0});
});
test('existing desired threshold requires no mutation',async()=>{
  const f=fixture({current:100,noEdit:true}),r=await f.tools.apply('123456',100,'USD');
  assert.equal(r.status,'confirmed');assert.equal(r.already,true);assert.equal(f.state().saves,0);
});
test('closing a dialog or accepting a requested increase is not proof of the effective threshold',async()=>{
  const f=fixture({persisted:2}),r=await f.tools.apply('123456',100,'USD');
  assert.equal(r.status,'unconfirmed');assert.equal(r.current,2);assert.equal(f.state().saves,1);
});
test('Meta maximum is respected without silently clamping',async()=>{
  const f=fixture({max:50}),r=await f.tools.apply('123456',100,'USD');
  assert.equal(r.status,'rejected');assert.match(r.detail,/max = 50 USD/);assert.equal(f.state().saves,0);
});
test('server rejection is reported instead of success',async()=>{
  const f=fixture({error:'You cannot change your payment threshold'}),r=await f.tools.apply('123456',100,'USD');
  assert.equal(r.status,'rejected');assert.match(r.detail,/You cannot change/);assert.equal(f.state().navigations,1);
});
for(const [name,options] of Object.entries({missingControl:{noEdit:true},wrongDialog:{title:'Account spending limit'},ambiguousField:{ambiguous:true},wrongCurrency:{dialogCurrency:'EUR'},stopped:{stopped:true}})){
  test(name+' performs no Save',async()=>{const f=fixture(options),r=await f.tools.apply('123456',100,'USD');assert.notEqual(r.status,'confirmed');assert.equal(f.state().saves,0);assert.equal(f.state().wrongSaves,0)});
}
test('unknown currency causes no UI action',async()=>{
  const f=fixture(),r=await f.tools.apply('123456',100,'');assert.equal(r.status,'unavailable');assert.equal(f.state().navigations,0);
});
test('a non-USD amount stays in the actual currency without conversion',async()=>{
  const f=fixture({currency:'EUR',persisted:75.5}),r=await f.tools.apply('123456','75.50','EUR');
  assert.equal(r.status,'confirmed');assert.equal(r.current,75.5);assert.equal(r.currency,'EUR');assert.equal(f.state().inputValue,'75.5');
});
test('whole-unit currencies reject fractional thresholds',async()=>{
  const f=fixture({currency:'JPY'}),r=await f.tools.apply('123456','100.50','JPY');assert.equal(r.status,'unavailable');assert.equal(f.state().saves,0);
});
test('missing readback cannot be called success',async()=>{
  const f=fixture({unreadable:true}),r=await f.tools.apply('123456',100,'USD');assert.equal(r.status,'unconfirmed');assert.equal(f.state().saves,1);
});
test('money parsing rejects mixed currencies and multiple balances',()=>{
  const t=fixture().tools;
  assert.equal(t.money('When your balance reaches $1,250.50','USD'),1250.5);
  assert.equal(t.money('€75.50','EUR'),75.5);
  assert.equal(t.money('USD 100 EUR 100','USD'),null);
  assert.equal(t.money('Current balance $25; threshold $100','USD'),null);
});
test('React nesting and long explanatory text do not hide the threshold Edit',async()=>{
  const f=fixture({wrapped:true,labelledEdit:true}),r=await f.tools.apply('123456',100,'USD');
  assert.equal(r.status,'confirmed');assert.equal(f.state().edits,1);assert.equal(f.state().wrongSaves,0);
});
test('waits for SPA billing content both before Edit and after saving',async()=>{
  const f=fixture({delayed:true}),r=await f.tools.apply('123456',100,'USD');
  assert.equal(r.status,'confirmed');assert.equal(f.state().navigations,2);assert.equal(f.state().saves,1);
});
test('disabled Edit is reported separately without clicking or saving',async()=>{
  const f=fixture({disabledEdit:true}),r=await f.tools.apply('123456',100,'USD');
  assert.equal(r.status,'unavailable');assert.match(r.detail,/недоступную кнопку Edit/);assert.equal(f.state().edits,0);
});
test('never borrows an Edit from another billing section',()=>{
  const {document}=parseHTML('<html><body><main><section><h3>You\'ll pay when</h3><p>$2</p></section><section><h3>Payment methods</h3><button>Edit</button></section></main></body></html>');
  assert.equal(fixture().tools.section(document,'USD',true),null);
});
test('two Edit controls and two threshold sections are ambiguous',()=>{
  for(const html of [
    '<section><h3>You\'ll pay when</h3><p>$2</p><button>Edit</button><button>Edit</button></section>',
    '<section><h3>You\'ll pay when</h3><p>$2</p><button>Edit</button></section>'.repeat(2)
  ]){const {document}=parseHTML('<html><body>'+html+'</body></html>');assert.equal(fixture().tools.section(document,'USD',true),null)}
});
test('recognizes a dialog with an aria-labelledby title',()=>{
  const {document}=parseHTML('<html><body><div role="dialog" aria-labelledby="title"><div id="title">Billing date &amp; threshold</div><label for="x">Enter an amount</label><input id="x"></div></body></html>');
  const tools=fixture().tools,dialog=tools.getDialog(document);assert.ok(dialog);assert.equal(tools.getAmountInput(dialog).id,'x');
});
