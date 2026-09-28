// Per-tab drafts are mirrored to per-account local storage so a closed tab/PWA can be resumed.
// Nothing here is automatically submitted on restore.
const WORK_DRAFT_PREFIX = 'SHANSHI_WORK_V1:';
// Unconfirmed mutation journal must survive a full tab/PWA restart so the same requestId can be retried.
const PENDING_WRITE_PREFIX = 'SHANSHI_PENDING_WRITE_V1:';
const inlineDrafts = new Map();
const homeBatchChoices = new Map();
const draftFieldIds = ['scanLocation','scanName','scanLot','scanExpiry','scanPrice','scanQty','scanNote','inboundBatchSelect',
    'manualType','manualLocation','manualId','manualName','manualLot','manualExpiry','manualPrice','manualQty','manualNote',
    'manualUseFefo','manualBatchSelect','stocktakeLocation','stocktakeBlindMode','stocktakeSessionNote'];
let draftAccount = '', pendingWrite = null, writeInFlight = false, draftStorageFailed = false, pendingWriteRecoveredFromJournal = false;
let homeScanGate = { codes: new Set(), misses: 0 }, homePendingCode = '', waitingRegistration = null;
let restoredStocktakeDraft = null, restoredTab = '', sessionWarningShown = false;

function captureWorkDraft() {
    const fields = {};
    for (const id of draftFieldIds) {
        const el = document.getElementById(id);
        if (el) fields[id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    const stocktake = selectedStocktakeLine && currentStocktakeSession ? {
        sessionId: currentStocktakeSession.session_id, batchId: selectedStocktakeLine.batch_id,
        qty: document.getElementById('stocktakeQty').value, reason: document.getElementById('stocktakeReason').value,
        note: document.getElementById('stocktakeLineNote').value
    } : restoredStocktakeDraft;
    return {fields, stocktake, inline: [...inlineDrafts], inbound: [...scanSessionCounts.inbound],
        outbound: [...scanSessionCounts.outbound], pendingWrite, scanMode, scannedData,
        scanFormOpen: !document.getElementById('scanForm').classList.contains('hidden'),
        tab: [...document.querySelectorAll('#mainContent > div')].find(el => !el.classList.contains('hidden'))?.id.replace('View','') || 'dashboard'};
}

function pendingWriteStorageKey(account, requestId) {
    return `${PENDING_WRITE_PREFIX}${account}:${requestId}`;
}

function listPersistedPendingWrites(account) {
    const prefix = `${PENDING_WRITE_PREFIX}${account}:`, writes = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        try {
            const write = JSON.parse(localStorage.getItem(key) || 'null');
            if (write?.payload?._requestId) writes.push(write);
        } catch {}
    }
    return writes.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

function persistPendingWrite(write, account = draftAccount) {
    if (!write?.payload?._requestId || !account) return;
    localStorage.setItem(pendingWriteStorageKey(account, write.payload._requestId), JSON.stringify(write));
}

function removePersistedPendingWrite(write, account = draftAccount) {
    if (!write?.payload?._requestId || !account) return;
    localStorage.removeItem(pendingWriteStorageKey(account, write.payload._requestId));
}

function saveWorkDraft(required = false) {
    if (!draftAccount) { if (required) throw new Error('請重新登入後再送出'); return false; }
    try {
        const serialized = JSON.stringify(captureWorkDraft());
        sessionStorage.setItem(WORK_DRAFT_PREFIX + draftAccount, serialized);
        localStorage.setItem(WORK_DRAFT_PREFIX + draftAccount, serialized);
        if (pendingWrite) persistPendingWrite(pendingWrite);
        draftStorageFailed = false;
        return true;
    } catch {
        draftStorageFailed = true;
        renderWorkflowNotice();
        if (required) throw new Error('無法保存送出紀錄，尚未送出。請確認瀏覽器儲存空間後重試。');
        return false;
    }
}

function restoreWorkDraft(account) {
    draftAccount = account;
    let draft = null, persistedWrite = null;
    try { draft = JSON.parse(sessionStorage.getItem(WORK_DRAFT_PREFIX + account) || 'null'); } catch {}
    if (!draft) {
        try { draft = JSON.parse(localStorage.getItem(WORK_DRAFT_PREFIX + account) || 'null'); } catch {}
    }
    try {
        const sessionWrite = draft?.pendingWrite?.payload?._requestId ? draft.pendingWrite : null;
        if (sessionWrite) {
            const saved = JSON.parse(localStorage.getItem(pendingWriteStorageKey(account, sessionWrite.payload._requestId)) || 'null');
            persistedWrite = saved?.payload?._requestId ? saved : sessionWrite;
        } else persistedWrite = listPersistedPendingWrites(account)[0] || null;
    } catch {}
    const sessionWrite = draft?.pendingWrite?.payload?._requestId ? draft.pendingWrite : null;
    pendingWrite = sessionWrite || persistedWrite;
    pendingWriteRecoveredFromJournal = !!pendingWrite && !sessionWrite;
    if (pendingWrite) {
        try { persistPendingWrite(pendingWrite, account); }
        catch { draftStorageFailed = true; }
    }
    if (!draft) { renderWorkflowNotice(); return; }
    inlineDrafts.clear();
    for (const [key, value] of draft.inline || []) inlineDrafts.set(key, value);
    for (const mode of ['inbound','outbound']) {
        scanSessionCounts[mode].clear();
        for (const [key, value] of draft[mode] || []) scanSessionCounts[mode].set(key, value);
    }
    scannedData = draft.scannedData || null;
    setScanMode(draft.scanMode || 'inbound');
    if (scannedData && scanMode === 'inbound') populateInboundBatches(scannedData);
    const restoreFields = () => {
        for (const [id, value] of Object.entries(draft.fields || {})) {
            if (!draftFieldIds.includes(id)) continue;
            const el = document.getElementById(id);
            if (el) { if (el.type === 'checkbox') el.checked = value; else el.value = value; }
        }
    };
    restoreFields();
    toggleManualMode();
    restoreFields();
    document.getElementById('scanForm').classList.toggle('hidden', !draft.scanFormOpen);
    if (draft.scanFormOpen) document.getElementById('scanFormTitle').textContent = '已恢復入庫草稿，請核對批號與效期';
    restoredStocktakeDraft = draft.stocktake || null;
    restoredTab = ['scanner','manual','stocktake','dashboard'].includes(draft.tab) ? draft.tab : 'dashboard';
    filterItems();
    renderScanSession();
    renderWorkflowNotice();
}

function hasWorkDraft() {
    return !!pendingWrite || writeInFlight || inlineDrafts.size > 0 || scanSessionCounts.inbound.size > 0 || scanSessionCounts.outbound.size > 0 ||
        !!restoredStocktakeDraft || !!selectedStocktakeLine || !document.getElementById('scanForm').classList.contains('hidden') ||
        ['manualId','manualQty','manualNote','stocktakeSessionNote'].some(id => document.getElementById(id)?.value.trim());
}

function renderWorkflowNotice() {
    const box = document.getElementById('workflowNotice');
    if (!box) return;
    document.querySelectorAll('#scannerView input, #scannerView select, #scannerView button, #manualView input, #manualView select, #manualView textarea, #manualView button, #stocktakeView input, #stocktakeView select, #stocktakeView textarea, #stocktakeView button, .inline-stocktake-v4 input, .inline-stocktake-v4 button, #homeScanSaveBtn').forEach(el => {
        if (pendingWrite && !el.disabled) { el.disabled = true; el.dataset.writeLocked = '1'; }
        else if (!pendingWrite && el.dataset.writeLocked) { el.disabled = false; delete el.dataset.writeLocked; }
    });
    box.classList.toggle('hidden', !pendingWrite && !draftStorageFailed && !hasWorkDraft());
    box.innerHTML = pendingWrite
        ? `上次送出結果尚未確認。請勿重建相同作業；重新確認會沿用同一筆交易。<button onclick="retryPendingWrite()" class="mini-btn primary" ${writeInFlight?'disabled':''}>${writeInFlight?'確認中…':'重新確認結果'}</button>`
        : draftStorageFailed ? '草稿目前無法保存，請勿關閉或重新整理此分頁。' : '有未完成草稿，已安全保存；重新開啟或登入相同帳號後可繼續。';
}

function rememberInlineQty(index) {
    const item = allItems[index], input = document.getElementById(`inline-qty-${index}`);
    if (!item || !input) return;
    inlineDrafts.set(getBatchIndexKey(item), {qty: input.value, item: {...item}});
    saveWorkDraft();
    renderWorkflowNotice();
}

function restoreInlineInputs() {
    modifiedScanIndices.clear();
    for (const [key, draft] of inlineDrafts) {
        const index = itemIndexes.sourceIndexByBatch.get(key);
        const input = document.getElementById(`inline-qty-${index}`);
        if (!input) continue;
        modifiedScanIndices.add(index);
        input.value = draft.qty;
        document.getElementById(`inline-input-panel-${index}`)?.classList.remove('hidden');
    }
}

function acceptHomeCode(code) {
    if (!code || homeScanGate.codes.has(code) || homePendingCode) { homeScanGate.misses = 0; return false; }
    homeScanGate.codes.add(code);
    homeScanGate.misses = 0;
    return true;
}

function homeScanMiss() {
    // Keep every barcode seen in the current camera view blocked until the view is clear.
    if (homeScanGate.codes.size && ++homeScanGate.misses >= 12) homeScanGate = {codes: new Set(), misses: 0};
}

function handleHomeScan(text) {
    if (!isHomeScanningActive || !CURRENT_SESSION_TOKEN || writeInFlight || pendingWrite) return;
    const code = String(text || '').trim();
    if (!acceptHomeCode(code)) return;
    const candidates = (itemIndexes.byId.get(code) || []).filter(i => !selectedDashboardLocationId || Number(i.location_id) === selectedDashboardLocationId);
    if (!candidates.length) { playErrorSound(); showToast('此庫位無此品項','error'); return; }
    const choiceKey = `${code}::${selectedDashboardLocationId}`;
    const chosen = candidates.find(i => getBatchIndexKey(i) === homeBatchChoices.get(choiceKey));
    if (candidates.length > 1 && !chosen) {
        homePendingCode = code;
        document.getElementById('homeBatchSelect').innerHTML = candidates.map(i => `<option value="${escapeHtmlClient(getBatchIndexKey(i))}">${escapeHtmlClient(i.location_name)}｜LOT ${escapeHtmlClient(i.lot || '無')}｜效期 ${escapeHtmlClient(i.expiry || '未填')}</option>`).join('');
        document.getElementById('homeBatchPicker').classList.remove('hidden');
        document.getElementById('homeScanStatus').textContent = '請先確認實際批次，再繼續掃描。';
        return;
    }
    countHomeItem(chosen || candidates[0]);
}

function confirmHomeBatch() {
    if (!homePendingCode || pendingWrite || writeInFlight) return;
    const key = document.getElementById('homeBatchSelect').value;
    const item = (itemIndexes.byId.get(homePendingCode) || []).find(i => getBatchIndexKey(i) === key);
    if (!item) return;
    homeBatchChoices.set(`${homePendingCode}::${selectedDashboardLocationId}`, key);
    homePendingCode = '';
    document.getElementById('homeBatchPicker').classList.add('hidden');
    countHomeItem(item);
}

function countHomeItem(item) {
    const key = getBatchIndexKey(item), previous = inlineDrafts.get(key);
    const value = previous ? Number(previous.qty) : 0;
    if (!Number.isInteger(value) || value < 0) { showAlert('請先修正此批次實盤數量'); return; }
    inlineDrafts.set(key, {qty: String(value + 1), item: {...item}});
    restoreInlineInputs();
    saveWorkDraft();
    playBeepSound();
    const status = document.getElementById('homeScanStatus');
    status.textContent = `${item.name}｜LOT ${item.lot || '無'}｜效期 ${item.expiry || '未填'}｜實盤 ${value + 1} `;
    const change = document.createElement('button');
    change.textContent = '下次改掃其他批次'; change.className = 'mini-btn';
    change.onclick = () => { homeBatchChoices.delete(`${item.id}::${selectedDashboardLocationId}`); change.textContent = '請移開條碼，下次掃描將重新選批次'; };
    status.appendChild(change);
    renderWorkflowNotice();
}

function populateInboundBatches(id) {
    const rows = itemIndexes.byId.get(id) || [], picker = document.getElementById('inboundBatchPicker');
    picker.classList.toggle('hidden', scanMode !== 'inbound' || !rows.length);
    const unique = [...new Map(rows.map(i => [i.batch_id,i])).values()];
    document.getElementById('inboundBatchSelect').innerHTML = unique.map(i => `<option value="${i.batch_id}">LOT ${escapeHtmlClient(i.lot || '無')}｜效期 ${escapeHtmlClient(i.expiry || '未填')}</option>`).join('') + '<option value="new">新批次（保留品名與單價）</option>';
    const item = chooseQuickInboundMatch(rows, getSelectedLocationId('scanLocation'));
    if (item) { document.getElementById('inboundBatchSelect').value = String(item.batch_id); fillQuickInboundFields(item); }
}

function selectInboundBatch() {
    const value = document.getElementById('inboundBatchSelect').value;
    const item = (itemIndexes.byId.get(scannedData) || []).find(i => String(i.batch_id) === value);
    if (item) fillQuickInboundFields(item);
    else { document.getElementById('scanLot').value = ''; document.getElementById('scanExpiry').value = ''; }
    saveWorkDraft();
}

function isInventoryWrite(payload) {
    return !!payload.type || ['batchQuickScan','batchStocktake','stocktakeRecord','inventoryMovement','fefoIssue'].includes(payload.action);
}

function completeDraftWrite(write, res) {
    const p = write.payload;
    if (p.action === 'batchQuickScan') scanSessionCounts[p.mode].clear();
    if (write.context === 'scanner') {
        document.getElementById('scanForm').classList.add('hidden');
        document.getElementById('scanResult').classList.add('hidden');
        scannedData = null;
    }
    if (write.context === 'manual') {
        ['manualId','manualName','manualLot','manualExpiry','manualQty','manualPrice','manualNote'].forEach(id => document.getElementById(id).value = '');
    }
    if (write.context?.inlineKey) inlineDrafts.delete(write.context.inlineKey);
    if (p.action === 'batchStocktake') for (const item of p.items) inlineDrafts.delete(getBatchIndexKey(item));
    if (p.action === 'stocktakeRecord') {
        restoredStocktakeDraft = null;
        currentStocktakeSession = res.session || currentStocktakeSession;
        closeStocktakeCountPanel();
        renderStocktakeSession();
    }
    renderScanSession();
}

async function retryPendingWrite() {
    if (!pendingWrite || writeInFlight) return;
    if (!CURRENT_SESSION_TOKEN) { showAlert('請先使用原帳號重新登入'); return; }
    try {
        const res = await postApi(pendingWrite.payload, {draftContext: pendingWrite.context, timeoutMs: 45000});
        applyMutationResponse(res);
        showAlert('已確認原交易成功，庫存已同步。');
    } catch (e) { showAlert(e.message); }
}

function restoreStocktakeInput() {
    const draft = restoredStocktakeDraft;
    if (!draft || !currentStocktakeSession) return;
    if (String(currentStocktakeSession.session_id) !== String(draft.sessionId) || currentStocktakeSession.status !== 'open') {
        showAlert('先前盤點單已結束或已變更，請核對庫存後重新盤點。');
        restoredStocktakeDraft = null;
        return;
    }
    const line = currentStocktakeSession.lines?.find(x => String(x.batch_id) === String(draft.batchId));
    if (!line || line.status === 'counted') { restoredStocktakeDraft = null; return; }
    selectStocktakeBatch(draft.batchId);
    document.getElementById('stocktakeQty').value = draft.qty;
    document.getElementById('stocktakeReason').value = draft.reason;
    document.getElementById('stocktakeLineNote').value = draft.note;
    restoredStocktakeDraft = null;
    updateStocktakeReasonVisibility();
}

async function stopWorkCameras() {
    isScanningActive = false; isHomeScanningActive = false; stocktakeQrActive = false;
    const cameras = [html5QrCode, homeQrCode, stocktakeQrCode];
    html5QrCode = null; homeQrCode = null; stocktakeQrCode = null;
    for (const camera of cameras) {
        if (!camera) continue;
        try { if (camera.isScanning) await camera.stop(); camera.clear(); } catch {}
    }
    document.getElementById('scannerPlaceholder').classList.remove('hidden');
    document.getElementById('homeScannerPanel').classList.add('hidden');
    document.getElementById('homeScanTriggerBtn').textContent = '開啟掃描';
    document.getElementById('stocktakeReaderWrap').classList.add('hidden');
    document.getElementById('stocktakeScannerBtn').textContent = '開啟相機';
}

function showWaitingUpdate(registration) {
    if (!registration.waiting || !navigator.serviceWorker.controller) return;
    waitingRegistration = registration;
    document.getElementById('updateNotice').classList.remove('hidden');
}

function applyWaitingUpdate() {
    if (hasWorkDraft()) { showAlert('請先完成或明確取消目前草稿，再更新版本。'); return; }
    if (!waitingRegistration?.waiting) return;
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {once:true});
    waitingRegistration.waiting.postMessage({type:'SKIP_WAITING'});
}

document.addEventListener('input', e => {
    if (e.target.id?.startsWith('inline-qty-')) rememberInlineQty(Number(e.target.id.slice('inline-qty-'.length)));
    else if (e.target.closest('#mainContent')) { saveWorkDraft(); renderWorkflowNotice(); }
});
document.addEventListener('change', e => { if (e.target.closest('#mainContent')) saveWorkDraft(); });
window.addEventListener('beforeunload', e => {
    saveWorkDraft();
    if (CURRENT_SESSION_TOKEN && hasWorkDraft()) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('pagehide', () => saveWorkDraft());
document.addEventListener('visibilitychange', () => { if (document.hidden) saveWorkDraft(); });
