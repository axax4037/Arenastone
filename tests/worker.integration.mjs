import assert from 'node:assert/strict';
const base='http://127.0.0.1:8799';
const token='operator-local-token';
async function post(body){const r=await fetch(base,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${token}`},body:JSON.stringify({...body,_requestId:body._requestId||crypto.randomUUID()})});return {status:r.status,body:await r.json()};}
async function get(resource=''){const url=resource?`${base}?resource=${encodeURIComponent(resource)}`:base;const r=await fetch(url,{headers:{authorization:`Bearer ${token}`}});return {status:r.status,body:await r.json()};}
let r=await fetch(base+'/health');let h=await r.json();assert.equal(r.status,200);assert.equal(h.dbReady,true);
let x=await post({type:'入庫',id:'STOP',name:'Stopped Item',category:'Changed',lot:'X',expiry:'2027-01-01',qty:1,locationId:1});assert.equal(x.status,409);assert.match(x.body.error,/停用/);
x=await post({type:'入庫',id:'ACTIVE',name:'Active Item',category:'Changed',lot:'BAD',expiry:'2026-02-30',qty:1,locationId:1});assert.equal(x.status,400);assert.match(x.body.error,/效期/);
x=await post({type:'入庫',id:'ACTIVE',name:'Active Item',category:'Changed',lot:'LOT-OP',expiry:'2027-02-01',qty:1,locationId:1});assert.equal(x.status,200);assert.equal(x.body.success,true);
let inv=await get();assert.equal(inv.status,200);const activeRows=inv.body.items.filter(v=>v.id==='ACTIVE');assert.ok(activeRows.length>=3);assert.ok(activeRows.every(v=>v.category==='Original'));
x=await post({action:'startStocktakeSession',locationId:1,blindMode:false,note:'integration'});assert.equal(x.status,200);const sid=x.body.session.session_id;
x=await post({type:'入庫',id:'ACTIVE',name:'Active Item',lot:'STOCKTAKE-NEW',expiry:'2027-03-01',qty:2,locationId:1});assert.equal(x.status,200);
let st=await get('stocktake');assert.equal(st.status,200);assert.ok(st.body.session.lines.some(v=>v.lot==='STOCKTAKE-NEW'),'new inbound batch should enter open stocktake scope');
x=await post({action:'cancelStocktakeSession',sessionId:sid});assert.equal(x.status,200);
x=await post({action:'fefoIssue',id:'ACTIVE',qty:3,locationId:1,note:'integration FEFO'});assert.equal(x.status,200);assert.deepEqual(x.body.allocations.map(v=>[v.batch_id,v.qty]),[[101,2],[102,1]]);
inv=await get();const byBatch=new Map(inv.body.items.filter(v=>v.id==='ACTIVE').map(v=>[Number(v.batch_id),Number(v.qty)]));assert.equal(byBatch.get(101),0);assert.equal(byBatch.get(102),4);
console.log('PASS: local Worker integration permissions, expiry, stocktake scope, FEFO');
