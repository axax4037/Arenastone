// Run: node tests/workflow.test.cjs (Playwright available via node_modules or NODE_PATH).
// All API responses and camera callbacks are simulated; no production writes occur.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
new vm.Script(fs.readFileSync(path.join(root,'workflow.js'),'utf8'));
const items = [
    {id:'ITEM-A',name:'測試材料',batch_id:10,lot:'LOT-A',expiry:'2027-01-01',qty:8,price:120,note:'基本備註',location_id:1,location_name:'診間',is_active:1},
    {id:'ITEM-A',name:'測試材料',batch_id:20,lot:'LOT-B',expiry:'2027-08-01',qty:12,price:125,note:'新批備註',location_id:1,location_name:'診間',is_active:1},
    {id:'ITEM-B',name:'單批次材料',batch_id:30,lot:'LOT-C',expiry:'2027-09-01',qty:9,price:40,location_id:1,location_name:'診間',is_active:1}
];
const locations = [{location_id:1,name:'診間',code:'ROOM',is_active:1}];
const server = http.createServer((req,res) => {
    const name = new URL(req.url,'http://localhost').pathname;
    const file = path.join(root,name === '/' ? 'index.html' : name);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream');
    res.end(fs.readFileSync(file));
});
(async () => {
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const browser = await chromium.launch({headless:true,channel:process.env.TEST_BROWSER || 'msedge'});
    try {
        const context = await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
        const page = await context.newPage();
        const errors = [], requests = [], committed = new Map();
        let loseResponse = false, rejectWrite = false, rejectStocktakeConflict = false, sessionFixture = null;
        page.on('pageerror', e => {errors.push(e.message);console.error('PAGE ERROR:',e.message);});
        page.on('dialog', dialog => dialog.accept());
        await context.route('https://**/*', async route => {
            const request = route.request(), url = new URL(request.url());
            if (!url.hostname.includes('shanshi-inventory-api')) return route.fulfill({status:200,body:''});
            let body = {success:true};
            if (request.method() === 'GET') {
                body = url.searchParams.has('resource') ? {success:true,counts:{},session:sessionFixture} : {success:true,items,locations};
            } else {
                const data = request.postDataJSON();
                if (data.action === 'logout' || data.action === 'clientLog') return route.fulfill({json:body});
                requests.push(data);
                if (rejectWrite) return route.fulfill({status:400,json:{success:false,error:'庫存不足'}});
                if (rejectStocktakeConflict && data.action === 'stocktakeRecord') return route.fulfill({status:409,json:{success:false,error:'盤點基準已變更，請重新確認現場數量'}});
                if (!committed.has(data._requestId)) committed.set(data._requestId,{success:true,updatedItems:items});
                if (loseResponse) return route.abort('failed');
                body = committed.get(data._requestId);
            }
            await route.fulfill({json:body});
        });
        await page.addInitScript(() => {
            localStorage.setItem('SHANSHI_SESSION',JSON.stringify({account:'test',name:'測試操作員',role:'system_admin',token:'fake-local-test',timestamp:Date.now(),expiresAt:new Date(Date.now()+1800000).toISOString()}));
            window.Html5Qrcode = class {
                constructor(id){this.id=id;this.isScanning=false;}
                async start(config,options,success,error){this.isScanning=true;window.testCamera={success,error};}
                async stop(){this.isScanning=false;}
                clear(){}
            };
        });
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => typeof hasLiveInventory !== 'undefined' && hasLiveInventory && typeof draftAccount !== 'undefined' && draftAccount === 'test');
        await page.evaluate(async () => {document.getElementById('dashboardLocationFilter').value='1';setDashboardLocationFilter();await toggleHomeScanner();});

        // One physical barcode held in view counts once; multi-batch scans require selection.
        await page.evaluate(() => {handleHomeScan('ITEM-A');for(let n=0;n<30;n++)handleHomeScan('ITEM-A');});
        assert.equal(await page.evaluate(() => inlineDrafts.size),0);
        await page.selectOption('#homeBatchSelect','B20|||L1');
        await page.evaluate(() => confirmHomeBatch());
        assert.equal(await page.evaluate(() => inlineDrafts.get('B20|||L1').qty),'1');
        await page.evaluate(() => {for(let n=0;n<40;n++)handleHomeScan('ITEM-A');});
        assert.equal(await page.evaluate(() => inlineDrafts.get('B20|||L1').qty),'1');
        await page.evaluate(() => {handleHomeScan('ITEM-B');handleHomeScan('ITEM-A');handleHomeScan('ITEM-B');});
        assert.equal(await page.evaluate(() => inlineDrafts.get('B20|||L1').qty),'1');
        assert.equal(await page.evaluate(() => inlineDrafts.get('B30|||L1').qty),'1');
        await page.evaluate(() => {inlineDrafts.delete('B30|||L1');saveWorkDraft();});
        await page.evaluate(() => {for(let n=0;n<12;n++)homeScanMiss();handleHomeScan('ITEM-A');});
        assert.equal(await page.evaluate(() => inlineDrafts.get('B20|||L1').qty),'2');

        // Stable batch keys survive filtering and server array reordering.
        await page.fill('#inline-qty-1','7');
        await page.evaluate(() => {allItems=[allItems[1],allItems[2],allItems[0]];rebuildItemIndexes();filterItems();});
        assert.equal(await page.inputValue('#inline-qty-0'),'7');
        await page.fill('#searchInput','ITEM-B');
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => inlineDrafts.get('B20|||L1').qty),'7');
        await page.fill('#searchInput','');
        await page.waitForTimeout(200);
        await page.reload();
        await page.waitForFunction(() => inlineDrafts.get('B20|||L1')?.qty === '7');
        assert.equal(await page.inputValue('#inline-qty-1'),'7');

        // Existing inbound codes populate editable basic data instead of writing immediately.
        await page.evaluate(async () => {await switchTab('scanner');await startScanner();lastScanTime=0;window.testCamera.success('ITEM-A');});
        await page.waitForFunction(() => !document.getElementById('scanForm').classList.contains('hidden'));
        assert.equal(await page.inputValue('#scanName'),'測試材料');
        assert.equal(await page.inputValue('#scanLot'),'LOT-B');
        assert.equal(await page.inputValue('#scanExpiry'),'2027-08-01');
        assert.equal(await page.inputValue('#scanPrice'),'125');
        assert.equal(requests.length,0);
        await page.selectOption('#inboundBatchSelect','new');
        assert.equal(await page.inputValue('#scanName'),'測試材料');
        assert.equal(await page.inputValue('#scanLot'),'');
        await page.fill('#scanLot','NEW-LOT');
        await page.fill('#scanExpiry','2028-02-03');
        await page.fill('#scanQty','5');
        if(process.env.TEST_SCREENSHOT_DIR){
            fs.mkdirSync(process.env.TEST_SCREENSHOT_DIR,{recursive:true});
            await page.screenshot({path:path.join(process.env.TEST_SCREENSHOT_DIR,'inbound-mobile.png'),fullPage:true});
            await page.setViewportSize({width:1365,height:900});
            await page.screenshot({path:path.join(process.env.TEST_SCREENSHOT_DIR,'inbound-desktop.png'),fullPage:true});
            await page.setViewportSize({width:390,height:844});
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth<=window.innerWidth),true);
        await page.evaluate(async () => {await switchTab('dashboard');await switchTab('scanner');});
        assert.equal(await page.inputValue('#scanLot'),'NEW-LOT');
        await page.reload();
        await page.waitForFunction(() => document.getElementById('scanLot').value === 'NEW-LOT');
        assert.equal(await page.inputValue('#scanQty'),'5');

        // Keep a second tab open before the first write to verify cross-tab coordination.
        const secondPage = await context.newPage();
        secondPage.on('dialog', dialog => dialog.accept());
        await secondPage.goto(`http://127.0.0.1:${server.address().port}`);
        await secondPage.waitForFunction(() => typeof hasLiveInventory !== 'undefined' && hasLiveInventory && draftAccount === 'test');
        assert.equal(await secondPage.evaluate(() => pendingWrite),null);

        // Simulate a committed write with a lost response, reload, and retry the exact ID/body.
        loseResponse = true;
        await page.evaluate(() => submitScan());
        assert.ok(await page.evaluate(() => !!pendingWrite));
        assert.match(await page.textContent('#alertMessage'),/尚未確認/);
        assert.doesNotMatch(await page.textContent('#alertMessage'),/庫存未異動/);
        const requestId = requests[0]._requestId;
        assert.equal(committed.size,1);
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(pendingWriteStorageKey(draftAccount,pendingWrite.payload._requestId))).payload._requestId),requestId);
        await page.evaluate(() => closeAlert());

        // A pre-existing second tab must notice the first tab's journal before creating a new inventory write.
        const requestsBeforeSecondTab = requests.length;
        const secondTabBlocked = await secondPage.evaluate(async () => {try{await postApi({action:'fefoIssue',id:'ITEM-B',qty:1,locationId:1});return '';}catch(e){return e.message;}});
        assert.match(secondTabBlocked,/尚未確認/);
        assert.equal(requests.length,requestsBeforeSecondTab);
        assert.equal(await secondPage.evaluate(() => pendingWrite.payload._requestId),requestId);

        // Per-request keys ensure an exceptional simultaneous race cannot overwrite another journal.
        await page.evaluate(() => persistPendingWrite({payload:{_requestId:'synthetic-second'},context:null,createdAt:new Date().toISOString()},'test'));
        assert.equal(await page.evaluate(() => listPersistedPendingWrites('test').length),2);
        await page.evaluate(() => removePersistedPendingWrite({payload:{_requestId:'synthetic-second'}},'test'));
        assert.equal(await page.evaluate(() => listPersistedPendingWrites('test').length),1);
        await secondPage.close();

        // A full tab/PWA restart loses sessionStorage. The unresolved mutation journal must still survive.
        await page.evaluate(() => sessionStorage.clear());
        await page.reload();
        await page.waitForFunction(() => !!pendingWrite);
        assert.equal(await page.evaluate(() => pendingWrite.payload._requestId),requestId);
        assert.equal(await page.isDisabled('#scanQty'),true);
        const blocked = await page.evaluate(async () => {try {await postApi({type:'入庫',id:'OTHER',qty:1});return false;}catch{return true;}});
        assert.equal(blocked,true);
        loseResponse = false;
        await page.evaluate(() => retryPendingWrite());
        assert.equal(committed.size,1);
        assert.ok(requests.filter(x => x._requestId === requestId).length >= 2);
        assert.equal(await page.evaluate(() => pendingWrite),null);
        assert.equal(await page.evaluate(() => document.getElementById('scanForm').classList.contains('hidden')),true);
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem(WORK_DRAFT_PREFIX+draftAccount)).pendingWrite),null);
        assert.equal(await page.evaluate(id => localStorage.getItem(pendingWriteStorageKey('test',id)),requestId),null);
        await page.evaluate(() => closeAlert());

        // A definite validation rejection allows correction; it does not strand the write.
        rejectWrite = true;
        const rejected = await page.evaluate(async () => {try{await postApi({action:'fefoIssue',id:'ITEM-A',qty:999,locationId:1});}catch(e){return e.message;}});
        assert.match(rejected,/庫存不足/);
        assert.equal(await page.evaluate(() => pendingWrite),null);
        rejectWrite = false;

        // The original continuous outbound flow also retains its batch through a lost response.
        await page.evaluate(async () => {await switchTab('scanner');setScanMode('outbound');await quickOutboundExisting('ITEM-A',itemIndexes.byId.get('ITEM-A'));});
        await page.reload();
        await page.waitForFunction(() => scanSessionCounts.outbound.size === 1);
        loseResponse = true;
        await page.evaluate(() => {void finishScanSession();});
        await page.click('#quickScanConfirmBtn');
        await page.waitForFunction(() => pendingWrite && !writeInFlight);
        assert.equal(await page.evaluate(() => scanSessionCounts.outbound.size),1);
        const outboundId = await page.evaluate(() => pendingWrite.payload._requestId);
        loseResponse = false;
        await page.evaluate(() => {closeAlert();return retryPendingWrite();});
        assert.equal(await page.evaluate(() => scanSessionCounts.outbound.size),0);
        assert.ok(requests.filter(x=>x.action==='batchQuickScan').every(x=>x._requestId===outboundId));
        assert.equal(committed.size,2);
        await page.evaluate(() => closeAlert());

        // Formal stocktake quantity/reason survive navigation and reload without submitting.
        sessionFixture={session_id:77,status:'open',location_name:'診間',blind_mode:false,lines:items.map(x=>({...x,status:'pending',system_qty:x.qty}))};
        await page.evaluate(async () => {await switchTab('stocktake');selectStocktakeBatch(10);});
        await page.fill('#stocktakeQty','6');
        await page.selectOption('#stocktakeReason','破損');
        await page.fill('#stocktakeLineNote','重新確認中的草稿');
        await page.reload();
        await page.waitForFunction(() => document.getElementById('stocktakeQty').value === '6');
        assert.equal(await page.inputValue('#stocktakeReason'),'破損');
        assert.equal(await page.inputValue('#stocktakeLineNote'),'重新確認中的草稿');

        // A stocktake 409 is a definite non-commit. Release the journal so the operator can
        // refresh the baseline and enter a newly confirmed count instead of retrying stale qty.
        rejectStocktakeConflict = true;
        const stocktakeConflict = await page.evaluate(async () => {try{await postApi({action:'stocktakeRecord',sessionId:77,batch_id:10,location_id:1,qty:6,reason:'破損'});}catch(e){return e.message;}});
        assert.match(stocktakeConflict,/盤點基準已變更/);
        assert.equal(await page.evaluate(() => pendingWrite),null);
        rejectStocktakeConflict = false;

        // Ordinary drafts also survive a full tab/PWA restart without being submitted.
        await page.evaluate(async () => {await switchTab('manual');document.getElementById('manualId').value='RESTART-DRAFT';document.getElementById('manualQty').value='3';saveWorkDraft();sessionStorage.clear();});
        await page.reload();
        await page.waitForFunction(() => document.getElementById('manualId').value === 'RESTART-DRAFT');
        assert.equal(await page.inputValue('#manualQty'),'3');
        assert.equal(requests.filter(x=>x.id==='RESTART-DRAFT').length,0);
        await page.fill('#manualId','');
        await page.fill('#manualQty','');
        await page.evaluate(() => saveWorkDraft());

        // Failure to persist the journal must prevent sending, rather than losing its ID.
        const requestsBeforeStorageFailure=requests.length;
        const storageError=await page.evaluate(async () => {
            const original=Storage.prototype.setItem;
            Storage.prototype.setItem=function(k,v){if(k.startsWith(WORK_DRAFT_PREFIX))throw new Error('quota');return original.call(this,k,v);};
            try {await postApi({type:'入庫',id:'ITEM-B',qty:1});return '';}
            catch(e){return e.message;}
            finally{Storage.prototype.setItem=original;}
        });
        assert.match(storageError,/尚未送出/);
        assert.equal(requests.length,requestsBeforeStorageFailure);
        await page.evaluate(() => saveWorkDraft());

        // Logout retains drafts, stops cameras, and prevents another account seeing them.
        await page.evaluate(async () => {await switchTab('manual');document.getElementById('manualId').value='DRAFT';document.getElementById('manualQty').value='4';saveWorkDraft();startSessionTimer(Date.now()-1801000);});
        await page.waitForFunction(() => !CURRENT_SESSION_TOKEN && !isHomeScanningActive && !isScanningActive);
        assert.equal(await page.inputValue('#manualId'),'');
        await page.evaluate(() => restoreWorkDraft('other-user'));
        assert.equal(await page.inputValue('#manualId'),'');
        await page.evaluate(() => restoreWorkDraft('test'));
        assert.equal(await page.inputValue('#manualId'),'DRAFT');
        assert.equal(await page.inputValue('#manualQty'),'4');
        assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('sessionTimer')).display !== 'none' || document.getElementById('sessionTimer').classList.contains('hidden')),true);

        // Updates cannot reload an active draft. The service worker never navigates clients.
        const sw = fs.readFileSync(path.join(root,'sw.js'),'utf8');
        assert.ok(!sw.includes('client.navigate'));
        assert.ok(sw.includes("'./workflow.js?v=20260928-safety3'"));
        await page.evaluate(() => {window.updateCalls=0;waitingRegistration={waiting:{postMessage(){window.updateCalls++}}};applyWaitingUpdate();});
        assert.equal(await page.evaluate(() => window.updateCalls),0);
        assert.deepEqual(errors,[]);
        console.log('PASS: duplicate scans, batch selection, autofill, draft sync/reload/session expiry, inbound/outbound idempotent retry, stocktake draft, storage failure, rejection, update guard; mobile 390px.');
        await context.close();
    } finally { await browser.close(); server.close(); }
})().catch(error => {console.error(error);server.close();process.exitCode=1;});
