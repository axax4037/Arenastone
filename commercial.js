(() => {
  const session = { token: '', account: '', expiresAt: 0, timer: 0 };
  const nativeFetch = window.fetch.bind(window);
  // 舊版入庫／領用／盤點函式仍直接呼叫 fetch；在這一層補上權杖，避免漏傳。
  window.fetch = (url, options = {}) => {
    if (String(url) === API_URL && session.token && String(options.method || 'GET').toUpperCase() === 'POST' && options.body) {
      try {
        const body = JSON.parse(options.body);
        if (!body.token) options = { ...options, body: JSON.stringify({ ...body, token: session.token }) };
      } catch (_) {}
    }
    return nativeFetch(url, options);
  };
  const badge = document.createElement('button');
  badge.className = 'hidden';
  document.querySelector('header').append(badge);
  const request = async data => {
    const payload = { ...data, token: session.token };
    const r = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    const result = JSON.parse(await r.text());
    if (!r.ok || !result.success) throw Error(result.error || '操作被拒絕');
    return result;
  };
  window.COMMERCIAL_TOKEN = () => session.token;
  window.submitData = request;
  const logout = message => { clearInterval(session.timer); session.token = ''; badge.classList.add('hidden'); document.getElementById('login').classList.remove('hidden'); if (message) toast(message); };
  const tick = () => { const left = Math.ceil((session.expiresAt - Date.now()) / 1000); if (left <= 0) return logout('登入已逾時，請重新登入'); badge.classList.remove('hidden'); badge.textContent = `登入剩餘 ${String(Math.floor(left/60)).padStart(2,'0')}:${String(left%60).padStart(2,'0')}｜延長`; badge.style.color = left <= 300 ? '#b45309' : '#1d4ed8'; };
  const apply = (data, account) => { session.token=data.token; session.account=account; session.expiresAt=Date.now()+data.expiresIn*1000; state.user=data.name; window.CURRENT_USER_NAME=data.name; clearInterval(session.timer); session.timer=setInterval(tick,1000); tick(); document.getElementById('userTag').textContent='👤 '+data.name; document.getElementById('login').classList.add('hidden'); };
  const login = document.getElementById('loginBtn'); login.replaceWith(login.cloneNode(true));
  document.getElementById('loginBtn').onclick=async()=>{ const account=document.getElementById('account').value.trim(), password=document.getElementById('password').value; try { const data=await request({action:'login',account,password}); apply(data,account); await load(); } catch(e) { toast('登入失敗：'+e.message); } };
  badge.onclick=async()=>{ const password=prompt('請再次輸入密碼以延長登入 30 分鐘'); if(password===null)return; try { const data=await request({action:'renewSession',account:session.account,password}); apply(data,session.account); toast('登入已延長 30 分鐘','success'); } catch(e) { toast('延長登入失敗：'+e.message); } };
})();
