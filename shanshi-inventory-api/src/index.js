var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.js
var TAIPEI_TZ = "Asia/Taipei";
var PBKDF2_ITERATIONS = 12e4;
var APP_SCHEMA_VERSION = "4.0.0";
var ROLE_LEVEL = Object.freeze({ viewer: 0, operator: 1, inventory_manager: 2, system_admin: 3 });
var ROLE_LABEL = Object.freeze({ viewer: "\u552F\u8B80", operator: "\u4E00\u822C\u64CD\u4F5C\u54E1", inventory_manager: "\u5EAB\u5B58\u7BA1\u7406\u54E1", system_admin: "\u7CFB\u7D71\u7BA1\u7406\u54E1" });
var MOVEMENT_TYPES = /* @__PURE__ */ new Set(["\u5831\u5EE2", "\u9000\u8CA8", "\u5EAB\u5B58\u8ABF\u6574", "\u8ABF\u64A5"]);
var DEFAULT_CONTINUOUS_SCAN_DELAY_SECONDS = 0.65;
var index_default = {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return corsResponse(null, 204, origin, env);
    let action = "";
    let actor = null;
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        let dbSchemaVersion = "";
        let hardeningReady = false;
        let hardeningChecks = { authRateLimits: false, loginChallenges: false, oneOpenStocktake: false };
        try {
          dbSchemaVersion = await getSetting(env.DB, "schema_version");
          const hardening = await env.DB.prepare(`SELECT type,name FROM sqlite_master WHERE name IN ('auth_rate_limits','login_challenges','idx_stocktake_one_open_per_user')`).all();
          const names = new Set((hardening.results || []).map((x) => safeText(x.name)));
          hardeningChecks = {
            authRateLimits: names.has("auth_rate_limits"),
            loginChallenges: names.has("login_challenges"),
            oneOpenStocktake: names.has("idx_stocktake_one_open_per_user")
          };
          hardeningReady = Object.values(hardeningChecks).every(Boolean);
        } catch {
        }
        const dbReady = dbSchemaVersion === APP_SCHEMA_VERSION && hardeningReady;
        return corsJson({ success: dbReady, service: env.APP_NAME || "Arenastone Inventory API", schemaVersion: APP_SCHEMA_VERSION, dbSchemaVersion, dbReady, hardeningReady, hardeningChecks, time: (/* @__PURE__ */ new Date()).toISOString() }, dbReady ? 200 : 503, origin, env);
      }
      if (request.method === "GET") {
        const session2 = await requireSession(request, env);
        if (!session2.ok) return corsJson({ success: false, error: session2.error }, 401, origin, env);
        actor = enrichActor(session2.user, request);
        const resource = safeText(url.searchParams.get("resource"));
        let result2;
        if (resource === "transactionResult") {
          const id = safeText(url.searchParams.get("requestId"));
          const identity = await env.DB.prepare("SELECT user_id FROM request_identities WHERE request_id=?").bind(id).first();
          if (!identity || Number(identity.user_id) !== Number(actor.id)) throw withStatus("找不到可存取的交易", 404);
          const record = await getRequestRecord(env.DB, id);
          const transactions = await env.DB.prepare("SELECT id,type,item_id,batch_id,location_id,qty,balance_before,balance_after,document_no,created_at FROM transactions WHERE request_id=? ORDER BY id").bind(id).all();
          result2 = {success:true, requestId:id, state:record ? (record.response_json ? "completed" : "committed") : "not_committed", transactions:transactions.results||[]};
        }
        else if (resource === "users") result2 = await listUsersChecked(env, actor);
        else if (resource === "locations") result2 = await listLocations(env, actor, url.searchParams.get("includeInactive") === "1");
        else if (resource === "stocktake") result2 = await getStocktakeSession(env, safeText(url.searchParams.get("sessionId")), actor);
        else if (resource === "adjustments") result2 = await listAdjustments(env, actor, safeText(url.searchParams.get("sessionId")));
        else if (resource === "analytics") result2 = await getAnalytics(env, actor, Number(url.searchParams.get("locationId") || 0));
        else if (resource === "anomalies") result2 = await getAnomalies(env, actor, Number(url.searchParams.get("locationId") || 0));
        else if (resource === "audit") result2 = await listAuditLogs(env, actor, url.searchParams);
        else if (resource === "systemLogs") result2 = await listSystemLogs(env, actor, url.searchParams);
        else if (resource === "adminInventory") result2 = await getAdminInventory(env, actor);
        else if (resource === "backupStatus") result2 = await getBackupStatus(env, actor);
        else if (resource === "scanSettings") result2 = await getScanSettings(env, actor);
        else {
          const items = await getAllInventory(env.DB, actor, { locationId: Number(url.searchParams.get("locationId") || 0) });
          const openSession = await getOpenStocktakeSummary(env.DB, actor.id);
          const locations = await activeLocations(env.DB);
          result2 = { success: true, items, locations, openStocktakeSession: openSession, capabilities: capabilitiesFor(actor), settings: { continuousScanDelaySeconds: await getContinuousScanDelaySeconds(env.DB) }, schemaVersion: APP_SCHEMA_VERSION };
        }
        return corsJson(result2, result2.success === false ? result2.status || 400 : 200, origin, env);
      }
      if (request.method !== "POST") return corsJson({ success: false, error: "Method Not Allowed" }, 405, origin, env);
      const params = await parseJsonBody(request);
      action = safeText(params.action);
      if (action === "loginChallenge") {
        const result2 = await handleLoginChallenge(env, params, request);
        return corsJson(result2, 200, origin, env);
      }
      if (action === "login") {
        const result2 = await handleLogin(env, params, request);
        return corsJson(result2, result2.success ? 200 : 401, origin, env);
      }
      const session = await requireSession(request, env);
      if (!session.ok) return corsJson({ success: false, error: session.error }, 401, origin, env);
      actor = enrichActor(session.user, request);
      if (action === "logout") {
        await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(session.tokenHash).run();
        return corsJson({ success: true }, 200, origin, env);
      }
      await bindRequestIdentity(env.DB, params, actor);
      let result;
      if (action === "clientLog") result = await handleClientLog(env, params, actor);
      else if (action === "updateThreshold") result = await handleThresholdUpdate(env, params, actor);
      else if (action === "batchQuickScan") result = await handleBatchQuickScan(env, params, actor);
      else if (action === "fefoIssue") result = await handleFefoIssue(env, params, actor);
      else if (action === "inventoryMovement") result = await handleInventoryMovement(env, params, actor);
      else if (action === "batchStocktake") result = await handleLegacyBatchStocktake(env, params, actor);
      else if (action === "startStocktakeSession") result = await startStocktakeSession(env, params, actor);
      else if (action === "getStocktakeSession") result = await getStocktakeSession(env, safeText(params.sessionId), actor);
      else if (action === "stocktakeRecord") result = await recordStocktakeLine(env, params, actor);
      else if (action === "completeStocktakeSession") result = await completeStocktakeSession(env, params, actor);
      else if (action === "cancelStocktakeSession") result = await cancelStocktakeSession(env, params, actor);
      else if (action === "resolveAdjustment") result = await resolveAdjustment(env, params, actor);
      else if (action === "sendManualReport") result = await handleManualReport(env, params, actor);
      else if (action === "setAutoSchedule") result = await handleAutoSchedule(env, params, actor);
      else if (action === "setScanSettings") result = await handleScanSettings(env, params, actor);
      else if (action === "listUsers") result = await listUsersChecked(env, actor);
      else if (action === "createUser") result = await createUser(env, params, actor);
      else if (action === "setUserActive") result = await setUserActive(env, params, actor);
      else if (action === "setUserRole") result = await setUserRole(env, params, actor);
      else if (action === "resetUserPassword") result = await resetUserPassword(env, params, actor);
      else if (action === "adminUpdateBatch") result = await adminUpdateBatch(env, params, actor);
      else if (action === "adminUpdateItem") result = await adminUpdateItem(env, params, actor);
      else if (action === "setItemActive") result = await setItemActive(env, params, actor);
      else if (action === "createLocation") result = await createLocation(env, params, actor);
      else if (action === "updateLocation") result = await updateLocation(env, params, actor);
      else result = await handleSingleMutation(env, params, actor);
      return corsJson(result, result.success ? 200 : result.status || 400, origin, env);
    } catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) console.error("Worker error", error);
      try {
        if (env?.DB) await logSystemEvent(env.DB, status >= 500 ? "error" : "warning", "REQUEST_ERROR", normalizeError(error), { action, actor, requestId: "", context: { status } });
      } catch {
      }
      return corsJson({ success: false, error: status >= 500 ? "系統暫時無法確認作業，請保留原單號並稍後重試。" : normalizeError(error) }, status, origin, env);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(Promise.allSettled([runScheduledReport(env, controller), runDailyMaintenance(env, controller)]));
  }
};
function normalizeError(error) {
  const msg = String(error?.message || error || "\u672A\u77E5\u932F\u8AA4");
  if (/CHECK constraint failed.*qty|constraint failed.*stock_balances/i.test(msg)) return "\u5EAB\u5B58\u4E0D\u8DB3\u6216\u8CC7\u6599\u5DF2\u88AB\u5176\u4ED6\u4F7F\u7528\u8005\u66F4\u65B0\uFF0C\u8ACB\u540C\u6B65\u5F8C\u518D\u8A66";
  if (/UNIQUE constraint failed: request_results\.request_id/i.test(msg)) return "\u91CD\u8907\u8ACB\u6C42";
  if (/UNIQUE constraint failed: inventory_batches/i.test(msg)) return "\u76F8\u540C\u54C1\u9805\u3001\u6279\u865F\u8207\u6548\u671F\u7684\u6279\u6B21\u5DF2\u5B58\u5728";
  if (/UNIQUE constraint failed: locations\.code/i.test(msg)) return "\u5132\u4F4D\u4EE3\u78BC\u5DF2\u5B58\u5728";
  return msg;
}
__name(normalizeError, "normalizeError");
function allowedOrigin(origin, env) {
  const configured = String(env.ALLOWED_ORIGINS || "*").trim();
  if (!configured || configured === "*") return "*";
  const allowed = configured.split(",").map((v) => v.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : allowed[0] || "*";
}
__name(allowedOrigin, "allowedOrigin");
function corsHeaders(origin, env) {
  return { "Access-Control-Allow-Origin": allowedOrigin(origin, env), "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization", "Access-Control-Max-Age": "86400", "Cache-Control": "no-store", "Vary": "Origin" };
}
__name(corsHeaders, "corsHeaders");
function corsJson(data, status, origin, env) {
  return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders(origin, env), "Content-Type": "application/json; charset=utf-8" } });
}
__name(corsJson, "corsJson");
function corsResponse(body, status, origin, env) {
  return new Response(body, { status, headers: corsHeaders(origin, env) });
}
__name(corsResponse, "corsResponse");
async function parseJsonBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw withStatus("\u8ACB\u6C42\u8CC7\u6599\u683C\u5F0F\u932F\u8AA4", 400);
  }
}
__name(parseJsonBody, "parseJsonBody");
function withStatus(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}
__name(withStatus, "withStatus");
function safeText(v) {
  return String(v ?? "").trim();
}
__name(safeText, "safeText");
function safeName(id, name) {
  return safeText(name) || safeText(id);
}
__name(safeName, "safeName");
function strictInteger(v, message = "\u6578\u91CF\u683C\u5F0F\u932F\u8AA4") {
  if (v === null || v === void 0 || String(v).trim() === "") throw withStatus(message, 400);
  const n = Number(v);
  if (!Number.isInteger(n)) throw withStatus(message, 400);
  return n;
}
__name(strictInteger, "strictInteger");
function safeQty(v, { allowZero = true } = {}) {
  const n = strictInteger(v);
  if (n < 0 || !allowZero && n === 0) throw withStatus("\u6578\u91CF\u683C\u5F0F\u932F\u8AA4", 400);
  return n;
}
__name(safeQty, "safeQty");
function safePrice(v) {
  if (v === null || v === void 0 || String(v).trim() === "") return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw withStatus("\u55AE\u50F9\u683C\u5F0F\u932F\u8AA4", 400);
  return n;
}
__name(safePrice, "safePrice");
function safeDay(v) {
  const n = strictInteger(v, "\u81EA\u52D5\u5BC4\u9001\u65E5\u671F\u9808\u70BA 1\u201328 \u65E5");
  if (n < 1 || n > 28) throw withStatus("\u81EA\u52D5\u5BC4\u9001\u65E5\u671F\u9808\u70BA 1\u201328 \u65E5", 400);
  return n;
}
__name(safeDay, "safeDay");
function safeEmail(v) {
  const e = safeText(v);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw withStatus("Email \u683C\u5F0F\u932F\u8AA4", 400);
  return e;
}
__name(safeEmail, "safeEmail");
function normalizeExpiry(v) {
  const s = safeText(v);
  if (!s) return "";
  const m = s.match(/^(\d{4})[-\/]?(\d{1,2})[-\/]?(\d{1,2})$/);
  if (!m) throw withStatus("\u6548\u671F\u683C\u5F0F\u932F\u8AA4\uFF0C\u8ACB\u4F7F\u7528 YYYY-MM-DD", 400);
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]), d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) throw withStatus("\u6548\u671F\u65E5\u671F\u4E0D\u5B58\u5728", 400);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
__name(normalizeExpiry, "normalizeExpiry");
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
__name(nowIso, "nowIso");
function taipeiDateOnly(date = /* @__PURE__ */ new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TAIPEI_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
__name(taipeiDateOnly, "taipeiDateOnly");
function taipeiDateTime(date = /* @__PURE__ */ new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TAIPEI_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}:${m.second}`;
}
__name(taipeiDateTime, "taipeiDateTime");
function taipeiParts(date = /* @__PURE__ */ new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TAIPEI_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { year: Number(m.year), month: Number(m.month), day: Number(m.day) };
}
__name(taipeiParts, "taipeiParts");
function addDaysYmd(ymd, days) {
  const d = /* @__PURE__ */ new Date(`${ymd}T00:00:00+08:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return taipeiDateOnly(d);
}
__name(addDaysYmd, "addDaysYmd");
function roleOf(user) {
  const r = safeText(user?.access_role || user?.role);
  if (r in ROLE_LEVEL) return r;
  return r === "admin" ? "system_admin" : "operator";
}
__name(roleOf, "roleOf");
function roleAtLeast(user, min) {
  return (ROLE_LEVEL[roleOf(user)] ?? -1) >= ROLE_LEVEL[min];
}
__name(roleAtLeast, "roleAtLeast");
function requireRole(user, min) {
  if (!roleAtLeast(user, min)) throw withStatus("\u6B0A\u9650\u4E0D\u8DB3", 403);
}
__name(requireRole, "requireRole");
function canViewCost(user) {
  return roleAtLeast(user, "inventory_manager");
}
__name(canViewCost, "canViewCost");
function canOperate(user) {
  return roleAtLeast(user, "operator");
}
__name(canOperate, "canOperate");
function canManageInventory(user) {
  return roleAtLeast(user, "inventory_manager");
}
__name(canManageInventory, "canManageInventory");
function isSystemAdmin(user) {
  return roleOf(user) === "system_admin";
}
__name(isSystemAdmin, "isSystemAdmin");
function capabilitiesFor(user) {
  return { role: roleOf(user), roleLabel: ROLE_LABEL[roleOf(user)] || roleOf(user), canOperate: canOperate(user), canManageInventory: canManageInventory(user), canSystemAdmin: isSystemAdmin(user), canViewCost: canViewCost(user) };
}
__name(capabilitiesFor, "capabilitiesFor");
function enrichActor(user, request) {
  return { ...user, access_role: roleOf(user), _ipHint: safeText(request.headers.get("CF-Connecting-IP")).slice(0, 64), _userAgent: safeText(request.headers.get("User-Agent")).slice(0, 240) };
}
__name(enrichActor, "enrichActor");
function isExpired(expiry) {
  return !!expiry && expiry < taipeiDateOnly();
}
__name(isExpired, "isExpired");
function documentNo(prefix, requestId) {
  const ymd = taipeiDateOnly().replaceAll("-", "");
  return `${prefix}-${ymd}-${safeText(requestId).replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase() || crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}
__name(documentNo, "documentNo");
var INVENTORY_SELECT = `SELECT b.batch_id,i.item_id,i.name,i.category,i.min_qty,i.target_qty,i.warning_days,i.lead_time_days,i.default_price AS price,i.is_active,b.lot,b.expiry,b.note AS batch_note,s.qty,s.last_stocktake,s.note AS balance_note,l.location_id,l.code AS location_code,l.name AS location_name,l.is_active AS location_active FROM items i JOIN inventory_batches b ON b.item_id=i.item_id JOIN stock_balances s ON s.batch_id=b.batch_id JOIN locations l ON l.location_id=s.location_id`;
function rowToItem(row, user) {
  if (!row) return null;
  return { batch_id: Number(row.batch_id) || 0, id: safeText(row.item_id), name: safeName(row.item_id, row.name), category: safeText(row.category), lot: safeText(row.lot), expiry: safeText(row.expiry), qty: Number(row.qty) || 0, min_qty: Number(row.min_qty) || 0, target_qty: Number(row.target_qty) || 0, warning_days: Number(row.warning_days) || 30, lead_time_days: Number(row.lead_time_days) || 7, price: canViewCost(user) ? Number(row.price) || 0 : null, note: safeText(row.balance_note) || safeText(row.batch_note), batch_note: safeText(row.batch_note), location_note: safeText(row.balance_note), last_stocktake: row.last_stocktake ? taipeiDateTime(new Date(row.last_stocktake)) : "", location_id: Number(row.location_id) || 0, location_code: safeText(row.location_code), location_name: safeText(row.location_name), is_active: Number(row.is_active) !== 0, expired: isExpired(safeText(row.expiry)) };
}
__name(rowToItem, "rowToItem");
async function getAllInventory(db, user, { locationId = 0, includeInactive = false } = {}) {
  let sql = `${INVENTORY_SELECT} WHERE 1=1`;
  const binds = [];
  if (!includeInactive) sql += " AND i.is_active=1 AND l.is_active=1";
  if (locationId) {
    sql += " AND l.location_id=?";
    binds.push(locationId);
  }
  sql += ` ORDER BY i.name COLLATE NOCASE,i.item_id,l.name,CASE WHEN b.expiry='' THEN 1 ELSE 0 END,b.expiry,b.lot`;
  const q = db.prepare(sql);
  const r = await (binds.length ? q.bind(...binds) : q).all();
  return (r.results || []).map((x) => rowToItem(x, user));
}
__name(getAllInventory, "getAllInventory");
async function getBalanceByKey(db, id, lot, expiry, locationId) {
  return db.prepare(`${INVENTORY_SELECT} WHERE i.item_id=? AND b.lot=? AND b.expiry=? AND l.location_id=? LIMIT 1`).bind(id, lot, expiry, locationId).first();
}
__name(getBalanceByKey, "getBalanceByKey");
async function getBalanceByBatchLocation(db, batchId, locationId) {
  return db.prepare(`${INVENTORY_SELECT} WHERE b.batch_id=? AND l.location_id=? LIMIT 1`).bind(batchId, locationId).first();
}
__name(getBalanceByBatchLocation, "getBalanceByBatchLocation");
async function getRowsByItemId(db, id, user) {
  const r = await db.prepare(`${INVENTORY_SELECT} WHERE i.item_id=? ORDER BY l.name,CASE WHEN b.expiry='' THEN 1 ELSE 0 END,b.expiry,b.lot,b.batch_id`).bind(id).all();
  return (r.results || []).map((x) => rowToItem(x, user));
}
__name(getRowsByItemId, "getRowsByItemId");
async function getRowsByBatchIds(db, ids, user) {
  const out = [];
  for (const id of [...new Set(ids.map(Number).filter(Boolean))]) {
    const r = await db.prepare(`${INVENTORY_SELECT} WHERE b.batch_id=? ORDER BY l.name`).bind(id).all();
    out.push(...(r.results || []).map((x) => rowToItem(x, user)));
  }
  return out;
}
__name(getRowsByBatchIds, "getRowsByBatchIds");
async function getRowsByBatchLocationPairs(db, pairs, user) {
  const out = [];
  for (const p of pairs) {
    const row = await getBalanceByBatchLocation(db, Number(p.batch_id), Number(p.location_id));
    if (row) out.push(rowToItem(row, user));
  }
  return out;
}
__name(getRowsByBatchLocationPairs, "getRowsByBatchLocationPairs");
async function activeLocations(db) {
  const r = await db.prepare(`SELECT location_id,code,name,is_active FROM locations WHERE is_active=1 ORDER BY name,code`).all();
  return r.results || [];
}
__name(activeLocations, "activeLocations");
async function getLocation(db, id) {
  return db.prepare("SELECT * FROM locations WHERE location_id=?").bind(Number(id)).first();
}
__name(getLocation, "getLocation");
async function requireActiveLocation(db, id) {
  const r = await getLocation(db, id);
  if (!r || Number(r.is_active) !== 1) throw withStatus("\u627E\u4E0D\u5230\u6709\u6548\u5132\u4F4D", 400);
  return r;
}
__name(requireActiveLocation, "requireActiveLocation");
function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(bytesToHex, "bytesToHex");
function hexToBytes(hex) {
  const c = String(hex || "").trim();
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return out;
}
__name(hexToBytes, "hexToBytes");
function base64Url(bytes) {
  let b = "";
  for (const x of bytes) b += String.fromCharCode(x);
  return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
__name(base64Url, "base64Url");
async function sha256Hex(text) {
  return bytesToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
__name(sha256Hex, "sha256Hex");
async function hmacSha256Hex(keyHex, text) {
  const key = await crypto.subtle.importKey("raw", hexToBytes(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text)));
}
__name(hmacSha256Hex, "hmacSha256Hex");
function timingSafeEqualHex(a, b) {
  const aa = String(a || "").toLowerCase(), bb = String(b || "").toLowerCase();
  if (aa.length !== bb.length) return false;
  let d = 0;
  for (let i = 0; i < aa.length; i++) d |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  return d === 0;
}
__name(timingSafeEqualHex, "timingSafeEqualHex");
function validPasswordCredential(hash, salt) {
  return /^[0-9a-f]{64}$/i.test(String(hash || "")) && /^[0-9a-f]{32}$/i.test(String(salt || ""));
}
__name(validPasswordCredential, "validPasswordCredential");
async function authRateKey(request, account) {
  const ip = safeText(request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown").split(",")[0].trim();
  return sha256Hex(`${ip}|${safeText(account).toLowerCase()}`);
}
__name(authRateKey, "authRateKey");
async function enforceAuthRateLimit(env, request, account) {
  const key = await authRateKey(request, account), now = /* @__PURE__ */ new Date(), row = await env.DB.prepare("SELECT window_start,attempts FROM auth_rate_limits WHERE rate_key=?").bind(key).first();
  const started = row?.window_start ? Date.parse(row.window_start) : 0, active = Number.isFinite(started) && now.getTime() - started < 10 * 60 * 1e3;
  if (active && Number(row.attempts) >= 20) throw withStatus("\u767B\u5165\u5617\u8A66\u904E\u65BC\u983B\u7E41\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66", 429);
  if (active) await env.DB.prepare("UPDATE auth_rate_limits SET attempts=attempts+1,updated_at=? WHERE rate_key=?").bind(now.toISOString(), key).run();
  else await env.DB.prepare(`INSERT INTO auth_rate_limits(rate_key,window_start,attempts,updated_at) VALUES(?,?,1,?) ON CONFLICT(rate_key) DO UPDATE SET window_start=excluded.window_start,attempts=1,updated_at=excluded.updated_at`).bind(key, now.toISOString(), now.toISOString()).run();
  return key;
}
__name(enforceAuthRateLimit, "enforceAuthRateLimit");
async function fakePasswordSalt(env, account) {
  const secret = safeText(env.AUTH_FAKE_SALT_SECRET);
  if (/^[0-9a-f]{64}$/i.test(secret)) return (await hmacSha256Hex(secret, `fake-salt:${safeText(account).toLowerCase()}`)).slice(0, 32);
  return (await sha256Hex(`fake-salt:${safeText(account).toLowerCase()}`)).slice(0, 32);
}
__name(fakePasswordSalt, "fakePasswordSalt");
async function handleLoginChallenge(env, params, request) {
  const account = safeText(params.account);
  if (!account) return { success: false, error: "\u8ACB\u8F38\u5165\u5E33\u865F" };
  await enforceAuthRateLimit(env, request, account);
  const u = await env.DB.prepare("SELECT password_salt FROM users WHERE account=? AND is_active=1 LIMIT 1").bind(account).first(), challengeId = crypto.randomUUID(), challenge = base64Url(crypto.getRandomValues(new Uint8Array(32))), created = /* @__PURE__ */ new Date(), expires = new Date(created.getTime() + 12e4);
  await env.DB.batch([env.DB.prepare("DELETE FROM login_challenges WHERE expires_at<=?").bind(created.toISOString()), env.DB.prepare("INSERT INTO login_challenges(challenge_id,account,challenge,created_at,expires_at) VALUES(?,?,?,?,?)").bind(challengeId, account, challenge, created.toISOString(), expires.toISOString())]);
  return { success: true, challengeId, challenge, salt: u?.password_salt || await fakePasswordSalt(env, account), iterations: PBKDF2_ITERATIONS };
}
__name(handleLoginChallenge, "handleLoginChallenge");
async function handleLogin(env, params, request) {
  const account = safeText(params.account), challengeId = safeText(params.challengeId), proof = safeText(params.proof);
  if (!account || !challengeId || !proof) return { success: false, error: "\u767B\u5165\u9801\u9762\u7248\u672C\u904E\u820A\uFF0C\u8ACB\u91CD\u65B0\u6574\u7406\u5F8C\u518D\u767B\u5165" };
  const now = nowIso(), challengeRow = await env.DB.prepare("SELECT challenge FROM login_challenges WHERE challenge_id=? AND account=? AND expires_at>? LIMIT 1").bind(challengeId, account, now).first();
  await env.DB.prepare("DELETE FROM login_challenges WHERE challenge_id=?").bind(challengeId).run();
  const u = await env.DB.prepare("SELECT id,account,password_hash,password_salt,display_name,role,access_role,is_active FROM users WHERE account=? LIMIT 1").bind(account).first();
  if (!challengeRow || !u || Number(u.is_active) !== 1) {
    await logSystemEvent(env.DB, "warning", "AUTH_FAILURE", "\u5E33\u865F\u6216\u5BC6\u78BC\u932F\u8AA4", { action: "login", context: { account } });
    return { success: false, error: "\u5E33\u865F\u6216\u5BC6\u78BC\u932F\u8AA4" };
  }
  const expected = await hmacSha256Hex(u.password_hash, challengeRow.challenge);
  if (!timingSafeEqualHex(proof, expected)) {
    await logSystemEvent(env.DB, "warning", "AUTH_FAILURE", "\u5E33\u865F\u6216\u5BC6\u78BC\u932F\u8AA4", { action: "login", context: { account } });
    return { success: false, error: "\u5E33\u865F\u6216\u5BC6\u78BC\u932F\u8AA4" };
  }
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32))), tokenHash = await sha256Hex(token);
  const minutes = Math.max(5, Number.parseInt(env.SESSION_MINUTES || "30", 10) || 30), created = /* @__PURE__ */ new Date(), expires = new Date(created.getTime() + minutes * 6e4);
  await env.DB.batch([env.DB.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(created.toISOString()), env.DB.prepare("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)").bind(tokenHash, u.id, created.toISOString(), expires.toISOString())]);
  const rateKey = await authRateKey(request, account);
  await env.DB.prepare("DELETE FROM auth_rate_limits WHERE rate_key=?").bind(rateKey).run();
  const role = roleOf(u);
  return { success: true, name: safeText(u.display_name) || account, role, roleLabel: ROLE_LABEL[role], capabilities: capabilitiesFor({ ...u, access_role: role }), token, expiresAt: expires.toISOString() };
}
__name(handleLogin, "handleLogin");
async function requireSession(request, env) {
  const auth = request.headers.get("Authorization") || "", m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, error: "\u767B\u5165\u5DF2\u5931\u6548\uFF0C\u8ACB\u91CD\u65B0\u767B\u5165" };
  const tokenHash = await sha256Hex(m[1]), now = nowIso();
  const u = await env.DB.prepare(`SELECT u.id,u.account,u.display_name,u.role,u.access_role,u.is_active,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? LIMIT 1`).bind(tokenHash, now).first();
  if (!u || Number(u.is_active) !== 1) return { ok: false, error: "\u767B\u5165\u5DF2\u903E\u6642\uFF0C\u8ACB\u91CD\u65B0\u767B\u5165" };
  return { ok: true, tokenHash, user: u };
}
__name(requireSession, "requireSession");
function requestIdFrom(params) {
  return safeText(params._requestId) || crypto.randomUUID();
}
__name(requestIdFrom, "requestIdFrom");
async function getRequestRecord(db, id) {
  return db.prepare("SELECT * FROM request_results WHERE request_id=?").bind(id).first();
}
__name(getRequestRecord, "getRequestRecord");
async function cachedRequestResponse(db, id) {
  const r = await getRequestRecord(db, id);
  if (!r) return null;
  if (r.response_json) {
    try {
      return JSON.parse(r.response_json);
    } catch {
    }
  }
  return { success: false, pending: true, status: 409, code: "RESULT_PENDING", error: "交易已受理，結果尚待確認；請保留原單號重新確認。" };
}
__name(cachedRequestResponse, "cachedRequestResponse");
function canonicalPayload(value) {
  if (Array.isArray(value)) return value.map(canonicalPayload);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalPayload(value[key])]));
  return value;
}
async function bindRequestIdentity(db, params, actor) {
  const id = requestIdFrom(params);
  const hash = await sha256Hex(JSON.stringify({role: roleOf(actor), payload: canonicalPayload(params)}));
  await db.prepare("INSERT OR IGNORE INTO request_identities(request_id,user_id,payload_hash,created_at) VALUES(?,?,?,?)").bind(id, actor.id, hash, nowIso()).run();
  const record = await db.prepare("SELECT user_id,payload_hash FROM request_identities WHERE request_id=?").bind(id).first();
  if (!record || Number(record.user_id) !== Number(actor.id) || record.payload_hash !== hash) throw withStatus("交易識別碼已被其他內容或使用者使用，請勿重複建單。", 409);
}
function requestClaimStatement(db, id, action, payload) {
  return db.prepare(`INSERT INTO request_results(request_id,action,payload_json,response_json,created_at,completed_at) VALUES(?,?,?,'',?,'')`).bind(id, action, JSON.stringify(payload || {}), nowIso());
}
__name(requestClaimStatement, "requestClaimStatement");
async function storeRequestResponse(db, id, result) {
  await db.prepare("UPDATE request_results SET response_json=?,completed_at=? WHERE request_id=?").bind(JSON.stringify(result), nowIso(), id).run();
}
__name(storeRequestResponse, "storeRequestResponse");
function isDuplicateRequestError(error) {
  return /UNIQUE constraint failed: request_results\.request_id/i.test(String(error?.message || error || ""));
}
__name(isDuplicateRequestError, "isDuplicateRequestError");
function changedRows(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0) || 0;
}
__name(changedRows, "changedRows");
function auditStatement(db, { action, entityType = "", entityId = "", actor, before = null, after = null, reason = "", requestId = "" }) {
  return db.prepare(`INSERT INTO audit_logs(created_at,action,entity_type,entity_id,user_id,user_name,user_role,before_json,after_json,reason,request_id,ip_hint,user_agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(nowIso(), action, entityType, String(entityId || ""), actor?.id || null, safeText(actor?.display_name), roleOf(actor), before ? JSON.stringify(before) : "", after ? JSON.stringify(after) : "", safeText(reason), safeText(requestId), safeText(actor?._ipHint), safeText(actor?._userAgent));
}
__name(auditStatement, "auditStatement");
async function logSystemEvent(db, severity, eventType, message, { requestId = "", action = "", actor = null, context = {} } = {}) {
  try {
    await db.prepare(`INSERT INTO system_logs(created_at,severity,event_type,message,request_id,action,user_id,user_name,context_json) VALUES(?,?,?,?,?,?,?,?,?)`).bind(nowIso(), severity, eventType, safeText(message).slice(0, 1e3), safeText(requestId), safeText(action), actor?.id || null, safeText(actor?.display_name), JSON.stringify(context || {}).slice(0, 4e3)).run();
  } catch {
  }
}
__name(logSystemEvent, "logSystemEvent");
async function handleClientLog(env, params, user) {
  const allowed = /* @__PURE__ */ new Set(["info", "warning", "error"]);
  const severity = allowed.has(safeText(params.severity)) ? safeText(params.severity) : "error";
  const eventType = safeText(params.eventType || "CLIENT_ERROR").slice(0, 80), message = safeText(params.message || "Client error").slice(0, 1e3), context = params.context && typeof params.context === "object" ? params.context : {};
  await logSystemEvent(env.DB, severity, eventType, message, { requestId: safeText(params._requestId), action: "clientLog", actor: user, context: { ...context, page: safeText(params.page).slice(0, 200) } });
  return { success: true };
}
__name(handleClientLog, "handleClientLog");
async function handleSingleMutation(env, params, user) {
  requireRole(user, "operator");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const type = safeText(params.type);
  if (!["\u5165\u5EAB", "\u9818\u7528", "\u76E4\u9EDE"].includes(type)) return { success: false, error: "\u4E0D\u652F\u63F4\u7684\u4F5C\u696D\u985E\u578B" };
  const id = safeText(params.id), lot = safeText(params.lot), expiry = normalizeExpiry(params.expiry), qty = safeQty(params.qty, { allowZero: type === "\u76E4\u9EDE" }), note = safeText(params.note), name = safeName(id, params.name), category = safeText(params.category), locationId = Number(params.locationId || params.location_id || 0), when = nowIso();
  if (!id) return { success: false, error: "\u7F3A\u5C11\u54C1\u9805 ID" };
  const location = await requireActiveLocation(env.DB, locationId);
  if (type === "\u5165\u5EAB") {
    const price = canViewCost(user) ? safePrice(params.price) : 0, minQty = canManageInventory(user) ? Math.max(0, Number.parseInt(params.minQty, 10) || 0) : 0;
    const oldItem = await env.DB.prepare("SELECT * FROM items WHERE item_id=?").bind(id).first();
    if (oldItem && Number(oldItem.is_active) !== 1) return { success: false, error: "\u6B64\u54C1\u9805\u5DF2\u505C\u7528\uFF0C\u8ACB\u7531\u5EAB\u5B58\u7BA1\u7406\u54E1\u5148\u91CD\u65B0\u555F\u7528", status: 409 };
    const inboundCategory = oldItem && !canManageInventory(user) ? safeText(oldItem.category) : category;
    const statements2 = [
      requestClaimStatement(env.DB, requestId, "inbound", { id, lot, expiry, qty, locationId }),
      env.DB.prepare(`INSERT INTO items(item_id,name,category,min_qty,target_qty,warning_days,lead_time_days,default_price,is_active,created_at,updated_at) VALUES(?,?,?,?,0,30,7,?,1,?,?) ON CONFLICT(item_id) DO UPDATE SET name=CASE WHEN items.name='' OR items.name=items.item_id THEN excluded.name ELSE items.name END,category=CASE WHEN excluded.category<>'' THEN excluded.category ELSE items.category END,default_price=CASE WHEN excluded.default_price>0 THEN excluded.default_price ELSE items.default_price END,updated_at=excluded.updated_at`).bind(id, name, inboundCategory, minQty, price, when, when),
      env.DB.prepare(`INSERT INTO inventory_batches(item_id,lot,expiry,note,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(item_id,lot,expiry) DO UPDATE SET note=CASE WHEN excluded.note<>'' THEN excluded.note ELSE inventory_batches.note END,updated_at=excluded.updated_at`).bind(id, lot, expiry, note, when, when),
      env.DB.prepare(`INSERT INTO stock_balances(batch_id,location_id,qty,last_stocktake,note,created_at,updated_at) SELECT batch_id,?,?,'',?,?,? FROM inventory_batches WHERE item_id=? AND lot=? AND expiry=? ON CONFLICT(batch_id,location_id) DO UPDATE SET qty=stock_balances.qty+excluded.qty,note=CASE WHEN excluded.note<>'' THEN excluded.note ELSE stock_balances.note END,updated_at=excluded.updated_at`).bind(locationId, qty, note, when, when, id, lot, expiry),
      env.DB.prepare(`INSERT OR IGNORE INTO stocktake_lines(session_id,batch_id,location_id,item_id,lot,expiry,system_qty,status) SELECT ss.session_id,b.batch_id,?,b.item_id,b.lot,b.expiry,s.qty,'pending' FROM stocktake_sessions ss JOIN inventory_batches b ON b.item_id=? AND b.lot=? AND b.expiry=? JOIN stock_balances s ON s.batch_id=b.batch_id AND s.location_id=? JOIN items i ON i.item_id=b.item_id WHERE ss.status='open' AND ss.location_id=? AND i.is_active=1`).bind(locationId, id, lot, expiry, locationId, locationId),
      env.DB.prepare(`INSERT INTO transactions(request_id,created_at,type,item_id,name,batch_id,lot,expiry,qty,price,balance_before,balance_after,location_id,location_name,user_id,user_name,note,reason,reference_type,reference_id,document_no) SELECT ?,?,'\u5165\u5EAB',i.item_id,i.name,b.batch_id,b.lot,b.expiry,?,i.default_price,s.qty-?,s.qty,l.location_id,l.name,?,?,?,?,'inbound',?,? FROM items i JOIN inventory_batches b ON b.item_id=i.item_id JOIN stock_balances s ON s.batch_id=b.batch_id JOIN locations l ON l.location_id=s.location_id WHERE i.item_id=? AND b.lot=? AND b.expiry=? AND l.location_id=?`).bind(requestId, when, qty, qty, user.id, safeText(user.display_name), note, "", requestId, documentNo("IN", requestId), id, lot, expiry, locationId),
      auditStatement(env.DB, { action: "INBOUND", entityType: "item", entityId: id, actor: user, before: oldItem, after: { id, lot, expiry, qty, locationId: location.name }, reason: note, requestId })
    ];
    try {
      await env.DB.batch(statements2);
    } catch (e) {
      if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
      throw e;
    }
    const updated2 = await getBalanceByKey(env.DB, id, lot, expiry, locationId), result2 = { success: true, message: "\u5165\u5EAB\u5B8C\u6210", updatedItem: rowToItem(updated2, user) };
    await storeRequestResponse(env.DB, requestId, result2);
    return result2;
  }
  const existing = await getBalanceByKey(env.DB, id, lot, expiry, locationId);
  if (!existing) return { success: false, error: "\u627E\u4E0D\u5230\u6307\u5B9A\u7684\u5EAB\u5B58\u6279\u6B21\uFF0F\u5132\u4F4D\uFF0C\u8ACB\u5148\u540C\u6B65\u5F8C\u518D\u8A66" };
  if (type === "\u76E4\u9EDE") {
    const before = Number(existing.qty), diff = qty - before, reason = safeText(params.reason) || "\u5FEB\u901F\u76E4\u9EDE";
    if (diff !== 0 && !safeText(params.reason)) return { success: false, error: "\u76E4\u9EDE\u6578\u91CF\u6709\u5DEE\u7570\uFF0C\u8ACB\u9078\u64C7\u5DEE\u7570\u539F\u56E0" };
    const statements2 = [requestClaimStatement(env.DB, requestId, "stocktake", { id, lot, expiry, qty, locationId }), env.DB.prepare("UPDATE stock_balances SET qty=CASE WHEN qty=? THEN ? ELSE -1 END,last_stocktake=?,updated_at=? WHERE batch_id=? AND location_id=?").bind(before, qty, when, when, existing.batch_id, locationId), env.DB.prepare(`INSERT INTO transactions(request_id,created_at,type,item_id,name,batch_id,lot,expiry,qty,price,balance_before,balance_after,location_id,location_name,user_id,user_name,note,reason,reference_type,reference_id,document_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(requestId, when, "\u76E4\u9EDE", id, safeName(id, existing.name), existing.batch_id, lot, expiry, qty, Number(existing.price) || 0, before, qty, locationId, location.name, user.id, safeText(user.display_name), note, reason, "quick_stocktake", requestId, documentNo("ST", requestId)), auditStatement(env.DB, { action: "QUICK_STOCKTAKE", entityType: "balance", entityId: `${existing.batch_id}:${locationId}`, actor: user, before: { qty: before }, after: { qty }, reason, requestId })];
    if (diff !== 0) statements2.push(env.DB.prepare(`INSERT INTO stock_adjustments(session_id,batch_id,location_id,item_id,system_qty,counted_qty,difference,reason,note,user_id,user_name,created_at) VALUES('',?,?,?,?,?,?,?,?,?,?,?)`).bind(existing.batch_id, locationId, id, before, qty, diff, reason, note, user.id, safeText(user.display_name), when));
    try {
      await env.DB.batch(statements2);
    } catch (e) {
      if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
      if (/CHECK constraint/i.test(String(e))) return { success: false, error: "\u76E4\u9EDE\u524D\u8CC7\u6599\u5DF2\u88AB\u5176\u4ED6\u4EBA\u7570\u52D5\uFF0C\u8ACB\u540C\u6B65\u5F8C\u91CD\u8A66", status: 409 };
      throw e;
    }
    const updated2 = await getBalanceByBatchLocation(env.DB, existing.batch_id, locationId), result2 = { success: true, message: diff === 0 ? "\u76E4\u9EDE\u4E00\u81F4" : "\u76E4\u9EDE\u5DEE\u7570\u5DF2\u8A18\u9304", updatedItem: rowToItem(updated2, user), difference: diff };
    await storeRequestResponse(env.DB, requestId, result2);
    return result2;
  }
  if (isExpired(existing.expiry)) return { success: false, error: `\u6B64\u6279\u6B21\u5DF2\u904E\u671F\uFF08${existing.expiry}\uFF09\uFF0C\u4E0D\u53EF\u4E00\u822C\u9818\u7528\uFF1B\u8ACB\u4F7F\u7528\u5831\u5EE2\uFF0F\u9000\u8CA8\u6D41\u7A0B`, status: 409 };
  if (Number(existing.qty) < qty) return { success: false, error: `\u5EAB\u5B58\u4E0D\u8DB3\uFF1A\u76EE\u524D\u6B64\u5132\u4F4D\u6279\u6B21\u50C5 ${existing.qty} \u4EF6`, status: 409 };
  const statements = [requestClaimStatement(env.DB, requestId, "outbound", { id, lot, expiry, qty, locationId }), env.DB.prepare("UPDATE stock_balances SET qty=CASE WHEN qty=? THEN qty-? ELSE -1 END,updated_at=? WHERE batch_id=? AND location_id=?").bind(Number(existing.qty), qty, when, existing.batch_id, locationId), env.DB.prepare(`INSERT INTO transactions(request_id,created_at,type,item_id,name,batch_id,lot,expiry,qty,price,balance_before,balance_after,location_id,location_name,user_id,user_name,note,reason,reference_type,reference_id,document_no) SELECT ?,?,'\u9818\u7528',i.item_id,i.name,b.batch_id,b.lot,b.expiry,?,i.default_price,s.qty+?,s.qty,l.location_id,l.name,?,?,?,'','outbound',?,? FROM items i JOIN inventory_batches b ON b.item_id=i.item_id JOIN stock_balances s ON s.batch_id=b.batch_id JOIN locations l ON l.location_id=s.location_id WHERE b.batch_id=? AND l.location_id=?`).bind(requestId, when, qty, qty, user.id, safeText(user.display_name), note, requestId, documentNo("OUT", requestId), existing.batch_id, locationId), auditStatement(env.DB, { action: "OUTBOUND", entityType: "balance", entityId: `${existing.batch_id}:${locationId}`, actor: user, before: { qty: Number(existing.qty) }, after: { qty: Number(existing.qty) - qty }, reason: note, requestId })];
  try {
    await env.DB.batch(statements);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    if (/CHECK constraint/i.test(String(e))) {
      await logSystemEvent(env.DB, "warning", "INVENTORY_CONFLICT", "\u9818\u7528\u6642\u5EAB\u5B58\u885D\u7A81", { requestId, action: "outbound", actor: user, context: { id, locationId } });
      return { success: false, error: "\u5EAB\u5B58\u4E0D\u8DB3\u6216\u540C\u6642\u6709\u5176\u4ED6\u4EBA\u7570\u52D5\uFF0C\u8ACB\u540C\u6B65\u5F8C\u518D\u8A66", status: 409 };
    }
    throw e;
  }
  const updated = await getBalanceByBatchLocation(env.DB, existing.batch_id, locationId), result = { success: true, message: "\u9818\u7528\u5B8C\u6210", updatedItem: rowToItem(updated, user) };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(handleSingleMutation, "handleSingleMutation");
async function handleFefoIssue(env, params, user) {
  requireRole(user, "operator");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const id = safeText(params.id), qty = safeQty(params.qty, { allowZero: false }), note = safeText(params.note), locationId = Number(params.locationId || 0), when = nowIso();
  if (!id) return { success: false, error: "\u7F3A\u5C11\u54C1\u9805 ID" };
  const location = await requireActiveLocation(env.DB, locationId), today = taipeiDateOnly();
  const r = await env.DB.prepare(`SELECT b.batch_id,b.item_id,b.lot,b.expiry,s.qty,i.name,i.default_price FROM inventory_batches b JOIN items i ON i.item_id=b.item_id JOIN stock_balances s ON s.batch_id=b.batch_id WHERE b.item_id=? AND s.location_id=? AND s.qty>0 AND i.is_active=1 AND (b.expiry='' OR b.expiry>=?) ORDER BY CASE WHEN b.expiry='' THEN 1 ELSE 0 END,b.expiry,b.lot,b.batch_id`).bind(id, locationId, today).all();
  const batches = r.results || [];
  const total = batches.reduce((s, b) => s + Number(b.qty || 0), 0);
  if (total < qty) {
    const expired = await env.DB.prepare(`SELECT COALESCE(SUM(s.qty),0) q FROM inventory_batches b JOIN stock_balances s ON s.batch_id=b.batch_id WHERE b.item_id=? AND s.location_id=? AND s.qty>0 AND b.expiry<>'' AND b.expiry<?`).bind(id, locationId, today).first();
    const suffix = Number(expired?.q) > 0 ? `\uFF1B\u53E6\u6709 ${expired.q} \u4EF6\u5DF2\u904E\u671F\uFF0C\u4E0D\u53EF\u4E00\u822C\u9818\u7528` : "";
    return { success: false, error: `\u53EF\u9818\u7528\u5EAB\u5B58\u4E0D\u8DB3\uFF1A\u76EE\u524D ${total} \u4EF6\uFF0C\u9700\u8981 ${qty} \u4EF6${suffix}`, status: 409 };
  }
  let remaining = qty;
  const allocations = [];
  for (const b of batches) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(b.qty));
    if (take > 0) {
      allocations.push({ ...b, take });
      remaining -= take;
    }
  }
  const statements = [requestClaimStatement(env.DB, requestId, "fefoIssue", { id, qty, locationId })];
  for (const a of allocations) {
    statements.push(env.DB.prepare(`UPDATE stock_balances SET qty=CASE WHEN qty=? AND batch_id=(SELECT b2.batch_id FROM inventory_batches b2 JOIN items i2 ON i2.item_id=b2.item_id JOIN stock_balances s2 ON s2.batch_id=b2.batch_id WHERE b2.item_id=? AND s2.location_id=? AND s2.qty>0 AND i2.is_active=1 AND (b2.expiry='' OR b2.expiry>=?) ORDER BY CASE WHEN b2.expiry='' THEN 1 ELSE 0 END,b2.expiry,b2.lot,b2.batch_id LIMIT 1) THEN qty-? ELSE -1 END,updated_at=? WHERE batch_id=? AND location_id=?`).bind(Number(a.qty), id, locationId, today, a.take, when, a.batch_id, locationId));
    statements.push(env.DB.prepare(`INSERT INTO transactions(request_id,created_at,type,item_id,name,batch_id,lot,expiry,qty,price,balance_before,balance_after,location_id,location_name,user_id,user_name,note,reason,reference_type,reference_id,document_no) SELECT ?,?,'\u9818\u7528',i.item_id,i.name,b.batch_id,b.lot,b.expiry,?,i.default_price,s.qty+?,s.qty,l.location_id,l.name,?,?,?,'FEFO','FEFO',?,? FROM items i JOIN inventory_batches b ON b.item_id=i.item_id JOIN stock_balances s ON s.batch_id=b.batch_id JOIN locations l ON l.location_id=s.location_id WHERE b.batch_id=? AND l.location_id=?`).bind(requestId, when, a.take, a.take, user.id, safeText(user.display_name), note, requestId, documentNo("OUT", requestId), a.batch_id, locationId));
  }
  statements.push(auditStatement(env.DB, { action: "FEFO_OUTBOUND", entityType: "item", entityId: id, actor: user, before: { total }, after: { total: total - qty }, reason: note, requestId }));
  try {
    await env.DB.batch(statements);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    if (/CHECK constraint/i.test(String(e))) {
      await logSystemEvent(env.DB, "warning", "FEFO_CONFLICT", "FEFO \u6263\u5E33\u885D\u7A81", { requestId, action: "fefoIssue", actor: user, context: { id, locationId } });
      return { success: false, error: "\u5EAB\u5B58\u525B\u88AB\u5176\u4ED6\u4F7F\u7528\u8005\u7570\u52D5\uFF0CFEFO \u6263\u5E33\u5DF2\u6574\u6279\u53D6\u6D88\uFF0C\u8ACB\u540C\u6B65\u5F8C\u91CD\u8A66", status: 409 };
    }
    throw e;
  }
  const updatedItems = await getRowsByBatchLocationPairs(env.DB, allocations.map((a) => ({ batch_id: a.batch_id, location_id: locationId })), user);
  const result = { success: true, message: `FEFO \u9818\u7528\u5B8C\u6210\uFF0C\u5171\u4F7F\u7528 ${allocations.length} \u500B\u6279\u6B21`, updatedItems, allocations: allocations.map((a) => ({ batch_id: a.batch_id, lot: a.lot, expiry: a.expiry, qty: a.take, location_id: locationId, location_name: location.name })) };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(handleFefoIssue, "handleFefoIssue");
async function handleBatchQuickScan(env, params, user) {
  requireRole(user, "operator");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const mode = safeText(params.mode);
  if (!["inbound", "outbound"].includes(mode)) return { success: false, error: "\u5FEB\u901F\u4F5C\u696D\u985E\u578B\u932F\u8AA4" };
  const raws = Array.isArray(params.items) ? params.items : [];
  if (!raws.length || raws.length > 500) return { success: false, error: "\u5FEB\u901F\u4F5C\u696D\u9805\u76EE\u9808\u70BA 1 \u81F3 500 \u7B46" };
  const grouped = /* @__PURE__ */ new Map();
  for (const raw of raws) {
    const id = safeText(raw.id), batchId = Number(raw.batchId || raw.batch_id || 0), locationId = Number(raw.locationId || raw.location_id || 0), qty = safeQty(raw.qty, { allowZero: false });
    if (!id || !locationId || mode === "inbound" && !batchId) return { success: false, error: "\u5FEB\u901F\u4F5C\u696D\u8CC7\u6599\u4E0D\u5B8C\u6574" };
    const key = mode === "inbound" ? `${batchId}:${locationId}` : `${id}:${locationId}`, current = grouped.get(key) || { id, batchId, locationId, qty: 0 };
    current.qty += qty;
    grouped.set(key, current);
  }
  const when = nowIso(), statements = [requestClaimStatement(env.DB, requestId, "batchQuickScan", { mode, count: raws.length })], updatedPairs = [];
  if (mode === "inbound") {
    for (const x of grouped.values()) {
      const location = await requireActiveLocation(env.DB, x.locationId), batch = await env.DB.prepare(`SELECT b.batch_id,b.item_id,b.lot,b.expiry,b.note,i.name,i.default_price,i.is_active FROM inventory_batches b JOIN items i ON i.item_id=b.item_id WHERE b.batch_id=? LIMIT 1`).bind(x.batchId).first();
      if (!batch || safeText(batch.item_id) !== x.id || Number(batch.is_active) !== 1) return { success: false, error: `\u627E\u4E0D\u5230\u53EF\u5165\u5EAB\u54C1\u9805\uFF1A${x.id}` };
      const beforeRow = await getBalanceByBatchLocation(env.DB, x.batchId, x.locationId), before = Number(beforeRow?.qty || 0), note = safeText(beforeRow?.balance_note) || safeText(batch.note);
      statements.push(env.DB.prepare(`INSERT INTO stock_balances(batch_id,location_id,qty,last_stocktake,note,created_at,updated_at) VALUES(?,?,?,'',?,?,?) ON CONFLICT(batch_id,location_id) DO UPDATE SET qty=CASE WHEN stock_balances.qty=? THEN stock_balances.qty+excluded.qty ELSE -1 END,updated_at=excluded.updated_at`).bind(x.batchId, x.locationId, x.qty, note, when, when, before));
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO stocktake_lines(session_id,batch_id,location_id,item_id,lot,expiry,system_qty,status) SELECT ss.session_id,b.batch_id,?,b.item_id,b.lot,b.expiry,s.qty,'pending' FROM stocktake_sessions ss JOIN inventory_batches b ON b.batch_id=? JOIN stock_balances s ON s.batch_id=b.batch_id AND s.location_id=? JOIN items i ON i.item_id=b.item_id WHERE ss.status='open' AND ss.location_id=? AND i.is_active=1`).bind(x.locationId, x.batchId, x.locationId, x.locationId));
      statements.push(env.DB.prepare(`INSERT INTO transactions(request_id,created_at,type,item_id,name,batch_id,lot,expiry,qty,price,balance_before,balance_after,location_id,location_name,user_id,user_name,note,reason,reference_type,reference_id,document_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(requestId, when, "\u5165\u5EAB", x.id, safeName(x.id, batch.name), x.batchId, safeText(batch.lot), safeText(batch.expiry), x.qty, Number(batch.default_price) || 0, before, before + x.qty, x.locationId, location.name, user.id, safeText(user.display_name), note, "\u6574\u6279\u5FEB\u901F\u5165\u5EAB", "batch_quick_scan", requestId, documentNo("IN", requestId)));
      statements.push(auditStatement(env.DB, { action: "BATCH_QUICK_INBOUND", entityType: "balance", entityId: `${x.batchId}:${x.locationId}`, actor: user, before: { qty: before }, after: { qty: before + x.qty }, reason: "\u5B8C\u6210\u672C\u6B21\u5FEB\u901F\u5165\u5EAB\u5F8C\u78BA\u8A8D", requestId }));
      updatedPairs.push({ batch_id: x.batchId, location_id: x.locationId });
    }
  } else {
    const today = taipeiDateOnly();
    for (const x of grouped.values()) {
      const location = await requireActiveLocation(env.DB, x.locationId), r = await env.DB.prepare(`SELECT b.batch_id,b.item_id,b.lot,b.expiry,s.qty,i.name,i.default_price FROM inventory_batches b JOIN items i ON i.item_id=b.item_id JOIN stock_balances s ON s.batch_id=b.batch_id WHERE b.item_id=? AND s.location_id=? AND s.qty>0 AND i.is_active=1 AND (b.expiry='' OR b.expiry>=?) ORDER BY CASE WHEN b.expiry='' THEN 1 ELSE 0 END,b.expiry,b.lot,b.batch_id`).bind(x.id, x.locationId, today).all(), batches = r.results || [], total2 = batches.reduce((sum, b) => sum + Number(b.qty || 0), 0);
      if (total2 < x.qty) return { success: false, error: `${safeName(x.id, batches[0]?.name)} \u53EF\u51FA\u5EAB\u5EAB\u5B58\u4E0D\u8DB3\uFF1A\u76EE\u524D ${total2} \u4EF6\uFF0C\u9700\u8981 ${x.qty} \u4EF6`, status: 409 };
      let remaining = x.qty;
      for (const b of batches) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, Number(b.qty));
        if (!take) continue;
        statements.push(env.DB.prepare(`UPDATE stock_balances SET qty=CASE WHEN qty=? AND batch_id=(SELECT b2.batch_id FROM inventory_batches b2 JOIN items i2 ON i2.item_id=b2.item_id JOIN stock_balances s2 ON s2.batch_id=b2.batch_id WHERE b2.item_id=? AND s2.location_id=? AND s2.qty>0 AND i2.is_active=1 AND (b2.expiry='' OR b2.expiry>=?) ORDER BY CASE WHEN b2.expiry='' THEN 1 ELSE 0 END,b2.expiry,b2.lot,b2.batch_id LIMIT 1) THEN qty-? ELSE -1 END,updated_at=? WHERE batch_id=? AND location_id=?`).bind(Number(b.qty), x.id, x.locationId, today, take, when, b.batch_id, x.locationId));
        statements.push(env.DB.prepare(`INSERT INTO transactions(request_id,created_at,type,item_id,name,batch_id,lot,expiry,qty,price,balance_before,balance_after,location_id,location_name,user_id,user_name,note,reason,reference_type,reference_id,document_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(requestId, when, "\u9818\u7528", x.id, safeName(x.id, b.name), b.batch_id, safeText(b.lot), safeText(b.expiry), take, Number(b.default_price) || 0, Number(b.qty), Number(b.qty) - take, x.locationId, location.name, user.id, safeText(user.display_name), "[\u9023\u7E8C\u6383\u78BC\u51FA\u5EAB]", "FEFO \u6574\u6279\u78BA\u8A8D", "batch_quick_scan", requestId, documentNo("OUT", requestId)));
        updatedPairs.push({ batch_id: b.batch_id, location_id: x.locationId });
        remaining -= take;
      }
      statements.push(auditStatement(env.DB, { action: "BATCH_QUICK_OUTBOUND", entityType: "item", entityId: x.id, actor: user, before: { total: total2 }, after: { total: total2 - x.qty }, reason: "\u5B8C\u6210\u672C\u6B21\u5FEB\u901F\u51FA\u5EAB\u5F8C\u78BA\u8A8D", requestId }));
    }
  }
  try {
    await env.DB.batch(statements);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    if (/CHECK constraint/i.test(String(e))) return { success: false, error: "\u78BA\u8A8D\u524D\u5EAB\u5B58\u5DF2\u88AB\u5176\u4ED6\u4F7F\u7528\u8005\u7570\u52D5\uFF0C\u672C\u6B21\u6574\u6279\u4F5C\u696D\u672A\u5BEB\u5165\uFF0C\u8ACB\u540C\u6B65\u5F8C\u91CD\u8A66", status: 409 };
    throw e;
  }
  const updatedItems = await getRowsByBatchLocationPairs(env.DB, updatedPairs, user), total = [...grouped.values()].reduce((sum, x) => sum + x.qty, 0), result = { success: true, message: `\u672C\u6B21\u5FEB\u901F${mode === "inbound" ? "\u5165\u5EAB" : "\u51FA\u5EAB"}\u5DF2\u78BA\u8A8D\uFF0C\u5171 ${total} \u4EF6`, updatedItems, total };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(handleBatchQuickScan, "handleBatchQuickScan");
async function handleInventoryMovement(env, params, user) {
  requireRole(user, "inventory_manager");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const movementType = safeText(params.movementType);
  if (!MOVEMENT_TYPES.has(movementType)) return { success: false, error: "\u4E0D\u652F\u63F4\u7684\u5EAB\u5B58\u7570\u52D5\u985E\u578B" };
  const batchId = Number(params.batch_id), locationId = Number(params.locationId || 0), reason = safeText(params.reason), note = safeText(params.note), when = nowIso();
  if (!reason) return { success: false, error: "\u8ACB\u586B\u5BEB\u7570\u52D5\u539F\u56E0" };
  const row = await getBalanceByBatchLocation(env.DB, batchId, locationId);
  if (!row) return { success: false, error: "\u627E\u4E0D\u5230\u6307\u5B9A\u6279\u6B21\uFF0F\u5132\u4F4D" };
  const docPrefix = movementType === "\u5831\u5EE2" ? "DSP" : movementType === "\u9000\u8CA8" ? "RET" : movementType === "\u8ABF\u64A5" ? "TRF" : "ADJ";
  const docNo = documentNo(docPrefix, requestId);
  if (movementType === "\u5EAB\u5B58\u8ABF\u6574") {
    const newQty = safeQty(params.newQty), before = Number(row.qty), diff = newQty - before;
    if (diff === 0) return { success: false, error: "\u8ABF\u6574\u5F8C\u6578\u91CF\u8207\u76EE\u524D\u5EAB\u5B58\u76F8\u540C" };
    const statements2 = [requestClaimStatement(env.DB, requestId, "inventoryAdjustment", { batchId, locationId, newQty }), env.DB.prepare("UPDATE stock_balances SET qty=CASE WHEN qty=? THEN ? ELSE -1 END,updated_at=? WHERE batch_id=? AND location_id=?").bind(before, newQty, when, batchId, locationId), env.DB.prepare(`INSERT INTO transactions(request_id,created_at,type,item_id,name,batch_id,lot,expiry,qty,price,balance_before,balance_after,location_id,location_name,user_id,user_name,note,reason,reference_type,reference_id,document_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(requestId, when, "\u5EAB\u5B58\u8ABF\u6574", row.item_id, safeName(row.item_id, row.name), batchId, row.lot, row.expiry, Math.abs(diff), Number(row.price) || 0, before, newQty, locationId, row.location_name, user.id, safeText(user.display_name), note, reason, "adjustment", requestId, docNo), auditStatement(env.DB, { action: "INVENTORY_ADJUSTMENT", entityType: "balance", entityId: `${batchId}:${locationId}`, actor: user, before: { qty: before }, after: { qty: newQty }, reason: `${reason}${note ? `\uFF5C${note}` : ""}`, requestId })];
    try {
      await env.DB.batch(statements2);
    } catch (e) {
      if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
      if (/CHECK constraint/i.test(String(e))) return { success: false, error: "\u5EAB\u5B58\u5DF2\u88AB\u5176\u4ED6\u4F7F\u7528\u8005\u7570\u52D5\uFF0C\u8ABF\u6574\u672A\u5BEB\u5165", status: 409 };
      throw e;
    }
    const updated2 = await getBalanceByBatchLocation(env.DB, batchId, locationId), result2 = { success: true, message: `\u5EAB\u5B58\u8ABF\u6574\u5B8C\u6210\uFF08${before} \u2192 ${newQty}\uFF09`, documentNo: docNo, updatedItem: rowToItem(updated2, user) };
    await storeRequestResponse(env.DB, requestId, result2);
    return result2;
  }
  if (movementType === "\u8ABF\u64A5") {
    const targetLocationId = Number(params.targetLocationId || 0), qty2 = safeQty(params.qty, { allowZero: false });
    if (targetLocationId === locationId) return { success: false, error: "\u4F86\u6E90\u8207\u76EE\u7684\u5132\u4F4D\u4E0D\u53EF\u76F8\u540C" };
    const target = await requireActiveLocation(env.DB, targetLocationId);
    if (Number(row.qty) < qty2) return { success: false, error: `\u4F86\u6E90\u5132\u4F4D\u5EAB\u5B58\u4E0D\u8DB3\uFF1A\u76EE\u524D ${row.qty} \u4EF6`, status: 409 };
    const targetExisting = await getBalanceByBatchLocation(env.DB, batchId, targetLocationId);
    const targetBefore = Number(targetExisting?.qty || 0);
    const statements2 = [requestClaimStatement(env.DB, requestId, "transfer", { batchId, locationId, targetLocationId, qty: qty2 }), env.DB.prepare("UPDATE stock_balances SET qty=CASE WHEN qty=? THEN qty-? ELSE -1 END,updated_at=? WHERE batch_id=? AND location_id=?").bind(Number(row.qty), qty2, when, batchId, locationId), env.DB.prepare(`INSERT INTO stock_balances(batch_id,location_id,qty,last_stocktake,note,created_at,updated_at) VALUES(?,?,?,'','',?,?) ON CONFLICT(batch_id,location_id) DO UPDATE SET qty=CASE WHEN stock_balances.qty=? THEN stock_balances.qty+excluded.qty ELSE -1 END,updated_at=excluded.updated_at`).bind(batchId, targetLocationId, qty2, when, when, targetBefore), env.DB.prepare(`INSERT OR IGNORE INTO stocktake_lines(session_id,batch_id,location_id,item_id,lot,expiry,system_qty,status) SELECT ss.session_id,b.batch_id,?,b.item_id,b.lot,b.expiry,s.qty,'pending' FROM stocktake_sessions ss JOIN inventory_batches b ON b.batch_id=? JOIN stock_balances s ON s.batch_id=b.batch_id AND s.location_id=? JOIN items i ON i.item_id=b.item_id WHERE ss.status='open' AND ss.location_id=? AND i.is_active=1`).bind(targetLocationId, batchId, targetLocationId, targetLocationId), env.DB.prepare(`INSERT INTO transactions(request_id,created_at,type,item_id,name,batch_id,lot,expiry,qty,price,balance_before,balance_after,location_id,location_name,source_location_id,target_location_id,user_id,user_name,note,reason,reference_type,reference_id,document_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(requestId, when, "\u8ABF\u64A5", row.item_id, safeName(row.item_id, row.name), batchId, row.lot, row.expiry, qty2, Number(row.price) || 0, Number(row.qty), Number(row.qty) - qty2, locationId, row.location_name, locationId, targetLocationId, user.id, safeText(user.display_name), note, reason, "transfer", requestId, docNo), auditStatement(env.DB, { action: "TRANSFER", entityType: "batch", entityId: batchId, actor: user, before: { source: row.location_name, sourceQty: Number(row.qty), target: target.name, targetQty: targetBefore }, after: { sourceQty: Number(row.qty) - qty2, targetQty: targetBefore + qty2 }, reason, requestId })];
    try {
      await env.DB.batch(statements2);
    } catch (e) {
      if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
      if (/CHECK constraint/i.test(String(e))) return { success: false, error: "\u8ABF\u64A5\u6642\u4F86\u6E90\u5EAB\u5B58\u5DF2\u88AB\u7570\u52D5\uFF0C\u6574\u7B46\u8ABF\u64A5\u5DF2\u53D6\u6D88", status: 409 };
      throw e;
    }
    const updatedItems = await getRowsByBatchLocationPairs(env.DB, [{ batch_id: batchId, location_id: locationId }, { batch_id: batchId, location_id: targetLocationId }], user);
    const result2 = { success: true, message: `\u8ABF\u64A5\u5B8C\u6210\uFF1A${row.location_name} \u2192 ${target.name}\uFF0C${qty2} \u4EF6`, documentNo: docNo, updatedItems };
    await storeRequestResponse(env.DB, requestId, result2);
    return result2;
  }
  const qty = safeQty(params.qty, { allowZero: false });
  if (Number(row.qty) < qty) return { success: false, error: `\u5EAB\u5B58\u4E0D\u8DB3\uFF1A\u76EE\u524D ${row.qty} \u4EF6`, status: 409 };
  const statements = [requestClaimStatement(env.DB, requestId, movementType, { batchId, locationId, qty }), env.DB.prepare("UPDATE stock_balances SET qty=CASE WHEN qty=? THEN qty-? ELSE -1 END,updated_at=? WHERE batch_id=? AND location_id=?").bind(Number(row.qty), qty, when, batchId, locationId), env.DB.prepare(`INSERT INTO transactions(request_id,created_at,type,item_id,name,batch_id,lot,expiry,qty,price,balance_before,balance_after,location_id,location_name,user_id,user_name,note,reason,reference_type,reference_id,document_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(requestId, when, movementType, row.item_id, safeName(row.item_id, row.name), batchId, row.lot, row.expiry, qty, Number(row.price) || 0, Number(row.qty), Number(row.qty) - qty, locationId, row.location_name, user.id, safeText(user.display_name), note, reason, movementType === "\u5831\u5EE2" ? "disposal" : "supplier_return", requestId, docNo), auditStatement(env.DB, { action: movementType === "\u5831\u5EE2" ? "DISPOSAL" : "SUPPLIER_RETURN", entityType: "balance", entityId: `${batchId}:${locationId}`, actor: user, before: { qty: Number(row.qty) }, after: { qty: Number(row.qty) - qty }, reason: `${reason}${note ? `\uFF5C${note}` : ""}`, requestId })];
  try {
    await env.DB.batch(statements);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    if (/CHECK constraint/i.test(String(e))) return { success: false, error: "\u5EAB\u5B58\u5DF2\u88AB\u5176\u4ED6\u4F7F\u7528\u8005\u7570\u52D5\uFF0C\u672C\u6B21\u4F5C\u696D\u5DF2\u53D6\u6D88", status: 409 };
    throw e;
  }
  const updated = await getBalanceByBatchLocation(env.DB, batchId, locationId), result = { success: true, message: `${movementType}\u5B8C\u6210`, documentNo: docNo, updatedItem: rowToItem(updated, user) };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(handleInventoryMovement, "handleInventoryMovement");
async function handleThresholdUpdate(env, params, user) {
  requireRole(user, "inventory_manager");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const id = safeText(params.id), minQty = Math.max(0, Number.parseInt(params.minQty, 10) || 0), when = nowIso();
  const item = await env.DB.prepare("SELECT * FROM items WHERE item_id=?").bind(id).first();
  if (!item) return { success: false, error: "\u627E\u4E0D\u5230\u8A72\u54C1\u9805 ID" };
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "updateThreshold", { id, minQty }), env.DB.prepare("UPDATE items SET min_qty=?,updated_at=? WHERE item_id=?").bind(minQty, when, id), auditStatement(env.DB, { action: "UPDATE_THRESHOLD", entityType: "item", entityId: id, actor: user, before: { min_qty: Number(item.min_qty) || 0 }, after: { min_qty: minQty }, reason: "\u5B89\u5168\u5EAB\u5B58\u9580\u6ABB\u4FEE\u6539", requestId })]);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    throw e;
  }
  const updatedItems = await getRowsByItemId(env.DB, id, user), result = { success: true, message: "\u9580\u6ABB\u66F4\u65B0\u6210\u529F", updatedItems };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(handleThresholdUpdate, "handleThresholdUpdate");
async function handleLegacyBatchStocktake(env, params, user) {
  requireRole(user, "operator");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const raws = Array.isArray(params.items) ? params.items : [];
  if (!raws.length) return { success: false, error: "\u6C92\u6709\u53EF\u76E4\u9EDE\u9805\u76EE" };
  const when = nowIso(), rows = [];
  for (const x of raws) {
    const locationId = Number(x.location_id || x.locationId || 0);
    let row;
    if (Number(x.batch_id)) row = await getBalanceByBatchLocation(env.DB, Number(x.batch_id), locationId);
    else row = await getBalanceByKey(env.DB, safeText(x.id), safeText(x.lot), normalizeExpiry(x.expiry), locationId);
    if (!row) return { success: false, error: `\u627E\u4E0D\u5230\u76E4\u9EDE\u6279\u6B21\uFF0F\u5132\u4F4D\uFF1A${safeText(x.id)}` };
    const counted = safeQty(x.qty), reason = safeText(x.reason) || "\u5FEB\u901F\u6279\u6B21\u76E4\u9EDE";
    if (counted !== Number(row.qty) && !safeText(x.reason)) return { success: false, error: `${safeName(row.item_id, row.name)} \u6709\u76E4\u9EDE\u5DEE\u7570\uFF0C\u8ACB\u586B\u5BEB\u539F\u56E0` };
    rows.push({ row, counted, note: safeText(x.note), reason });
  }
  const statements = [requestClaimStatement(env.DB, requestId, "batchStocktake", { count: rows.length })];
  for (const x of rows) {
    const current = Number(x.row.qty), diff = x.counted - current;
    statements.push(env.DB.prepare("UPDATE stock_balances SET qty=CASE WHEN qty=? THEN ? ELSE -1 END,last_stocktake=?,updated_at=? WHERE batch_id=? AND location_id=?").bind(current, x.counted, when, when, x.row.batch_id, x.row.location_id));
    statements.push(env.DB.prepare(`INSERT INTO transactions(request_id,created_at,type,item_id,name,batch_id,lot,expiry,qty,price,balance_before,balance_after,location_id,location_name,user_id,user_name,note,reason,reference_type,reference_id,document_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(requestId, when, "\u76E4\u9EDE", x.row.item_id, safeName(x.row.item_id, x.row.name), x.row.batch_id, x.row.lot, x.row.expiry, x.counted, Number(x.row.price) || 0, current, x.counted, x.row.location_id, x.row.location_name, user.id, safeText(user.display_name), x.note, x.reason, "legacy_stocktake", requestId, documentNo("ST", requestId)));
    if (diff !== 0) statements.push(env.DB.prepare(`INSERT INTO stock_adjustments(session_id,batch_id,location_id,item_id,system_qty,counted_qty,difference,reason,note,user_id,user_name,created_at) VALUES('',?,?,?,?,?,?,?,?,?,?,?)`).bind(x.row.batch_id, x.row.location_id, x.row.item_id, current, x.counted, diff, x.reason, x.note, user.id, safeText(user.display_name), when));
  }
  statements.push(auditStatement(env.DB, { action: "BATCH_STOCKTAKE", entityType: "stocktake", entityId: requestId, actor: user, before: null, after: { count: rows.length }, reason: "\u5FEB\u901F\u6279\u6B21\u76E4\u9EDE", requestId }));
  try {
    await env.DB.batch(statements);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    if (/CHECK constraint/i.test(String(e))) return { success: false, error: "\u76E4\u9EDE\u671F\u9593\u8CC7\u6599\u5DF2\u88AB\u5176\u4ED6\u4EBA\u7570\u52D5\uFF0C\u6574\u6279\u76E4\u9EDE\u672A\u5BEB\u5165\uFF0C\u8ACB\u540C\u6B65\u5F8C\u91CD\u8A66", status: 409 };
    throw e;
  }
  const updatedItems = await getRowsByBatchLocationPairs(env.DB, rows.map((x) => ({ batch_id: x.row.batch_id, location_id: x.row.location_id })), user), result = { success: true, message: "\u6279\u6B21\u76E4\u9EDE\u5B8C\u6210", updatedItems };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(handleLegacyBatchStocktake, "handleLegacyBatchStocktake");
async function getOpenStocktakeSummary(db, userId) {
  return db.prepare(`SELECT session_id,status,blind_mode,location_id,location_name,started_at,total_lines,counted_lines,variance_lines FROM stocktake_sessions WHERE status='open' AND created_by=? ORDER BY started_at DESC LIMIT 1`).bind(userId).first();
}
__name(getOpenStocktakeSummary, "getOpenStocktakeSummary");
async function startStocktakeSession(env, params, user) {
  requireRole(user, "operator");
  const existing = await getOpenStocktakeSummary(env.DB, user.id);
  if (existing) return { success: true, message: "\u5DF2\u6062\u5FA9\u5C1A\u672A\u5B8C\u6210\u7684\u76E4\u9EDE\u5DE5\u4F5C\u968E\u6BB5", session: await buildStocktakePayload(env.DB, existing.session_id, user) };
  const locationId = Number(params.locationId || 0), location = await requireActiveLocation(env.DB, locationId), sessionId = crypto.randomUUID(), when = nowIso(), blind = params.blindMode ? 1 : 0, note = safeText(params.note), requestId = requestIdFrom(params);
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "startStocktakeSession", { sessionId, locationId, blind }), env.DB.prepare(`INSERT INTO stocktake_sessions(session_id,status,blind_mode,location_id,location_name,created_by,created_by_name,started_at,note,total_lines,counted_lines,variance_lines) VALUES(?,'open',?,?,?,?,?,?,?,0,0,0)`).bind(sessionId, blind, locationId, location.name, user.id, safeText(user.display_name), when, note), env.DB.prepare(`INSERT INTO stocktake_lines(session_id,batch_id,location_id,item_id,lot,expiry,system_qty,system_version,status) SELECT ?,b.batch_id,s.location_id,b.item_id,b.lot,b.expiry,s.qty,s.version,'pending' FROM inventory_batches b JOIN items i ON i.item_id=b.item_id JOIN stock_balances s ON s.batch_id=b.batch_id WHERE i.is_active=1 AND s.location_id=? ORDER BY i.name,CASE WHEN b.expiry='' THEN 1 ELSE 0 END,b.expiry,b.lot`).bind(sessionId, locationId), auditStatement(env.DB, { action: "START_STOCKTAKE", entityType: "stocktake_session", entityId: sessionId, actor: user, before: null, after: { locationId, location: location.name, blind: !!blind }, reason: note, requestId })]);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    if (/UNIQUE constraint/i.test(String(e))) {
      const open = await getOpenStocktakeSummary(env.DB, user.id);
      if (open) return { success: true, message: "\u5DF2\u6062\u5FA9\u5C1A\u672A\u5B8C\u6210\u7684\u76E4\u9EDE\u5DE5\u4F5C\u968E\u6BB5", session: await buildStocktakePayload(env.DB, open.session_id, user) };
    }
    throw e;
  }
  const count = await env.DB.prepare("SELECT COUNT(*) c FROM stocktake_lines WHERE session_id=?").bind(sessionId).first();
  await env.DB.prepare("UPDATE stocktake_sessions SET total_lines=? WHERE session_id=?").bind(Number(count?.c) || 0, sessionId).run();
  const result = { success: true, message: "\u76E4\u9EDE\u5DE5\u4F5C\u968E\u6BB5\u5DF2\u5EFA\u7ACB", session: await buildStocktakePayload(env.DB, sessionId, user) };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(startStocktakeSession, "startStocktakeSession");
async function buildStocktakePayload(db, sessionId, user) {
  const s = await db.prepare("SELECT * FROM stocktake_sessions WHERE session_id=?").bind(sessionId).first();
  if (!s) return null;
  const r = await db.prepare(`SELECT l.session_id,l.batch_id,l.location_id,l.item_id,i.name,i.category,l.lot,l.expiry,l.system_qty,l.counted_qty,l.difference,l.status,l.counted_at,l.counted_by_name,l.reason,l.note AS count_note,b.note AS batch_note,sb.note AS balance_note,sb.qty AS current_qty,loc.name AS location_name FROM stocktake_lines l JOIN items i ON i.item_id=l.item_id JOIN inventory_batches b ON b.batch_id=l.batch_id JOIN stock_balances sb ON sb.batch_id=l.batch_id AND sb.location_id=l.location_id JOIN locations loc ON loc.location_id=l.location_id WHERE l.session_id=? ORDER BY l.status,i.name COLLATE NOCASE,l.expiry,l.lot`).bind(sessionId).all();
  const blind = Number(s.blind_mode) === 1;
  const lines = (r.results || []).map((x) => ({ session_id: x.session_id, batch_id: Number(x.batch_id), location_id: Number(x.location_id), location_name: safeText(x.location_name), id: x.item_id, name: safeName(x.item_id, x.name), category: safeText(x.category), lot: safeText(x.lot), expiry: safeText(x.expiry), system_qty: blind && x.status === "pending" ? null : Number(x.system_qty), counted_qty: x.counted_qty === null ? null : Number(x.counted_qty), difference: x.difference === null ? null : Number(x.difference), status: x.status, counted_at: x.counted_at ? taipeiDateTime(new Date(x.counted_at)) : "", counted_by_name: safeText(x.counted_by_name), reason: safeText(x.reason), note: safeText(x.count_note), batch_note: safeText(x.balance_note) || safeText(x.batch_note), current_qty: blind && x.status === "pending" ? null : Number(x.current_qty) }));
  return { session_id: s.session_id, status: s.status, blind_mode: blind, location_id: Number(s.location_id) || 0, location_name: s.location_name, created_by_name: s.created_by_name, started_at: taipeiDateTime(new Date(s.started_at)), completed_at: s.completed_at ? taipeiDateTime(new Date(s.completed_at)) : "", note: s.note, total_lines: Number(s.total_lines) || 0, counted_lines: Number(s.counted_lines) || 0, variance_lines: Number(s.variance_lines) || 0, lines };
}
__name(buildStocktakePayload, "buildStocktakePayload");
async function getStocktakeSession(env, sessionId, user) {
  let id = sessionId;
  if (!id) {
    const open = await getOpenStocktakeSummary(env.DB, user.id);
    id = open?.session_id || "";
  }
  if (!id) return { success: true, session: null };
  const owner = await env.DB.prepare("SELECT created_by FROM stocktake_sessions WHERE session_id=?").bind(id).first();
  if (!owner) return { success: false, error: "\u627E\u4E0D\u5230\u76E4\u9EDE\u5DE5\u4F5C\u968E\u6BB5" };
  if (Number(owner.created_by) !== Number(user.id) && !canManageInventory(user)) return { success: false, error: "\u6B0A\u9650\u4E0D\u8DB3" };
  return { success: true, session: await buildStocktakePayload(env.DB, id, user) };
}
__name(getStocktakeSession, "getStocktakeSession");
async function recordStocktakeLine(env, params, user) {
  requireRole(user, "operator");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const sessionId = safeText(params.sessionId), batchId = Number(params.batch_id), locationId = Number(params.location_id || 0), counted = safeQty(params.qty), reason = safeText(params.reason), note = safeText(params.note), when = nowIso();
  const s = await env.DB.prepare(`SELECT * FROM stocktake_sessions WHERE session_id=? AND status='open'`).bind(sessionId).first();
  if (!s) return { success: false, error: "\u76E4\u9EDE\u5DE5\u4F5C\u968E\u6BB5\u4E0D\u5B58\u5728\u6216\u5DF2\u7D50\u675F" };
  if (Number(s.created_by) !== Number(user.id) && !canManageInventory(user)) return { success: false, error: "\u6B0A\u9650\u4E0D\u8DB3" };
  const line = await env.DB.prepare(`SELECT l.*,sb.qty AS current_qty,sb.version AS current_version,i.name,i.default_price,loc.name AS location_name FROM stocktake_lines l JOIN stock_balances sb ON sb.batch_id=l.batch_id AND sb.location_id=l.location_id JOIN items i ON i.item_id=l.item_id JOIN locations loc ON loc.location_id=l.location_id WHERE l.session_id=? AND l.batch_id=? AND l.location_id=?`).bind(sessionId, batchId, locationId).first();
  if (!line) return { success: false, error: "\u6B64\u6279\u6B21\u4E0D\u5728\u672C\u6B21\u76E4\u9EDE\u6E05\u55AE\u4E2D" };
  if (line.status === "counted") return { success: false, error: "\u6B64\u6279\u6B21\u5DF2\u5B8C\u6210\u76E4\u9EDE\uFF0C\u907F\u514D\u91CD\u8907\u76E4\u9EDE" };
  const current = Number(line.current_qty);
  if (Number(line.system_qty) !== current || Number(line.system_version) !== Number(line.current_version)) {
    await env.DB.prepare(`UPDATE stocktake_lines SET system_qty=?,system_version=? WHERE session_id=? AND batch_id=? AND location_id=? AND status='pending'`).bind(current, Number(line.current_version), sessionId, batchId, locationId).run();
    return { success: false, error: "\u76E4\u9EDE\u958B\u59CB\u5F8C\u6B64\u6279\u6B21\u5DF2\u6709\u5176\u4ED6\u5EAB\u5B58\u7570\u52D5\uFF0C\u7CFB\u7D71\u5DF2\u66F4\u65B0\u76E4\u9EDE\u57FA\u6E96\uFF1B\u8ACB\u91CD\u65B0\u78BA\u8A8D\u73FE\u5834\u6578\u91CF\u5F8C\u518D\u9001\u51FA", status: 409 };
  }
  const diff = counted - current;
  if (diff !== 0 && !reason) return { success: false, error: "\u76E4\u9EDE\u6578\u91CF\u6709\u5DEE\u7570\uFF0C\u8ACB\u9078\u64C7\u5DEE\u7570\u539F\u56E0" };
  const statements = [requestClaimStatement(env.DB, requestId, "stocktakeRecord", { sessionId, batchId, locationId, counted }), env.DB.prepare(`UPDATE stock_balances SET qty=CASE WHEN qty=? AND version=? AND EXISTS(SELECT 1 FROM stocktake_sessions ss JOIN stocktake_lines sl ON sl.session_id=ss.session_id WHERE ss.session_id=? AND ss.status='open' AND sl.batch_id=? AND sl.location_id=? AND sl.status='pending') THEN ? ELSE -1 END,last_stocktake=?,updated_at=? WHERE batch_id=? AND location_id=?`).bind(current, Number(line.current_version), sessionId, batchId, locationId, counted, when, when, batchId, locationId), env.DB.prepare(`UPDATE stocktake_lines SET system_qty=?,counted_qty=?,difference=?,status='counted',counted_at=?,counted_by=?,counted_by_name=?,reason=?,note=? WHERE session_id=? AND batch_id=? AND location_id=? AND status='pending'`).bind(current, counted, diff, when, user.id, safeText(user.display_name), reason, note, sessionId, batchId, locationId), env.DB.prepare(`INSERT INTO transactions(request_id,created_at,type,item_id,name,batch_id,lot,expiry,qty,price,balance_before,balance_after,location_id,location_name,user_id,user_name,note,reason,reference_type,reference_id,document_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(requestId, when, "\u76E4\u9EDE", line.item_id, safeName(line.item_id, line.name), batchId, line.lot, line.expiry, counted, Number(line.default_price) || 0, current, counted, locationId, line.location_name, user.id, safeText(user.display_name), note, reason, "stocktake", sessionId, documentNo("ST", requestId)), auditStatement(env.DB, { action: "STOCKTAKE_COUNT", entityType: "balance", entityId: `${batchId}:${locationId}`, actor: user, before: { qty: current }, after: { qty: counted }, reason, requestId })];
  if (diff !== 0) statements.push(env.DB.prepare(`INSERT INTO stock_adjustments(session_id,batch_id,location_id,item_id,system_qty,counted_qty,difference,reason,note,user_id,user_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(sessionId, batchId, locationId, line.item_id, current, counted, diff, reason, note, user.id, safeText(user.display_name), when));
  try {
    await env.DB.batch(statements);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    if (/CHECK constraint/i.test(String(e))) return { success: false, error: "\u6B64\u6279\u6B21\u5728\u76E4\u9EDE\u9001\u51FA\u524D\u5DF2\u88AB\u5176\u4ED6\u4F7F\u7528\u8005\u7570\u52D5\uFF0C\u70BA\u907F\u514D\u8986\u84CB\u6B63\u78BA\u5EAB\u5B58\uFF0C\u672C\u6B21\u672A\u5BEB\u5165\uFF1B\u8ACB\u91CD\u65B0\u540C\u6B65\u5F8C\u518D\u76E4", status: 409 };
    throw e;
  }
  await refreshStocktakeSummary(env.DB, sessionId);
  const updated = await getBalanceByBatchLocation(env.DB, batchId, locationId);
  const result = { success: true, message: diff === 0 ? "\u76E4\u9EDE\u4E00\u81F4" : "\u76E4\u9EDE\u5DEE\u7570\u5DF2\u8A18\u9304", updatedItem: rowToItem(updated, user), difference: diff, system_qty: current, counted_qty: counted, session: await buildStocktakePayload(env.DB, sessionId, user) };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(recordStocktakeLine, "recordStocktakeLine");
async function refreshStocktakeSummary(db, sessionId) {
  const c = await db.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN status='counted' THEN 1 ELSE 0 END) counted,SUM(CASE WHEN status='counted' AND difference<>0 THEN 1 ELSE 0 END) variance FROM stocktake_lines WHERE session_id=?`).bind(sessionId).first();
  await db.prepare("UPDATE stocktake_sessions SET total_lines=?,counted_lines=?,variance_lines=? WHERE session_id=?").bind(Number(c?.total) || 0, Number(c?.counted) || 0, Number(c?.variance) || 0, sessionId).run();
}
__name(refreshStocktakeSummary, "refreshStocktakeSummary");
async function syncOpenStocktakeScope(db, sessionId) {
  await db.prepare(`INSERT OR IGNORE INTO stocktake_lines(session_id,batch_id,location_id,item_id,lot,expiry,system_qty,system_version,status)
    SELECT ss.session_id,b.batch_id,s.location_id,b.item_id,b.lot,b.expiry,s.qty,s.version,'pending'
    FROM stocktake_sessions ss
    JOIN stock_balances s ON s.location_id=ss.location_id
    JOIN inventory_batches b ON b.batch_id=s.batch_id
    JOIN items i ON i.item_id=b.item_id
    WHERE ss.session_id=? AND ss.status='open' AND i.is_active=1`).bind(sessionId).run();
}
__name(syncOpenStocktakeScope, "syncOpenStocktakeScope");
async function completeStocktakeSession(env, params, user) {
  requireRole(user, "operator");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const id = safeText(params.sessionId), force = !!params.force;
  if (force && !canManageInventory(user)) throw withStatus("部分結案需要庫存管理員權限", 403);
  const s = await env.DB.prepare(`SELECT * FROM stocktake_sessions WHERE session_id=?`).bind(id).first();
  if (!s) return { success: false, error: "\u627E\u4E0D\u5230\u76E4\u9EDE\u5DE5\u4F5C\u968E\u6BB5" };
  if (Number(s.created_by) !== Number(user.id) && !canManageInventory(user)) return { success: false, error: "\u6B0A\u9650\u4E0D\u8DB3" };
  if (s.status === "completed") {
    const result2 = { success: true, message: "\u6B64\u76E4\u9EDE\u5DE5\u4F5C\u968E\u6BB5\u5DF2\u5B8C\u6210", session: await buildStocktakePayload(env.DB, id, user) };
    return result2;
  }
  if (s.status !== "open") return { success: false, error: "\u76E4\u9EDE\u5DE5\u4F5C\u968E\u6BB5\u5DF2\u53D6\u6D88" };
  await syncOpenStocktakeScope(env.DB, id);
  await refreshStocktakeSummary(env.DB, id);
  const fresh = await env.DB.prepare("SELECT * FROM stocktake_sessions WHERE session_id=?").bind(id).first(), pending = Number(fresh.total_lines) - Number(fresh.counted_lines);
  if (pending > 0 && !force) return { success: true, message: `\u5C1A\u6709 ${pending} \u500B\u6279\u6B21\u672A\u76E4\u9EDE`, requiresConfirmation: true, pending, session: await buildStocktakePayload(env.DB, id, user) };
  const completedAt = nowIso();
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "completeStocktakeSession", { id, force }), env.DB.prepare(`UPDATE stocktake_sessions SET status=CASE WHEN status='open' THEN 'completed' ELSE 'conflict' END,completed_at=? WHERE session_id=?`).bind(completedAt,id), auditStatement(env.DB, { action: "COMPLETE_STOCKTAKE", entityType: "stocktake_session", entityId: id, actor: user, before: { status: "open", pending }, after: { status: "completed" }, reason: force && pending > 0 ? "\u5F37\u5236\u5B8C\u6210\u672A\u5168\u76E4\u5DE5\u4F5C\u968E\u6BB5" : "\u5B8C\u6210\u76E4\u9EDE", requestId })]);
  } catch (e) {
    if (!isDuplicateRequestError(e)) throw e;
  }
  const result = { success: true, message: `\u76E4\u9EDE\u5B8C\u6210\uFF1A${fresh.counted_lines}/${fresh.total_lines}\uFF0C\u5DEE\u7570 ${fresh.variance_lines} \u7B46`, session: await buildStocktakePayload(env.DB, id, user) };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(completeStocktakeSession, "completeStocktakeSession");
async function cancelStocktakeSession(env, params, user) {
  requireRole(user, "operator");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const id = safeText(params.sessionId), s = await env.DB.prepare("SELECT created_by,status FROM stocktake_sessions WHERE session_id=?").bind(id).first();
  if (!s) return { success: false, error: "\u627E\u4E0D\u5230\u76E4\u9EDE\u5DE5\u4F5C\u968E\u6BB5" };
  if (Number(s.created_by) !== Number(user.id) && !canManageInventory(user)) return { success: false, error: "\u6B0A\u9650\u4E0D\u8DB3" };
  if (s.status === "cancelled") return { success: true, message: "\u6B64\u76E4\u9EDE\u5DE5\u4F5C\u968E\u6BB5\u5DF2\u53D6\u6D88" };
  if (s.status === "completed") return { success: false, error: "\u5DF2\u5B8C\u6210\u7684\u76E4\u9EDE\u4E0D\u53EF\u53D6\u6D88" };
  const cancelledAt = nowIso();
  const update = await env.DB.prepare(`UPDATE stocktake_sessions SET status='cancelled',completed_at=? WHERE session_id=? AND status='open'`).bind(cancelledAt, id).run();
  if (changedRows(update) !== 1) {
    const latest = await env.DB.prepare("SELECT status FROM stocktake_sessions WHERE session_id=?").bind(id).first();
    if (latest?.status === "cancelled") return { success: true, message: "\u6B64\u76E4\u9EDE\u5DE5\u4F5C\u968E\u6BB5\u5DF2\u53D6\u6D88" };
    return { success: false, error: "\u76E4\u9EDE\u5DE5\u4F5C\u968E\u6BB5\u72C0\u614B\u5DF2\u8B8A\u66F4\uFF0C\u8ACB\u91CD\u65B0\u540C\u6B65", status: 409 };
  }
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "cancelStocktakeSession", { id }), auditStatement(env.DB, { action: "CANCEL_STOCKTAKE", entityType: "stocktake_session", entityId: id, actor: user, before: { status: "open" }, after: { status: "cancelled" }, reason: safeText(params.reason) || "\u4F7F\u7528\u8005\u53D6\u6D88", requestId })]);
  } catch (e) {
    if (!isDuplicateRequestError(e)) throw e;
  }
  const result = { success: true, message: "\u76E4\u9EDE\u5DE5\u4F5C\u968E\u6BB5\u5DF2\u53D6\u6D88" };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(cancelStocktakeSession, "cancelStocktakeSession");
async function listAdjustments(env, user, sessionId = "") {
  requireRole(user, "inventory_manager");
  const r = sessionId ? await env.DB.prepare(`SELECT a.*,i.name,b.lot,b.expiry,l.name AS location_name FROM stock_adjustments a JOIN items i ON i.item_id=a.item_id LEFT JOIN inventory_batches b ON b.batch_id=a.batch_id LEFT JOIN locations l ON l.location_id=a.location_id WHERE a.session_id=? ORDER BY a.created_at DESC`).bind(sessionId).all() : await env.DB.prepare(`SELECT a.*,i.name,b.lot,b.expiry,l.name AS location_name FROM stock_adjustments a JOIN items i ON i.item_id=a.item_id LEFT JOIN inventory_batches b ON b.batch_id=a.batch_id LEFT JOIN locations l ON l.location_id=a.location_id ORDER BY a.created_at DESC LIMIT 500`).all();
  return { success: true, adjustments: (r.results || []).map((x) => ({ ...x, created_at: taipeiDateTime(new Date(x.created_at)), resolved_at: x.resolved_at ? taipeiDateTime(new Date(x.resolved_at)) : "" })) };
}
__name(listAdjustments, "listAdjustments");
async function resolveAdjustment(env, params, user) {
  requireRole(user, "inventory_manager");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const adjustmentId = Number(params.adjustmentId), note = safeText(params.resolutionNote);
  if (!note) return { success: false, error: "\u8ACB\u586B\u5BEB\u5DEE\u7570\u8655\u7406\u8AAA\u660E" };
  const old = await env.DB.prepare("SELECT * FROM stock_adjustments WHERE adjustment_id=?").bind(adjustmentId).first();
  if (!old) return { success: false, error: "\u627E\u4E0D\u5230\u5DEE\u7570\u7D00\u9304" };
  if (old.resolved_at) return { success: true, message: "\u6B64\u5DEE\u7570\u5DF2\u5B8C\u6210\u8655\u7406" };
  const resolvedAt = nowIso();
  const update = await env.DB.prepare("UPDATE stock_adjustments SET resolved_at=?,resolved_by=?,resolution_note=? WHERE adjustment_id=? AND resolved_at=''").bind(resolvedAt, user.id, note, adjustmentId).run();
  if (changedRows(update) !== 1) {
    const latest = await env.DB.prepare("SELECT resolved_at FROM stock_adjustments WHERE adjustment_id=?").bind(adjustmentId).first();
    if (latest?.resolved_at) return { success: true, message: "\u6B64\u5DEE\u7570\u5DF2\u5B8C\u6210\u8655\u7406" };
    return { success: false, error: "\u5DEE\u7570\u72C0\u614B\u5DF2\u8B8A\u66F4\uFF0C\u8ACB\u91CD\u65B0\u540C\u6B65", status: 409 };
  }
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "resolveAdjustment", { adjustmentId }), auditStatement(env.DB, { action: "RESOLVE_STOCKTAKE_VARIANCE", entityType: "stock_adjustment", entityId: adjustmentId, actor: user, before: { resolved: false }, after: { resolved: true, resolutionNote: note }, reason: note, requestId })]);
  } catch (e) {
    if (!isDuplicateRequestError(e)) throw e;
  }
  const result = { success: true, message: "\u76E4\u9EDE\u5DEE\u7570\u5DF2\u6A19\u8A18\u8655\u7406\u5B8C\u6210" };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(resolveAdjustment, "resolveAdjustment");
async function listUsers(env) {
  const r = await env.DB.prepare("SELECT id,account,display_name,role,access_role,is_active,created_at,updated_at FROM users ORDER BY display_name,account").all();
  return { success: true, users: (r.results || []).map((x) => ({ ...x, role_label: ROLE_LABEL[roleOf(x)] || roleOf(x) })) };
}
__name(listUsers, "listUsers");
async function listUsersChecked(env, user) {
  requireRole(user, "system_admin");
  return listUsers(env);
}
__name(listUsersChecked, "listUsersChecked");
async function createUser(env, params, user) {
  requireRole(user, "system_admin");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const account = safeText(params.account), displayName = safeText(params.displayName) || account, hash = safeText(params.passwordHash), salt = safeText(params.passwordSalt), accessRole = safeText(params.accessRole || params.role || "operator");
  if (!(accessRole in ROLE_LEVEL)) return { success: false, error: "\u4F7F\u7528\u8005\u89D2\u8272\u932F\u8AA4" };
  if (!account || !validPasswordCredential(hash, salt)) return { success: false, error: "\u5E33\u865F\u4E0D\u53EF\u7A7A\u767D\uFF0C\u6216\u5BC6\u78BC\u6191\u8B49\u683C\u5F0F\u932F\u8AA4" };
  const when = nowIso(), legacyRole = accessRole === "system_admin" ? "admin" : "user";
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "createUser", { account, displayName, accessRole }), env.DB.prepare(`INSERT INTO users(account,password_hash,password_salt,display_name,role,access_role,is_active,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?)`).bind(account, hash, salt, displayName, legacyRole, accessRole, when, when), auditStatement(env.DB, { action: "CREATE_USER", entityType: "user", entityId: account, actor: user, before: null, after: { account, displayName, accessRole }, reason: "\u5EFA\u7ACB\u4F7F\u7528\u8005", requestId })]);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    if (/UNIQUE.*users\.account/i.test(String(e))) return { success: false, error: "\u5E33\u865F\u5DF2\u5B58\u5728" };
    throw e;
  }
  const result = { success: true, message: "\u4F7F\u7528\u8005\u5EFA\u7ACB\u6210\u529F" };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(createUser, "createUser");
async function setUserActive(env, params, user) {
  requireRole(user, "system_admin");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const userId = Number(params.userId), active = params.isActive ? 1 : 0;
  if (userId === Number(user.id) && !active) return { success: false, error: "\u4E0D\u53EF\u505C\u7528\u76EE\u524D\u767B\u5165\u4E2D\u7684\u7CFB\u7D71\u7BA1\u7406\u54E1\u5E33\u865F" };
  const old = await env.DB.prepare("SELECT id,account,display_name,access_role,is_active FROM users WHERE id=?").bind(userId).first();
  if (!old) return { success: false, error: "\u627E\u4E0D\u5230\u4F7F\u7528\u8005" };
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "setUserActive", { userId, active }), env.DB.prepare("UPDATE users SET is_active=?,updated_at=? WHERE id=?").bind(active, nowIso(), userId), ...active ? [] : [env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(userId)], auditStatement(env.DB, { action: active ? "ACTIVATE_USER" : "DEACTIVATE_USER", entityType: "user", entityId: userId, actor: user, before: { is_active: Number(old.is_active) }, after: { is_active: active }, reason: "\u5E33\u865F\u72C0\u614B\u8ABF\u6574", requestId })]);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    throw e;
  }
  const result = { success: true, message: active ? "\u5E33\u865F\u5DF2\u555F\u7528" : "\u5E33\u865F\u5DF2\u505C\u7528" };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(setUserActive, "setUserActive");
async function setUserRole(env, params, user) {
  requireRole(user, "system_admin");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const userId = Number(params.userId), accessRole = safeText(params.accessRole);
  if (!(accessRole in ROLE_LEVEL)) return { success: false, error: "\u4F7F\u7528\u8005\u89D2\u8272\u932F\u8AA4" };
  if (userId === Number(user.id) && accessRole !== "system_admin") return { success: false, error: "\u4E0D\u53EF\u964D\u4F4E\u76EE\u524D\u767B\u5165\u4E2D\u7684\u7CFB\u7D71\u7BA1\u7406\u54E1\u6B0A\u9650" };
  const old = await env.DB.prepare("SELECT id,account,display_name,access_role FROM users WHERE id=?").bind(userId).first();
  if (!old) return { success: false, error: "\u627E\u4E0D\u5230\u4F7F\u7528\u8005" };
  const legacyRole = accessRole === "system_admin" ? "admin" : "user";
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "setUserRole", { userId, accessRole }), env.DB.prepare("UPDATE users SET access_role=?,role=?,updated_at=? WHERE id=?").bind(accessRole, legacyRole, nowIso(), userId), env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(userId), auditStatement(env.DB, { action: "CHANGE_USER_ROLE", entityType: "user", entityId: userId, actor: user, before: { access_role: old.access_role }, after: { access_role: accessRole }, reason: "\u89D2\u8272\u6B0A\u9650\u8ABF\u6574", requestId })]);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    throw e;
  }
  const result = { success: true, message: "\u89D2\u8272\u5DF2\u66F4\u65B0\uFF0C\u8A72\u4F7F\u7528\u8005\u9700\u91CD\u65B0\u767B\u5165" };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(setUserRole, "setUserRole");
async function resetUserPassword(env, params, user) {
  requireRole(user, "system_admin");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const userId = Number(params.userId), hash = safeText(params.passwordHash), salt = safeText(params.passwordSalt);
  if (!validPasswordCredential(hash, salt)) return { success: false, error: "\u5BC6\u78BC\u6191\u8B49\u683C\u5F0F\u932F\u8AA4" };
  const old = await env.DB.prepare("SELECT account FROM users WHERE id=?").bind(userId).first();
  if (!old) return { success: false, error: "\u627E\u4E0D\u5230\u4F7F\u7528\u8005" };
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "resetUserPassword", { userId }), env.DB.prepare("UPDATE users SET password_hash=?,password_salt=?,updated_at=? WHERE id=?").bind(hash, salt, nowIso(), userId), env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(userId), auditStatement(env.DB, { action: "RESET_PASSWORD", entityType: "user", entityId: userId, actor: user, before: null, after: { account: old.account, passwordReset: true }, reason: "\u7BA1\u7406\u54E1\u91CD\u8A2D\u5BC6\u78BC", requestId })]);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    throw e;
  }
  const result = { success: true, message: "\u5BC6\u78BC\u5DF2\u91CD\u8A2D\uFF0C\u8A72\u4F7F\u7528\u8005\u9700\u91CD\u65B0\u767B\u5165" };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(resetUserPassword, "resetUserPassword");
async function adminUpdateItem(env, params, user) {
  requireRole(user, "inventory_manager");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const id = safeText(params.id), name = safeName(id, params.name), category = safeText(params.category), min = Math.max(0, Number.parseInt(params.minQty, 10) || 0), target = Math.max(0, Number.parseInt(params.targetQty, 10) || 0), warning = Math.max(0, Math.min(3650, Number.parseInt(params.warningDays, 10) || 30)), lead = Math.max(0, Math.min(3650, Number.parseInt(params.leadTimeDays, 10) || 7));
  if (!id) return { success: false, error: "\u7F3A\u5C11\u54C1\u9805 ID" };
  const old = await env.DB.prepare("SELECT * FROM items WHERE item_id=?").bind(id).first();
  if (!old) return { success: false, error: "\u627E\u4E0D\u5230\u54C1\u9805" };
  const price = canViewCost(user) ? safePrice(params.price) : Number(old.default_price) || 0, when = nowIso();
  const after = { name, category, min_qty: min, target_qty: target, warning_days: warning, lead_time_days: lead, default_price: price };
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "adminUpdateItem", { id, ...after }), env.DB.prepare("UPDATE items SET name=?,category=?,min_qty=?,target_qty=?,warning_days=?,lead_time_days=?,default_price=?,updated_at=? WHERE item_id=?").bind(name, category, min, target, warning, lead, price, when, id), auditStatement(env.DB, { action: "UPDATE_ITEM_MASTER", entityType: "item", entityId: id, actor: user, before: old, after, reason: safeText(params.reason) || "\u54C1\u9805\u4E3B\u6A94\u4FEE\u6539", requestId })]);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    throw e;
  }
  const result = { success: true, message: "\u54C1\u9805\u4E3B\u6A94\u5DF2\u66F4\u65B0", updatedItems: await getRowsByItemId(env.DB, id, user) };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(adminUpdateItem, "adminUpdateItem");
async function adminUpdateBatch(env, params, user) {
  requireRole(user, "inventory_manager");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const batchId = Number(params.batch_id), old = await env.DB.prepare("SELECT * FROM inventory_batches WHERE batch_id=?").bind(batchId).first();
  if (!old) return { success: false, error: "\u627E\u4E0D\u5230\u6279\u6B21" };
  if (params.qty !== void 0 && params.qty !== null && String(params.qty) !== "") return { success: false, error: "\u5546\u7528\u7248\u7981\u6B62\u76F4\u63A5\u8986\u84CB\u5EAB\u5B58\u6578\u91CF\uFF1B\u8ACB\u4F7F\u7528\u300C\u5EAB\u5B58\u8ABF\u6574\u55AE\u300D" };
  const lot = safeText(params.lot), expiry = normalizeExpiry(params.expiry), note = safeText(params.note), when = nowIso();
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "adminUpdateBatch", { batchId, lot, expiry, note }), env.DB.prepare("UPDATE inventory_batches SET lot=?,expiry=?,note=?,updated_at=? WHERE batch_id=?").bind(lot, expiry, note, when, batchId), auditStatement(env.DB, { action: "UPDATE_BATCH_META", entityType: "batch", entityId: batchId, actor: user, before: old, after: { lot, expiry, note }, reason: safeText(params.reason) || "\u6279\u6B21\u8CC7\u6599\u4FEE\u6539", requestId })]);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    if (/UNIQUE constraint/i.test(String(e))) return { success: false, error: "\u76F8\u540C\u54C1\u9805\u3001\u6279\u865F\u8207\u6548\u671F\u7684\u6279\u6B21\u5DF2\u5B58\u5728" };
    throw e;
  }
  const updatedItems = await getRowsByBatchIds(env.DB, [batchId], user), result = { success: true, message: "\u6279\u6B21\u8CC7\u6599\u5DF2\u66F4\u65B0", updatedItems };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(adminUpdateBatch, "adminUpdateBatch");
async function setItemActive(env, params, user) {
  requireRole(user, "inventory_manager");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const id = safeText(params.id), active = params.isActive ? 1 : 0, old = await env.DB.prepare("SELECT * FROM items WHERE item_id=?").bind(id).first();
  if (!old) return { success: false, error: "\u627E\u4E0D\u5230\u54C1\u9805" };
  if (!active) {
    const q = await env.DB.prepare(`SELECT COALESCE(SUM(s.qty),0) q FROM inventory_batches b JOIN stock_balances s ON s.batch_id=b.batch_id WHERE b.item_id=?`).bind(id).first();
    if (Number(q?.q) > 0) return { success: false, error: `\u5C1A\u6709 ${q.q} \u4EF6\u5EAB\u5B58\uFF0C\u4E0D\u53EF\u505C\u7528\u54C1\u9805\uFF1B\u8ACB\u5148\u9818\u7528\u3001\u5831\u5EE2\u3001\u9000\u8CA8\u6216\u8ABF\u6574\u81F3 0` };
  }
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "setItemActive", { id, active }), env.DB.prepare("UPDATE items SET is_active=?,updated_at=? WHERE item_id=?").bind(active, nowIso(), id), auditStatement(env.DB, { action: active ? "REACTIVATE_ITEM" : "DEACTIVATE_ITEM", entityType: "item", entityId: id, actor: user, before: { is_active: Number(old.is_active) }, after: { is_active: active }, reason: safeText(params.reason) || "\u54C1\u9805\u72C0\u614B\u8ABF\u6574", requestId })]);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    throw e;
  }
  const result = { success: true, message: active ? "\u54C1\u9805\u5DF2\u91CD\u65B0\u555F\u7528" : "\u54C1\u9805\u5DF2\u505C\u7528" };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(setItemActive, "setItemActive");
async function getAdminInventory(env, user) {
  requireRole(user, "inventory_manager");
  const items = await getAllInventory(env.DB, user, { includeInactive: true }), masters = await env.DB.prepare(`SELECT item_id,name,category,min_qty,target_qty,warning_days,lead_time_days,default_price,is_active,created_at,updated_at FROM items ORDER BY name COLLATE NOCASE,item_id`).all();
  return { success: true, items, masters: (masters.results || []).map((x) => ({ ...x, default_price: canViewCost(user) ? Number(x.default_price) || 0 : null })), locations: await listLocationsRaw(env.DB, true) };
}
__name(getAdminInventory, "getAdminInventory");
async function listLocationsRaw(db, includeInactive = false) {
  const q = includeInactive ? `SELECT location_id,code,name,is_active,created_at,updated_at FROM locations ORDER BY is_active DESC,name,code` : `SELECT location_id,code,name,is_active,created_at,updated_at FROM locations WHERE is_active=1 ORDER BY name,code`;
  const r = await db.prepare(q).all();
  return r.results || [];
}
__name(listLocationsRaw, "listLocationsRaw");
async function listLocations(env, user, includeInactive = false) {
  return { success: true, locations: await listLocationsRaw(env.DB, includeInactive && canManageInventory(user)) };
}
__name(listLocations, "listLocations");
async function createLocation(env, params, user) {
  requireRole(user, "inventory_manager");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const code = safeText(params.code).toUpperCase(), name = safeText(params.name);
  if (!code || !name) return { success: false, error: "\u8ACB\u586B\u5BEB\u5132\u4F4D\u4EE3\u78BC\u8207\u540D\u7A31" };
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "createLocation", { code, name }), env.DB.prepare(`INSERT INTO locations(code,name,is_active,created_at,updated_at) VALUES(?,?,1,?,?)`).bind(code, name, nowIso(), nowIso()), auditStatement(env.DB, { action: "CREATE_LOCATION", entityType: "location", entityId: code, actor: user, before: null, after: { code, name, is_active: 1 }, reason: "\u65B0\u589E\u5132\u4F4D", requestId })]);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    if (/UNIQUE.*locations\.code/i.test(String(e))) return { success: false, error: "\u5132\u4F4D\u4EE3\u78BC\u5DF2\u5B58\u5728" };
    throw e;
  }
  const result = { success: true, message: "\u5132\u4F4D\u5DF2\u5EFA\u7ACB", locations: await listLocationsRaw(env.DB, true) };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(createLocation, "createLocation");
async function updateLocation(env, params, user) {
  requireRole(user, "inventory_manager");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const locationId = Number(params.locationId), old = await getLocation(env.DB, locationId);
  if (!old) return { success: false, error: "\u627E\u4E0D\u5230\u5132\u4F4D" };
  const name = safeText(params.name) || old.name, active = params.isActive === void 0 ? Number(old.is_active) : params.isActive ? 1 : 0;
  if (!active) {
    const q = await env.DB.prepare("SELECT COALESCE(SUM(qty),0) q FROM stock_balances WHERE location_id=?").bind(locationId).first();
    if (Number(q?.q) > 0) return { success: false, error: `\u6B64\u5132\u4F4D\u5C1A\u6709 ${q.q} \u4EF6\u5EAB\u5B58\uFF0C\u4E0D\u53EF\u505C\u7528` };
  }
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "updateLocation", { locationId, name, active }), env.DB.prepare("UPDATE locations SET name=?,is_active=?,updated_at=? WHERE location_id=?").bind(name, active, nowIso(), locationId), auditStatement(env.DB, { action: "UPDATE_LOCATION", entityType: "location", entityId: locationId, actor: user, before: old, after: { name, is_active: active }, reason: "\u5132\u4F4D\u8CC7\u6599\u4FEE\u6539", requestId })]);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    throw e;
  }
  const result = { success: true, message: "\u5132\u4F4D\u5DF2\u66F4\u65B0", locations: await listLocationsRaw(env.DB, true) };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(updateLocation, "updateLocation");
async function getAnalytics(env, user, locationId = 0) {
  const now = /* @__PURE__ */ new Date(), start90 = new Date(now.getTime() - 90 * 864e5).toISOString(), start30 = new Date(now.getTime() - 30 * 864e5).toISOString();
  let invSql = `${INVENTORY_SELECT} WHERE i.is_active=1 AND l.is_active=1`;
  const binds = [];
  if (locationId) {
    invSql += " AND l.location_id=?";
    binds.push(locationId);
  }
  const invQ = env.DB.prepare(invSql), inv = (await (binds.length ? invQ.bind(...binds) : invQ).all()).results || [];
  let txSql = `SELECT created_at,type,item_id,name,qty,price,location_id FROM transactions WHERE created_at>=?`;
  const txB = [start90];
  if (locationId) {
    txSql += " AND location_id=?";
    txB.push(locationId);
  }
  const tx = (await env.DB.prepare(txSql).bind(...txB).all()).results || [];
  const totals = /* @__PURE__ */ new Map(), usage30 = /* @__PURE__ */ new Map(), usage90 = /* @__PURE__ */ new Map(), daily = /* @__PURE__ */ new Map();
  let inventoryValue = 0;
  for (const r of inv) {
    const q = Number(r.qty) || 0;
    if (!totals.has(r.item_id)) totals.set(r.item_id, { id: r.item_id, name: safeName(r.item_id, r.name), qty: 0, min: Number(r.min_qty) || 0, target: Number(r.target_qty) || 0, lead: Number(r.lead_time_days) || 7 });
    totals.get(r.item_id).qty += q;
    if (canViewCost(user)) inventoryValue += q * (Number(r.price) || 0);
  }
  for (const t of tx) {
    const q = Number(t.qty) || 0;
    if (t.type === "\u9818\u7528") {
      usage90.set(t.item_id, (usage90.get(t.item_id) || 0) + q);
      if (t.created_at >= start30) usage30.set(t.item_id, (usage30.get(t.item_id) || 0) + q);
    }
    if (t.created_at >= start30) {
      const d = taipeiDateOnly(new Date(t.created_at));
      if (!daily.has(d)) daily.set(d, { date: d, inbound: 0, outbound: 0, disposal: 0, returns: 0, adjustment: 0 });
      const x = daily.get(d);
      if (t.type === "\u5165\u5EAB") x.inbound += q;
      else if (t.type === "\u9818\u7528") x.outbound += q;
      else if (t.type === "\u5831\u5EE2") x.disposal += q;
      else if (t.type === "\u9000\u8CA8") x.returns += q;
      else if (t.type === "\u5EAB\u5B58\u8ABF\u6574") x.adjustment += q;
    }
  }
  const procurement = [];
  for (const v of totals.values()) {
    const avg30 = (usage30.get(v.id) || 0) / 30, avg90 = (usage90.get(v.id) || 0) / 90, daysCover = avg30 > 0 ? v.qty / avg30 : null;
    const suggestedTarget = v.target > 0 ? v.target : Math.max(v.min * 2, Math.ceil(avg30 * (v.lead + 7)));
    const recommended = Math.max(0, suggestedTarget - v.qty);
    procurement.push({ ...v, avg_daily_30: Number(avg30.toFixed(2)), avg_daily_90: Number(avg90.toFixed(2)), days_cover: daysCover === null ? null : Number(daysCover.toFixed(1)), suggested_target: suggestedTarget, recommended_qty: recommended });
  }
  procurement.sort((a, b) => b.recommended_qty - a.recommended_qty || (a.days_cover ?? 9999) - (b.days_cover ?? 9999));
  const topUsage = [...totals.values()].map((v) => ({ id: v.id, name: v.name, used_30: usage30.get(v.id) || 0 })).sort((a, b) => b.used_30 - a.used_30).slice(0, 10);
  return { success: true, costVisible: canViewCost(user), inventoryValue: canViewCost(user) ? inventoryValue : null, dailyTrend: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)), procurementSuggestions: procurement.filter((x) => x.recommended_qty > 0).slice(0, 100), usageMetrics: procurement, topUsage };
}
__name(getAnalytics, "getAnalytics");
async function getAnomalies(env, user, locationId = 0) {
  const items = await getAllInventory(env.DB, user, { locationId }), today = taipeiDateOnly(), overdueCutoff = addDaysYmd(today, -7), itemTotals = /* @__PURE__ */ new Map(), expired = [], expiring = [], overdue = [];
  for (const x of items) {
    if (!itemTotals.has(x.id)) itemTotals.set(x.id, { id: x.id, name: x.name, qty: 0, min: x.min_qty });
    itemTotals.get(x.id).qty += x.qty;
    if (x.qty > 0 && x.expiry && x.expiry < today) expired.push(x);
    else if (x.qty > 0 && x.expiry && x.expiry <= addDaysYmd(today, x.warning_days)) expiring.push(x);
    if (x.qty > 0 && (!x.last_stocktake || x.last_stocktake.slice(0, 10) < overdueCutoff)) overdue.push(x);
  }
  const low = [...itemTotals.values()].filter((x) => x.qty <= x.min);
  const unresolved = await env.DB.prepare(`SELECT COUNT(*) c FROM stock_adjustments WHERE resolved_at=''`).first();
  return { success: true, counts: { expired: expired.length, expiring: expiring.length, low: low.length, overdueStocktake: overdue.length, unresolvedVariance: Number(unresolved?.c) || 0 }, expired: expired.slice(0, 100), expiring: expiring.slice(0, 100), low: low.slice(0, 100), overdueStocktake: overdue.slice(0, 100) };
}
__name(getAnomalies, "getAnomalies");
async function listAuditLogs(env, user, searchParams) {
  requireRole(user, "inventory_manager");
  const limit = Math.max(1, Math.min(500, Number(searchParams.get("limit") || 100))), entity = safeText(searchParams.get("entity"));
  let sql = `SELECT * FROM audit_logs`;
  const binds = [];
  if (entity) {
    sql += " WHERE entity_type=?";
    binds.push(entity);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  binds.push(limit);
  const r = await env.DB.prepare(sql).bind(...binds).all();
  return { success: true, auditLogs: (r.results || []).map((x) => ({ ...x, created_at: taipeiDateTime(new Date(x.created_at)) })) };
}
__name(listAuditLogs, "listAuditLogs");
async function listSystemLogs(env, user, searchParams) {
  requireRole(user, "system_admin");
  const limit = Math.max(1, Math.min(500, Number(searchParams.get("limit") || 100))), severity = safeText(searchParams.get("severity"));
  let sql = "SELECT * FROM system_logs", binds = [];
  if (severity) {
    sql += " WHERE severity=?";
    binds.push(severity);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  binds.push(limit);
  const r = await env.DB.prepare(sql).bind(...binds).all();
  return { success: true, systemLogs: (r.results || []).map((x) => ({ ...x, created_at: taipeiDateTime(new Date(x.created_at)) })) };
}
__name(listSystemLogs, "listSystemLogs");
async function getBackupStatus(env, user) {
  requireRole(user, "system_admin");
  const r = await env.DB.prepare("SELECT * FROM backup_checkpoints ORDER BY checkpoint_date DESC LIMIT 30").all();
  return { success: true, policy: "Cloudflare D1 Time Travel", automatic: true, retentionDays: Number(env.D1_TIME_TRAVEL_RETENTION_DAYS || 7), note: "Time Travel \u70BA D1 \u5167\u5EFA\u5099\u4EFD/\u6642\u9593\u9EDE\u9084\u539F\uFF1Bcheckpoint \u50C5\u70BA\u6BCF\u65E5\u8CC7\u6599\u5065\u5EB7\u6AA2\u67E5\uFF0C\u4E0D\u662F\u5099\u4EFD\u526F\u672C\u3002", checkpoints: r.results || [] };
}
__name(getBackupStatus, "getBackupStatus");
async function handleAutoSchedule(env, params, user) {
  requireRole(user, "inventory_manager");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const email = safeEmail(params.email), day = safeDay(params.day), when = nowIso();
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "setAutoSchedule", { email, day }), env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('report_email',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(email, when), env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('report_day',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(String(day), when), auditStatement(env.DB, { action: "UPDATE_REPORT_SCHEDULE", entityType: "settings", entityId: "monthly_report", actor: user, before: null, after: { email, day }, reason: "\u6708\u5831\u6392\u7A0B\u8A2D\u5B9A", requestId })]);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    throw e;
  }
  const result = { success: true, message: `\u5DF2\u8A2D\u5B9A\u6BCF\u6708 ${day} \u65E5\u81EA\u52D5\u5BC4\u9001\u81F3 ${email}` };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(handleAutoSchedule, "handleAutoSchedule");
function parseContinuousScanDelay(value) {
  const raw = safeText(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0.1 && seconds <= 60 ? Math.round(seconds * 100) / 100 : null;
}
__name(parseContinuousScanDelay, "parseContinuousScanDelay");
async function getContinuousScanDelaySeconds(db) {
  const value = parseContinuousScanDelay(await getSetting(db, "continuous_scan_delay_seconds"));
  return value === null ? DEFAULT_CONTINUOUS_SCAN_DELAY_SECONDS : value;
}
__name(getContinuousScanDelaySeconds, "getContinuousScanDelaySeconds");
async function getScanSettings(env, user) {
  requireRole(user, "inventory_manager");
  return { success: true, continuousScanDelaySeconds: await getContinuousScanDelaySeconds(env.DB) };
}
__name(getScanSettings, "getScanSettings");
async function handleScanSettings(env, params, user) {
  requireRole(user, "inventory_manager");
  const requestId = requestIdFrom(params), cached = await cachedRequestResponse(env.DB, requestId);
  if (cached) return cached;
  const seconds = parseContinuousScanDelay(params.continuousScanDelaySeconds);
  if (seconds === null) return { success: false, error: "\u6383\u78BC\u9593\u9694\u9808\u70BA 0.10 \u81F3 60 \u79D2\uFF0C\u4E14\u6700\u591A\u5169\u4F4D\u5C0F\u6578" };
  const before = await getContinuousScanDelaySeconds(env.DB), when = nowIso(), value = String(seconds);
  try {
    await env.DB.batch([requestClaimStatement(env.DB, requestId, "setScanSettings", { continuousScanDelaySeconds: seconds }), env.DB.prepare(`INSERT INTO settings(key,value,updated_at) VALUES('continuous_scan_delay_seconds',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(value, when), auditStatement(env.DB, { action: "UPDATE_SCAN_SETTINGS", entityType: "settings", entityId: "continuous_scan_delay_seconds", actor: user, before: { continuousScanDelaySeconds: before }, after: { continuousScanDelaySeconds: seconds }, reason: "\u9023\u7E8C\u9032\u51FA\u5EAB\u6383\u78BC\u9593\u9694\u8A2D\u5B9A", requestId })]);
  } catch (e) {
    if (isDuplicateRequestError(e)) return await cachedRequestResponse(env.DB, requestId) || { success: true };
    throw e;
  }
  const result = { success: true, message: `\u9023\u7E8C\u6383\u78BC\u9593\u9694\u5DF2\u8A2D\u70BA ${value} \u79D2`, settings: { continuousScanDelaySeconds: seconds } };
  await storeRequestResponse(env.DB, requestId, result);
  return result;
}
__name(handleScanSettings, "handleScanSettings");
async function handleManualReport(env, params, user) {
  requireRole(user, "inventory_manager");
  const requestId = requestIdFrom(params), existing = await getRequestRecord(env.DB, requestId);
  if (existing) {
    if (existing.response_json) return await cachedRequestResponse(env.DB, requestId);
    return { success: false, status: 409, error: "\u4E0A\u6B21\u5831\u8868\u5BC4\u9001\u7D50\u679C\u7121\u6CD5\u78BA\u8A8D\u3002\u70BA\u907F\u514D\u91CD\u8907\u5BC4\u9001\uFF0C\u8ACB\u5148\u78BA\u8A8D\u6536\u4EF6\u5323\uFF1B\u82E5\u78BA\u5B9A\u672A\u6536\u5230\uFF0C\u8ACB\u91CD\u65B0\u6309\u5BC4\u9001\u3002" };
  }
  const email = safeEmail(params.email);
  try {
    await requestClaimStatement(env.DB, requestId, "sendManualReport", { email }).run();
  } catch (e) {
    if (isDuplicateRequestError(e)) {
      const duplicate = await getRequestRecord(env.DB, requestId);
      if (duplicate?.response_json) return await cachedRequestResponse(env.DB, requestId);
      return { success: false, status: 409, error: "\u4E0A\u6B21\u5831\u8868\u5BC4\u9001\u7D50\u679C\u7121\u6CD5\u78BA\u8A8D\u3002\u70BA\u907F\u514D\u91CD\u8907\u5BC4\u9001\uFF0C\u8ACB\u5148\u78BA\u8A8D\u6536\u4EF6\u5323\u3002" };
    }
    throw e;
  }
  try {
    const result = await sendFinancialReport(env, false, email);
    await storeRequestResponse(env.DB, requestId, result);
    return result;
  } catch (e) {
    const result = { success: false, error: normalizeError(e) };
    await logSystemEvent(env.DB, "error", "MAIL_FAILURE", result.error, { requestId, action: "sendManualReport", actor: user, context: { email } });
    await storeRequestResponse(env.DB, requestId, result);
    return result;
  }
}
__name(handleManualReport, "handleManualReport");
async function getSetting(db, key) {
  const r = await db.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  return r ? safeText(r.value) : "";
}
__name(getSetting, "getSetting");
async function runScheduledReport(env) {
  try {
    const { year, month, day } = taipeiParts(), reportDay = Number.parseInt(await getSetting(env.DB, "report_day"), 10), email = await getSetting(env.DB, "report_email");
    if (!email || !reportDay || day < reportDay) return;
    const d = new Date(Date.UTC(year, month - 2, 1)), p = taipeiParts(d), periodKey = `${p.year}-${String(p.month).padStart(2, "0")}`, existing = await env.DB.prepare("SELECT status FROM report_runs WHERE period_key=?").bind(periodKey).first();
    if (existing?.status === "sent") return;
    await env.DB.prepare(`INSERT INTO report_runs(period_key,created_at,status,message) VALUES(?,?,'processing','') ON CONFLICT(period_key) DO UPDATE SET created_at=excluded.created_at,status='processing',message=''`).bind(periodKey, nowIso()).run();
    try {
      const result = await sendFinancialReport(env, true, email);
      await env.DB.prepare(`UPDATE report_runs SET status='sent',message=? WHERE period_key=?`).bind(result.message || "sent", periodKey).run();
    } catch (e) {
      await env.DB.prepare(`UPDATE report_runs SET status='error',message=? WHERE period_key=?`).bind(normalizeError(e), periodKey).run();
      await logSystemEvent(env.DB, "error", "SCHEDULED_MAIL_FAILURE", normalizeError(e), { action: "scheduledReport", context: { periodKey } });
      throw e;
    }
  } catch (e) {
    console.error("Scheduled report failed", e);
  }
}
__name(runScheduledReport, "runScheduledReport");
async function runDailyMaintenance(env) {
  try {
    const today = taipeiDateOnly(), when = nowIso(), counts = await env.DB.batch([env.DB.prepare("SELECT COUNT(*) c FROM items"), env.DB.prepare("SELECT COUNT(*) c FROM inventory_batches"), env.DB.prepare("SELECT COUNT(*) c FROM stock_balances"), env.DB.prepare("SELECT COUNT(*) c FROM transactions")]);
    const c = counts.map((x) => Number(x.results?.[0]?.c) || 0);
    await env.DB.batch([env.DB.prepare(`INSERT INTO backup_checkpoints(checkpoint_date,created_at,item_count,batch_count,balance_count,transaction_count,status,note) VALUES(?,?,?,?,?,?,'ok','D1 Time Travel \u81EA\u52D5\u4FDD\u8B77\uFF1B\u6B64\u5217\u70BA\u5065\u5EB7\u6AA2\u67E5\u9EDE') ON CONFLICT(checkpoint_date) DO UPDATE SET created_at=excluded.created_at,item_count=excluded.item_count,batch_count=excluded.batch_count,balance_count=excluded.balance_count,transaction_count=excluded.transaction_count,status='ok'`).bind(today, when, c[0], c[1], c[2], c[3]), env.DB.prepare(`DELETE FROM request_results WHERE created_at < datetime('now','-30 day')`), env.DB.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).bind(when), env.DB.prepare(`DELETE FROM system_logs WHERE created_at < datetime('now','-90 day')`), env.DB.prepare(`DELETE FROM backup_checkpoints WHERE checkpoint_date < date('now','-90 day')`), env.DB.prepare(`DELETE FROM auth_rate_limits WHERE updated_at < datetime('now','-1 day')`)]);
  } catch (e) {
    console.error("Daily maintenance failed", e);
    try {
      await logSystemEvent(env.DB, "error", "MAINTENANCE_FAILURE", normalizeError(e), { action: "dailyMaintenance" });
    } catch {
    }
  }
}
__name(runDailyMaintenance, "runDailyMaintenance");
function monthRange(isAuto) {
  const now = /* @__PURE__ */ new Date(), tp = taipeiParts(now);
  let year = tp.year, month = tp.month;
  if (isAuto) {
    month--;
    if (month === 0) {
      month = 12;
      year--;
    }
  }
  const start = /* @__PURE__ */ new Date(`${year}-${String(month).padStart(2, "0")}-01T00:00:00+08:00`);
  let end;
  if (isAuto) {
    const ny = month === 12 ? year + 1 : year, nm = month === 12 ? 1 : month + 1;
    end = /* @__PURE__ */ new Date(`${ny}-${String(nm).padStart(2, "0")}-01T00:00:00+08:00`);
  } else end = new Date(now.getTime() + 1e3);
  return { year, month, startIso: start.toISOString(), endIso: end.toISOString() };
}
__name(monthRange, "monthRange");
function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[ch]);
}
__name(escapeHtml, "escapeHtml");
async function buildFinancialReport(env, isAuto) {
  const range = monthRange(isAuto), tx = await env.DB.prepare(`SELECT created_at,type,item_id,name,qty,price,user_name,note,reason,location_name FROM transactions WHERE created_at>=? AND created_at<? ORDER BY created_at DESC`).bind(range.startIso, range.endIso).all(), inv = await env.DB.prepare(`SELECT i.item_id,i.name,i.min_qty,i.default_price AS price,b.lot,b.expiry,s.qty,COALESCE(NULLIF(s.note,''),b.note) note,l.name location_name FROM items i JOIN inventory_batches b ON b.item_id=i.item_id JOIN stock_balances s ON s.batch_id=b.batch_id JOIN locations l ON l.location_id=s.location_id WHERE i.is_active=1 ORDER BY i.name,b.expiry`).all();
  let inboundCost = 0, outboundCost = 0, inboundCount = 0, outboundCount = 0, disposalCount = 0, returnCount = 0, inventoryValue = 0;
  const txRows = [];
  for (const row of tx.results || []) {
    const q = Number(row.qty) || 0, p = Number(row.price) || 0, total = q * p;
    if (row.type === "\u5165\u5EAB") {
      inboundCost += total;
      inboundCount += q;
    }
    if (row.type === "\u9818\u7528") {
      outboundCost += total;
      outboundCount += q;
    }
    if (row.type === "\u5831\u5EE2") disposalCount += q;
    if (row.type === "\u9000\u8CA8") returnCount += q;
    txRows.push(`<tr><td>${escapeHtml(taipeiDateTime(new Date(row.created_at)).slice(5, 16))}</td><td>${escapeHtml(row.type)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.location_name || "")}</td><td style="text-align:right">${q}</td><td style="text-align:right">NT$ ${Math.round(total).toLocaleString("zh-TW")}</td><td>${escapeHtml(row.user_name || "")}</td></tr>`);
  }
  const totals = /* @__PURE__ */ new Map(), expiring = [], today = taipeiDateOnly(), future = addDaysYmd(today, 30);
  for (const row of inv.results || []) {
    const q = Number(row.qty) || 0, p = Number(row.price) || 0, min = Number(row.min_qty) || 0;
    if (q > 0) inventoryValue += q * p;
    if (!totals.has(row.item_id)) totals.set(row.item_id, { name: safeName(row.item_id, row.name), qty: 0, min });
    const t = totals.get(row.item_id);
    t.qty += q;
    t.min = min;
    if (q > 0 && row.expiry && row.expiry >= today && row.expiry <= future) expiring.push(row);
  }
  const low = [...totals.values()].filter((x) => x.qty <= x.min), title = `${range.year}\u5E74${String(range.month).padStart(2, "0")}\u6708${isAuto ? " \u5EAB\u5B58\u8207\u82B1\u8CBB\u7D50\u7B97\u6708\u5831" : " \u8FC4\u4ECA\u5EAB\u5B58\u8207\u82B1\u8CBB\u8A66\u7B97\u5831\u544A"}`;
  const html = `<!doctype html><html><body style="font-family:Arial,'Noto Sans TC',sans-serif;background:#f8fafc;color:#0f172a;padding:20px"><div style="max-width:800px;margin:auto;background:white;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden"><div style="background:#0f172a;color:white;padding:24px;text-align:center"><h2 style="margin:0">\u{1F4CA} \u5C71\u77F3\u8A3A\u6240\uFF5C${escapeHtml(title)}</h2></div><div style="padding:22px"><h3>\u4E00\u3001\u672C\u671F\u82B1\u8CBB\u8207\u5EAB\u5B58\u7E3D\u89BD</h3><p>\u9032\u8CA8\u7E3D\u984D\uFF1A<b style="color:#047857">NT$ ${Math.round(inboundCost).toLocaleString("zh-TW")}</b>\uFF08${inboundCount} \u4EF6\uFF09</p><p>\u9818\u7528\u6210\u672C\uFF1A<b style="color:#b91c1c">NT$ ${Math.round(outboundCost).toLocaleString("zh-TW")}</b>\uFF08${outboundCount} \u4EF6\uFF09</p><p>\u5831\u5EE2\uFF1A<b>${disposalCount}</b> \u4EF6\uFF5C\u9000\u8CA8\uFF1A<b>${returnCount}</b> \u4EF6</p><p>\u76EE\u524D\u5EAB\u5B58\u7E3D\u50F9\u503C\uFF1A<b style="color:#0369a1">NT$ ${Math.round(inventoryValue).toLocaleString("zh-TW")}</b></p><h3>\u4E8C\u3001\u6548\u671F\u8207\u5B89\u5168\u5EAB\u5B58\u63D0\u9192</h3><div><b>30 \u65E5\u5167\u5230\u671F\uFF1A</b>${expiring.length ? `<ul>${expiring.map((r) => `<li>${escapeHtml(r.name)}\uFF5C${escapeHtml(r.location_name)}\uFF5C\u6279\u865F ${escapeHtml(r.lot || "\u7121")}\uFF5C${r.qty} \u4EF6\uFF5C${escapeHtml(r.expiry)}${r.note ? `\uFF5C${escapeHtml(r.note)}` : ""}</li>`).join("")}</ul>` : " \u7121"}</div><div><b>\u4F4E\u5EAB\u5B58\uFF1A</b>${low.length ? `<ul>${low.map((v) => `<li>${escapeHtml(v.name)}\uFF5C\u5269\u9918 ${v.qty}\uFF5C\u9580\u6ABB ${v.min}</li>`).join("")}</ul>` : " \u7121"}</div><h3>\u4E09\u3001\u672C\u671F\u7570\u52D5\u660E\u7D30</h3><div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr><th>\u6642\u9593</th><th>\u52D5\u4F5C</th><th>\u54C1\u540D</th><th>\u5132\u4F4D</th><th>\u6578\u91CF</th><th>\u91D1\u984D</th><th>\u8655\u7406\u4EBA</th></tr></thead><tbody>${txRows.join("") || '<tr><td colspan="7">\u672C\u671F\u7121\u7570\u52D5\u7D00\u9304</td></tr>'}</tbody></table></div><p style="color:#94a3b8;font-size:12px;text-align:center;margin-top:24px">\u6B64\u5831\u8868\u7531 Arenastone Commercial D1 v4 \u81EA\u52D5\u7522\u751F\u3002</p></div></div></body></html>`;
  return { title, html };
}
__name(buildFinancialReport, "buildFinancialReport");
async function sendFinancialReport(env, isAuto, targetEmail) {
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) throw new Error("\u5C1A\u672A\u8A2D\u5B9A\u514D\u8CBB\u90F5\u4EF6\u670D\u52D9\u3002\u8ACB\u5728 Cloudflare Worker \u8A2D\u5B9A BREVO_API_KEY \u8207 BREVO_SENDER_EMAIL\u3002");
  const report = await buildFinancialReport(env, isAuto), senderName = env.BREVO_SENDER_NAME || "\u5C71\u77F3\u8A3A\u6240\u667A\u6167\u5EAB\u5B58", response = await fetch("https://api.brevo.com/v3/smtp/email", { method: "POST", headers: { "api-key": env.BREVO_API_KEY, "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ sender: { name: senderName, email: env.BREVO_SENDER_EMAIL }, to: [{ email: targetEmail }], subject: `\u{1F4CA} [\u5C71\u77F3\u8A3A\u6240] ${report.title}`, htmlContent: report.html }) });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`\u90F5\u4EF6\u670D\u52D9\u56DE\u50B3 ${response.status}: ${text.slice(0, 300)}`);
  }
  return { success: true, message: `\u5831\u8868\u5DF2\u6210\u529F\u767C\u9001\u81F3 ${targetEmail}` };
}
__name(sendFinancialReport, "sendFinancialReport");
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
