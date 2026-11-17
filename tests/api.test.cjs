const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync('shanshi-inventory-api/src/index.js','utf8').replace(/export \{[\s\S]*?\};/,'');
const context=vm.createContext({crypto:webcrypto,TextEncoder,Response,console});
vm.runInContext(source,context);
test('request identities reject changed content and other users, accept reordered identical payload',async()=>{
  const records=new Map();
  const db={prepare(sql){return {bind(...args){return {async run(){if(!records.has(args[0]))records.set(args[0],{user_id:args[1],payload_hash:args[2]});},async first(){return records.get(args[0]);}};}};}};
  const payload={_requestId:'test-request-0001',type:'入庫',qty:2};
  await context.bindRequestIdentity(db,payload,{id:1});
  await context.bindRequestIdentity(db,{qty:2,type:'入庫',_requestId:payload._requestId},{id:1});
  await assert.rejects(context.bindRequestIdentity(db,{...payload,qty:3},{id:1}));
  await assert.rejects(context.bindRequestIdentity(db,payload,{id:2}));
});
test('missing stored response is pending, never successful',async()=>{
  const db={prepare(){return {bind(){return {async first(){return {response_json:''};}};}};}};
  const result=await context.cachedRequestResponse(db,'pending');
  assert.equal(result.success,false);assert.equal(result.pending,true);
});
