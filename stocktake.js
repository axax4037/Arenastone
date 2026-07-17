/* 物流式盤點：掃一次即計一件，完成後一次寫入實盤數。 */
(() => {
  const originalOnCode = window.onOperationCode;
  let session = null;

  function setText(id, value) { const el = document.getElementById(id); if (el) el.textContent = value; const overlay = document.getElementById('cameraScanCount'); if (overlay) overlay.textContent = `已掃描 ${value} 件`; }
  function panel() {
    let el = document.getElementById('logisticsStocktakePanel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'logisticsStocktakePanel';
      el.className = 'notice hidden';
      el.innerHTML = '物流掃描盤點：<strong id="logisticsCount">0</strong> 件<br><span class="muted">每掃一次相同條碼即累加 1 件；無需輸入數量。</span>';
      document.getElementById('scanQty').closest('label').after(el);
    }
    let overlay = document.getElementById('cameraScanCount');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'cameraScanCount';
      overlay.style.cssText = 'position:absolute;top:10px;left:10px;z-index:5;background:#166534;color:#fff;padding:7px 11px;border-radius:7px;font-weight:700;box-shadow:0 2px 8px #0008';
      overlay.textContent = '已掃描 0 件';
      const reader = document.getElementById('reader');
      reader.style.position = 'relative'; reader.append(overlay);
    }
    return el;
  }
  function refresh() {
    const isStocktake = window.state && state.mode === 'stocktake';
    document.getElementById('scanQty').closest('label').classList.toggle('hidden', isStocktake);
    panel().classList.toggle('hidden', !isStocktake);
    if (isStocktake) setText('logisticsCount', session ? session.count : 0);
  }
  function reset() {
    session = null;
    setText('logisticsCount', 0);
    document.getElementById('scanSubmit').textContent = '開始掃描盤點';
  }
  function batch() {
    try { return JSON.parse(document.getElementById('scanBatch').value); } catch (_) { return null; }
  }
  async function finish() {
    if (!session || session.count < 1) return window.toast('請至少掃描一件再完成盤點');
    const button = document.getElementById('scanSubmit');
    button.disabled = true;
    try {
      await window.request({ type: '盤點', id: session.id, name: session.name, lot: session.lot, expiry: session.expiry, qty: session.count, user: state.user, note: '[物流掃描盤點] ' + document.getElementById('scanNote').value.trim() });
      window.toast(`盤點完成：${session.name} 共 ${session.count} 件`, 'success');
      await window.stopScanner('main');
      document.getElementById('reader').classList.add('hidden');
      document.getElementById('scanForm').classList.add('hidden');
      reset();
      await window.load();
    } catch (error) { window.toast('盤點提交失敗：' + error.message); }
    finally { button.disabled = false; }
  }
  async function startLogisticsScanner() {
    await window.stopScanner('main');
    document.getElementById('reader').classList.remove('hidden');
    const qr = new Html5Qrcode('reader');
    state.scanner = qr;
    try {
      // 比照 Gemini 版：不限定條碼格式，也不以狹長框裁切畫面。
      // QR Code 需要方形完整視野；一維碼則由函式庫在完整影像中自動偵測。
      const config = { fps: 12, disableFlip: false };
      await qr.start({ facingMode: 'environment' }, config, async code => {
        if (state.mode === 'stocktake' && session) {
          const now = Date.now();
          if (now - session.lastScan < 1000) return;
          session.lastScan = now;
          if (code !== session.id) return window.toast(`目前正在盤點 ${session.name}；請完成或取消後再掃其他品項`);
          session.count += 1;
          setText('logisticsCount', session.count);
          window.toast(`已掃描 ${session.count} 件`, 'success');
          return;
        }
        await originalOnCode(code);
        if (state.mode === 'stocktake') {
          refresh();
          document.getElementById('scanSubmit').textContent = '開始掃描盤點';
        }
      }, () => {});
      document.getElementById('scanStatus').textContent = '掃描中…';
    } catch (error) {
      await window.stopScanner('main');
      document.getElementById('reader').classList.add('hidden');
      window.toast('鏡頭無法啟動：' + error.message);
    }
  }

  window.scanModeUI = new Proxy(window.scanModeUI, { apply(target, thisArg, args) { const result = Reflect.apply(target, thisArg, args); refresh(); return result; } });
  window.onOperationCode = async function(code) {
    if (state.mode === 'stocktake' && session) {
      if (code !== session.id) return window.toast(`目前正在盤點 ${session.name}；請完成或取消後再掃其他品項`);
      session.count += 1;
      setText('logisticsCount', session.count);
      window.toast(`已掃描 ${session.count} 件`, 'success');
      return;
    }
    await originalOnCode(code);
    if (state.mode === 'stocktake') {
      refresh();
      document.getElementById('scanSubmit').textContent = '開始掃描盤點';
    }
  };

  const submit = document.getElementById('scanSubmit');
  submit.replaceWith(submit.cloneNode(true));
  document.getElementById('scanSubmit').onclick = async () => {
    if (state.mode !== 'stocktake') return window.submitScan();
    if (session) return finish();
    const id = document.getElementById('scanId').value;
    const selected = batch();
    if (!id || !selected) return window.toast('請先掃描條碼並選擇要盤點的批次');
    session = { id, name: document.getElementById('scanName').value, lot: selected.lot, expiry: selected.expiry, count: 0, lastScan: 0 };
    document.getElementById('scanBatch').disabled = true;
    document.getElementById('scanSubmit').textContent = '完成盤點並送出';
    refresh();
    await startLogisticsScanner();
    window.toast('開始掃描盤點：每掃一次即累加 1 件', 'success');
  };

  const cancel = document.getElementById('scanCancel');
  cancel.replaceWith(cancel.cloneNode(true));
  document.getElementById('scanCancel').onclick = async () => {
    await window.stopScanner('main');
    document.getElementById('reader').classList.add('hidden');
    document.getElementById('scanForm').classList.add('hidden');
    document.getElementById('scanBatch').disabled = false;
    reset();
    window.toast('已取消本次掃描盤點', 'success');
  };

  const start = document.getElementById('startScan');
  start.replaceWith(start.cloneNode(true));
  document.getElementById('startScan').onclick = startLogisticsScanner;
  const home = document.getElementById('homeScanBtn');
  home.replaceWith(home.cloneNode(true));
  document.getElementById('homeScanBtn').onclick = async () => {
    document.querySelectorAll('.view').forEach(view => view.classList.remove('active'));
    document.getElementById('operation').classList.add('active');
    state.mode = 'stocktake';
    refresh();
    document.querySelectorAll('.mode').forEach(button => button.classList.toggle('primary', button.dataset.mode === 'stocktake'));
    await startLogisticsScanner();
  };

  refresh();
})();
