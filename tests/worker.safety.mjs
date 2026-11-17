import assert from 'node:assert/strict';
const base='http://127.0.0.1:8799';
async function post(body,token='operator-local-token'){
 const r=await fetch(base,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify(body)});
 return {status:r.status,body:await r.json()};
}
const request={_requestId:crypto.randomUUID(),type:'入庫',id:'ACTIVE',name:'Active Item',lot:crypto.randomUUID(),expiry:'2027-10-01',qty:2,locationId:1};
let first=await post(request);assert.equal(first.body.success,true);
let duplicate=await post(request);assert.equal(duplicate.body.success,true);
assert.equal((await post({...request,qty:3})).status,409);
assert.equal((await post(request,'manager-local-token')).status,409);
const sid=(await post({_requestId:crypto.randomUUID(),action:'startStocktakeSession',locationId:1})).body.session.session_id;
const row=first.body.updatedItem || first.body.updatedItems?.find(x=>x.lot===request.lot);
assert.ok(row,'inbound response contains batch');
// Change quantity then bring it back: same quantity must still conflict by version.
await post({...request,_requestId:crypto.randomUUID(),qty:1});
const issue=await post({_requestId:crypto.randomUUID(),type:'領用',id:'ACTIVE',batch_id:row.batch_id,lot:request.lot,expiry:request.expiry,qty:1,locationId:1});
assert.equal(issue.body.success,true);
const count={_requestId:crypto.randomUUID(),action:'stocktakeRecord',sessionId:sid,batch_id:row.batch_id,location_id:1,qty:2};
const conflict=await post(count);assert.equal(conflict.status,409);
assert.equal((await post({...count,_requestId:crypto.randomUUID()})).body.success,true);
await post({_requestId:crypto.randomUUID(),action:'cancelStocktakeSession',sessionId:sid});
console.log('PASS: real Worker duplicate identity, cross-user isolation and quantity-returned-to-original stocktake conflict');
