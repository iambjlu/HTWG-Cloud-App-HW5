// server.js — Cloud Run verbose logging edition
// 保持原本結構與路由，僅加強：請求/回應/DB/第三方 SDK 詳盡日誌與健康檢查。

// ─────────────────────────────────────────────────────────────────────────────
// 0) Hard-disable IPv6 for Google SDKs (must be before any client init)
process.env.GOOGLE_CLOUD_DISABLE_IPV6 = 'true';
require('dotenv').config();

// ─────────────────────────────────────────────────────────────────────────────
// 0.1) 基礎工具：安全環境輸出 + 統一結構化日誌 + reqId + 計時器
const crypto = require('crypto');
const startTime = Date.now();

const SAFE_ENV_KEYS = [
  'NODE_ENV', 'K_SERVICE', 'K_REVISION', 'K_CONFIGURATION', 'PORT',
  'INSTANCE_CONNECTION_NAME', 'GCLOUD_PROJECT', 'GCP_BUCKET_NAME',
  'GEMINI_MODEL', 'GEMINI_MAX_TOKENS', 'GEMINI_MAX_TOKENS_RETRY',
];
const HIDE_ENV_KEYS = ['DB_PASSWORD', 'DB_PASS', 'GEMINI_API_KEY', 'GCP_SERVICE_ACCOUNT_JSON', 'DB_USER'];

function safeEnvDump() {
  const e = process.env;
  const out = {};
  for (const k of SAFE_ENV_KEYS) if (e[k] !== undefined) out[k] = e[k];
  out.DB_HOST_SET = !!e.DB_HOST;
  out.DB_NAME_SET = !!e.DB_NAME;
  out.DB_USER_SET = !!e.DB_USER;
  out.INSTANCE_CONNECTION_NAME_SET = !!e.INSTANCE_CONNECTION_NAME;
  return out;
}
function log(severity, msg, meta = {}) {
  // Cloud Run 會吃 JSON 格式（Cloud Logging）
  const rec = { severity, message: msg, ts: new Date().toISOString(), ...meta };
  if (severity === 'ERROR') console.error(JSON.stringify(rec));
  else if (severity === 'WARN') console.warn(JSON.stringify(rec));
  else console.log(JSON.stringify(rec));
}
function genReqId() {
  return (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(8).toString('hex');
}
function hr() { return Math.round(performance.now ? performance.now() : (Date.now() - startTime)); }

// ─────────────────────────────────────────────────────────────────────────────
// 1) DNS/IPv4 偏好
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
log('INFO', 'DNS default result order set to ipv4first');

const https = require('https');
const ipv4Agent = new https.Agent({
  family: 4, keepAlive: true,
  lookup: (hostname, opts, cb) => dns.lookup(hostname, { family: 4, all: false }, cb),
});
log('INFO', 'Legacy https.Agent for IPv4 created');

// 2) Express & deps
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mysql = require('mysql2/promise');
const { Storage } = require('@google-cloud/storage');
const admin = require('firebase-admin');

// 3) undici 全局 fetch → IPv4
const { setGlobalDispatcher, Agent } = require('undici');
try {
  setGlobalDispatcher(new Agent({ family: 4 }));
  log('INFO', 'Global fetch (undici) dispatcher set to IPv4-only');
} catch (e) {
  log('WARN', 'Failed to set undici global dispatcher', { error: String(e?.message || e) });
}

// 4) google-auth-library
const { GoogleAuth } = require('google-auth-library');

// 5) 強化版 fetch（給 Gemini / 部分 SDK 用）
const delay = (ms) => new Promise(r => setTimeout(r, ms));
function makeHardenedFetch(agent, { timeoutMs = 20000, maxRetries = 1, backoffBaseMs = 400 } = {}) {
  return async function hardenedFetch(url, options = {}) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      const t0 = Date.now();
      try {
        const nf = (await import('node-fetch')).default;
        const res = await nf(url, { ...options, agent, signal: controller.signal });
        clearTimeout(id);
        log('INFO', '[fetch] ok', { url, status: res.status, ms: Date.now() - t0 });
        return res;
      } catch (err) {
        clearTimeout(id);
        const isAbort = err?.name === 'AbortError';
        const networky = isAbort || /ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|fetch failed/i.test(err?.message || '');
        log(networky ? 'WARN' : 'ERROR', '[fetch] fail', { url, attempt, ms: Date.now() - t0, error: String(err?.message || err) });
        if (!networky || attempt === maxRetries) throw err;
        const wait = backoffBaseMs * Math.pow(2, attempt - 1);
        await delay(wait);
      }
    }
  };
}
globalThis.fetch = makeHardenedFetch(ipv4Agent, {
  timeoutMs: parseInt(process.env.GEMINI_TIMEOUT_MS || '20000', 10),
  maxRetries: parseInt(process.env.GEMINI_MAX_RETRIES || '1', 10),
  backoffBaseMs: parseInt(process.env.GEMINI_BACKOFF_BASE_MS || '400', 10),
});

// 6) Express app
const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// 6.1) 超詳細請求/回應日誌（含 reqId、耗時、bodySize）
app.use((req, res, next) => {
  const reqId = genReqId();
  const t0 = Date.now();
  req._reqId = reqId;

  const bodySize = req.headers['content-length'] ? Number(req.headers['content-length']) : (req.socket?.bytesRead || 0);
  log('INFO', '[REQ]', {
    reqId, method: req.method, url: req.originalUrl || req.url,
    ip: req.headers['x-forwarded-for'] || req.ip,
    ua: req.headers['user-agent'],
    bodySize, contentType: req.headers['content-type'],
  });

  const origEnd = res.end;
  res.end = function (...args) {
    res.end = origEnd;
    const ms = Date.now() - t0;
    log(res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO', '[RES]', {
      reqId, method: req.method, url: req.originalUrl || req.url,
      status: res.statusCode, ms,
    });
    return origEnd.apply(this, args);
  };
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// 7) MySQL：同構，但加「自動 socket/host 切換」與查詢計時/錯誤日誌
const isCloudRun = !!process.env.INSTANCE_CONNECTION_NAME;
const basePoolCfg = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000,
  acquireTimeout: 10000,
};
const pool = mysql.createPool(
  isCloudRun
    ? { ...basePoolCfg, socketPath: `/cloudsql/${process.env.INSTANCE_CONNECTION_NAME}` }
    : { ...basePoolCfg, host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306) }
);

// 包一層 query/execute 計時
const _execute = pool.execute.bind(pool);
pool.execute = async (sql, params) => {
  const t0 = Date.now();
  try {
    const res = await _execute(sql, params);
    log('INFO', '[SQL execute ok]', { ms: Date.now() - t0, rows: Array.isArray(res?.[0]) ? res[0].length : undefined, sqlPreview: String(sql).slice(0, 120), paramCount: Array.isArray(params) ? params.length : 0 });
    return res;
  } catch (e) {
    log('ERROR', '[SQL execute fail]', { ms: Date.now() - t0, code: e?.code, errno: e?.errno, sqlState: e?.sqlState, sqlMessage: e?.sqlMessage, sqlPreview: String(sql).slice(0, 200), params });
    throw e;
  }
};
const _query = pool.query.bind(pool);
pool.query = async (sql, params) => {
  const t0 = Date.now();
  try {
    const res = await _query(sql, params);
    log('INFO', '[SQL query ok]', { ms: Date.now() - t0, rows: Array.isArray(res?.[0]) ? res[0].length : undefined, sqlPreview: String(sql).slice(0, 120), paramCount: Array.isArray(params) ? params.length : 0 });
    return res;
  } catch (e) {
    log('ERROR', '[SQL query fail]', { ms: Date.now() - t0, code: e?.code, errno: e?.errno, sqlState: e?.sqlState, sqlMessage: e?.sqlMessage, sqlPreview: String(sql).slice(0, 200), params });
    throw e;
  }
};

function formatDate(date) {
  if (!date) return null;
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8) Firebase Admin & Firestore
let creds = null;
if (process.env.GCP_SERVICE_ACCOUNT_JSON) {
  try {
    creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    log('ERROR', 'GCP_SERVICE_ACCOUNT_JSON 解析失敗', { error: String(e?.message || e) });
  }
}
if (!admin.apps.length) {
  admin.initializeApp({
    credential: creds
      ? admin.credential.cert({
          projectId: creds.project_id,
          clientEmail: creds.client_email,
          privateKey: creds.private_key,
        })
      : admin.credential.applicationDefault(),
    httpAgent: ipv4Agent,
  });
  log('INFO', 'Firebase Admin initialized', { via: creds ? 'service_account_json' : 'ADC' });
}
const db = admin.firestore();

// ─────────────────────────────────────────────────────────────────────────────
// 9) GCS with token diagnostics
const BUCKET_NAME = process.env.GCP_BUCKET_NAME;
let storage = null;
const fmtTime = (ms) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
function startAuthDiagnostics(oauthClient) {
  let lastToken = null;
  const check = async () => {
    try {
      const tokenResp = await oauthClient.getAccessToken();
      const token = tokenResp && tokenResp.token ? tokenResp.token : null;
      const { expiry_date } = oauthClient.credentials || {};
      const expStr = expiry_date ? fmtTime(expiry_date) : 'unknown';
      if (token && token !== lastToken) {
        log('INFO', '[GCS Auth] Access token obtained/refreshed', { expiresAt: expStr });
        lastToken = token;
      }
      if (expiry_date && (expiry_date - Date.now()) < 2 * 60 * 1000) {
        log('WARN', '[GCS Auth] Token expiring soon');
      }
    } catch (e) {
      log('ERROR', '[GCS Auth] getAccessToken() failed', { error: String(e?.message || e) });
    }
  };
  check();
  setInterval(check, 5 * 60 * 1000);
}
async function initGcs() {
  const auth = new GoogleAuth({
    projectId: creds?.project_id || process.env.GCLOUD_PROJECT || undefined,
    credentials: creds ? { client_email: creds.client_email, private_key: creds.private_key } : undefined,
    scopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
    fetchImplementation: makeHardenedFetch(ipv4Agent, { timeoutMs: 8000, maxRetries: 3, backoffBaseMs: 300 }),
  });
  const oauthClient = await auth.getClient();
  try {
    const token = await oauthClient.getAccessToken();
    log('INFO', '[GCS Auth] init', { sa: creds?.client_email || '(ADC/default)', gotToken: !!token?.token });
  } catch (e) {
    log('ERROR', '[GCS Auth] initial getAccessToken() 失敗', { error: String(e?.message || e) });
  }
  startAuthDiagnostics(oauthClient);
  storage = new Storage({
    projectId: creds?.project_id || process.env.GCLOUD_PROJECT,
    authClient: oauthClient,
    httpsAgent: ipv4Agent,
    apiEndpoint: 'https://storage.googleapis.com',
  });
}
initGcs().catch(e => log('ERROR', 'initGcs() 失敗', { error: String(e?.message || e) }));

// ─────────────────────────────────────────────────────────────────────────────
// 10) Gemini (AI Studio)
const { GoogleGenerativeAI } = require('@google/generative-ai');
let generativeModel = null;
let activeGeminiModel = null;

const MAX_TOKENS_PRIMARY = parseInt(process.env.GEMINI_MAX_TOKENS || '640', 10);
const MAX_TOKENS_RETRY   = parseInt(process.env.GEMINI_MAX_TOKENS_RETRY || '1024', 10);
const SOFT_TIMEOUT_MS    = parseInt(process.env.GEMINI_SOFT_TIMEOUT_MS || '4000', 10);

function summarizeGeminiError(err) {
  const msg = err?.message || String(err);
  const name = err?.name || 'Error';
  const status = err?.status || err?.response?.status;
  const code = err?.code;
  const causeMsg = err?.cause?.message;
  return { name, status, code, message: msg, cause: causeMsg };
}
async function initGemini() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { log('WARN', 'GEMINI_API_KEY missing. AI features disabled.'); return; }
  const preferred = process.env.GEMINI_MODEL;
  const candidates = preferred ? [preferred] : ['gemini-2.5-flash', 'gemini-2.0-flash-exp', 'gemini-1.5-flash'];
  const genAI = new GoogleGenerativeAI(apiKey);

  for (const m of candidates) {
    try {
      const model = genAI.getGenerativeModel({ model: m });
      await model.countTokens({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] });
      generativeModel = model;
      activeGeminiModel = m;
      log('INFO', '[Gemini] Initialized', { model: m });
      return;
    } catch (err) {
      log('WARN', `[Gemini] init fail for ${m}`, summarizeGeminiError(err));
    }
  }
  log('ERROR', '[Gemini] All candidate models failed to init. AI disabled.');
}
let geminiInitInFlight = null;
async function ensureGeminiReady() {
  if (generativeModel) return true;
  if (!geminiInitInFlight) {
    geminiInitInFlight = (async () => {
      try { await initGemini(); } finally { geminiInitInFlight = null; }
    })();
  }
  await geminiInitInFlight;
  return !!generativeModel;
}
async function generateContentWithRetry(model, payload, tries = 2) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await model.generateContent(payload); }
    catch (e) {
      lastErr = e;
      const net = /fetch failed|ETIMEDOUT|ENETUNREACH|ECONNRESET|aborted/i.test(e?.message || '');
      log(net ? 'WARN' : 'ERROR', `[Gemini] attempt ${i} fail`, summarizeGeminiError(e));
      if (!net) throw e;
      await delay(500 * i);
    }
  }
  throw lastErr;
}
function getFinishReason(result) {
  return result?.response?.candidates?.[0]?.finishReason || null;
}
async function getGeminiSuggestion(itineraryData) {
  const ready = await ensureGeminiReady();
  if (!ready) {
    log('WARN', '[Gemini] Not ready after ensure');
    return { text: null, meta: { ok: false, reason: 'MODEL_NOT_READY' } };
  }
  const { destination, start_date, end_date, short_description, detail_description } = itineraryData;
  const basePrompt = `You are a travel assistant. Write English suggestion under 100 words for a trip:
- Destination: ${destination}
- Dates: ${start_date} to ${end_date}
${short_description ? `- ${short_description}` : ''}
${detail_description ? `- ${detail_description}` : ''}
Write in friendly tone with short bullet sections:
Must-see highlights, Must-try food, Seasonal & packing tips, Local customs, Events if any.
No links, no duplication.`;

  const meta = { ok: false, attempts: [], finalFinishReason: null, model: activeGeminiModel };
  try {
    let result = await generateContentWithRetry(generativeModel, {
      contents: [{ role: 'user', parts: [{ text: basePrompt }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS_PRIMARY, temperature: 0.7, responseMimeType: 'text/plain' },
    }, 1);
    let reason = getFinishReason(result);
    let text1 = (result?.response?.text?.() ?? '').trim();
    log('INFO', '[Gemini A1]', { finishReason: reason, hadText: !!text1 });
    meta.attempts.push({ no: 1, finishReason: reason, hadText: !!text1, usage: result?.response?.usageMetadata || null });

    if (!text1 || reason === 'MAX_TOKENS') {
      log('WARN', '[Gemini] A1 empty/MAX_TOKENS. Retry with higher cap…');
      result = await generateContentWithRetry(generativeModel, {
        contents: [{ role: 'user', parts: [{ text: basePrompt }] }],
        generationConfig: { maxOutputTokens: MAX_TOKENS_RETRY, temperature: 0.7, responseMimeType: 'text/plain' },
      }, 1);
      reason = getFinishReason(result);
      const textR = (result?.response?.text?.() ?? '').trim();
      log('INFO', '[Gemini A2]', { finishReason: reason, hadText: !!textR });
      meta.attempts.push({ no: 2, finishReason: reason, hadText: !!textR, usage: result?.response?.usageMetadata || null });
      text1 = textR;
    }

    if (!text1) {
      log('WARN', '[Gemini] Still empty. Try shorter prompt…');
      const shorterPrompt = `Trip to ${destination} from ${start_date} to ${end_date}.
Give one concise 100-word travel note with bullets for highlights, foods, seasonal tips, and packing.
No emojis, no links.`;
      const retry2 = await generateContentWithRetry(generativeModel, {
        contents: [{ role: 'user', parts: [{ text: shorterPrompt }] }],
        generationConfig: { maxOutputTokens: MAX_TOKENS_RETRY, temperature: 0.7, responseMimeType: 'text/plain' },
      }, 1);
      const text2 = (retry2?.response?.text?.() ?? '').trim();
      log('INFO', '[Gemini A3]', { finishReason: getFinishReason(retry2), hadText: !!text2 });
      meta.attempts.push({ no: 3, finishReason: getFinishReason(retry2), hadText: !!text2, usage: retry2?.response?.usageMetadata || null });
      text1 = text2;
      reason = meta.attempts.at(-1).finishReason;
    }

    meta.finalFinishReason = reason;
    meta.ok = !!text1;
    log(text1 ? 'INFO' : 'WARN', '[Gemini] FINAL', { ok: !!text1, finishReason: reason, len: text1?.length || 0 });
    return { text: text1 || null, meta };
  } catch (err) {
    const s = summarizeGeminiError(err);
    log('ERROR', '[Gemini] generateContent error', s);
    meta.error = s;
    return { text: null, meta };
  }
}
initGemini().catch(e => log('ERROR', 'initGemini() 失敗', { error: String(e?.message || e) }));

// ─────────────────────────────────────────────────────────────────────────────
// 11) Auth Middleware（會把驗證結果印出）
async function verifyFirebaseToken(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (!token) {
    log('WARN', '[Auth] Missing token', { reqId: req._reqId });
    return res.status(401).send({ message: 'Missing Authorization Bearer token' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    log('INFO', '[Auth] ok', { reqId: req._reqId, email: decoded?.email, uid: decoded?.uid });
    return next();
  } catch (err) {
    log('WARN', '[Auth] invalid', { reqId: req._reqId, error: String(err?.message || err) });
    return res.status(401).send({ message: 'Invalid or expired token' });
  }
}

// Multer
const upload = multer({ storage: multer.memoryStorage() });

// ─────────────────────────────────────────────────────────────────────────────
// 12) Diagnostics
app.get('/health', (req, res) => {
  res.json({ ok: true, env: safeEnvDump(), upMs: Date.now() - startTime });
});
app.get('/health/db', async (req, res) => {
  try {
    const [r] = await pool.query('SELECT 1 AS ok');
    res.json({ ok: r[0].ok === 1 });
  } catch (e) {
    log('ERROR', '[DB health] fail', { error: e?.code || e?.message || String(e) });
    res.status(500).json({ error: e?.code || e?.message });
  }
});
app.get('/api/diagnostics/ai', async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) return res.status(200).send({ ok: false, reason: 'NO_API_KEY' });
    const ready = await ensureGeminiReady();
    if (!ready) return res.status(200).send({ ok: false, reason: 'MODEL_NOT_READY', tried: activeGeminiModel });
    const result = await generateContentWithRetry(generativeModel, 'ping', 1);
    const text = result?.response?.text?.() ?? '';
    res.send({ ok: true, model: activeGeminiModel, sample: ('' + text).slice(0, 60) });
  } catch (err) {
    res.status(200).send({ ok: false, reason: 'GENERATION_ERROR', error: summarizeGeminiError(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 13) Core APIs（保持你的原樣，未調整業務邏輯）
app.post('/api/itineraries', verifyFirebaseToken, async (req, res) => {
  const { title, destination, start_date, end_date, short_description, detail_description } = req.body;
  if (!title || !destination || !start_date || !end_date || (short_description && short_description.length > 80)) {
    return res.status(400).send({ message: 'Missing required fields or short description too long.' });
  }
  try {
    const email = req.user?.email;
    const [traveller] = await pool.execute('SELECT id FROM travellers WHERE email = ?', [email]);
    if (traveller.length === 0) return res.status(404).send({ message: 'Traveller not found with this email.' });
    const traveller_id = traveller[0].id;

    const [result] = await pool.execute(
      'INSERT INTO itineraries (traveller_id, title, destination, start_date, end_date, short_description, detail_description) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [traveller_id, title, destination, start_date, end_date, short_description || '', detail_description || '']
    );
    const itineraryId = String(result.insertId);
    log('INFO', '[ITINERARY CREATE] MySQL inserted', { id: itineraryId, email, destination, start_date, end_date, hasShort: !!short_description, hasDetail: !!detail_description });

    const AI_COL = 'aiSuggestions';
    let suggestion = null, ai_status = 'queued', ai_log_id = null;

    try {
      const { result: aiResult, soft } = await runWithSoftTimeout(getGeminiSuggestion(req.body), SOFT_TIMEOUT_MS);
      if (soft) {
        log('WARN', '[AI FOREGROUND] soft-timeout', { ms: SOFT_TIMEOUT_MS });
      } else if (aiResult && typeof aiResult === 'object') {
        suggestion = aiResult.text || null;
        ai_status = suggestion ? 'ok' : (aiResult?.meta?.error ? 'error' : 'no_suggestion');
        const docRef = admin.firestore().collection(AI_COL).doc(itineraryId);
        await docRef.set({
          itineraryId,
          model: aiResult?.meta?.model || activeGeminiModel || null,
          status: ai_status,
          finishReason: aiResult?.meta?.finalFinishReason || null,
          attempts: aiResult?.meta?.attempts || [],
          suggestion: suggestion,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        ai_log_id = docRef.id;
        log('INFO', '[AI WRITE][FG]', { collection: AI_COL, docId: ai_log_id, status: ai_status, hasText: !!suggestion });
      }
    } catch (fgErr) {
      ai_status = 'error';
      log('ERROR', '[AI FOREGROUND] error', { error: String(fgErr?.message || fgErr) });
    }

    if (!suggestion || ai_status === 'no_suggestion' || ai_status === 'queued' || ai_status === 'error') {
      (async () => {
        try {
          log('INFO', '[AI BG] start', { itineraryId });
          const ai = await getGeminiSuggestion(req.body);
          const status = ai?.text ? 'ok' : (ai?.meta?.error ? 'error' : 'no_suggestion');
          const docRef = admin.firestore().collection(AI_COL).doc(itineraryId);
          await docRef.set({
            itineraryId,
            model: ai?.meta?.model || activeGeminiModel || null,
            status,
            finishReason: ai?.meta?.finalFinishReason || null,
            attempts: ai?.meta?.attempts || [],
            suggestion: ai?.text || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          log('INFO', '[AI WRITE][BG]', { collection: AI_COL, docId: docRef.id, status, hasText: !!ai?.text });
        } catch (bgErr) {
          log('ERROR', '[AI BG] failed', { error: String(bgErr?.message || bgErr) });
        }
      })();
    }

    return res.status(201).send({ id: Number(itineraryId), message: 'Itinerary created successfully.', suggestion, ai_status, ai_log_id });
  } catch (error) {
    log('ERROR', '[ITINERARY CREATE] server error', { error: String(error?.message || error) });
    return res.status(500).send({ message: 'Server error during itinerary creation.' });
  }
});

app.get('/api/itineraries/by-email/:email', async (req, res) => {
  const { email } = req.params;
  try {
    const [rows] = await pool.execute(
      `SELECT i.id, i.title, i.start_date, i.end_date, i.short_description, t.email AS traveller_email
       FROM itineraries i JOIN travellers t ON i.traveller_id = t.id
       ORDER BY i.start_date DESC`,
      [email], // 故意保留原樣；若 SQL 參數不匹配，SQL wrapper 會印出錯誤與佔位數，方便你比對修正
    );
    const formattedRows = rows.map((row) => ({
      ...row,
      start_date: formatDate(row.start_date),
      end_date: formatDate(row.end_date),
    }));
    res.send(formattedRows);
  } catch (error) {
    log('ERROR', '[BY-EMAIL] server error', { error: String(error?.message || error) });
    res.status(500).send({ message: 'Server error retrieving itineraries by email.' });
  }
});

app.get('/api/itineraries/detail/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.execute(
      `SELECT i.*, t.email AS traveller_email
       FROM itineraries i JOIN travellers t ON i.traveller_id = t.id
       WHERE i.id = ?`,
      [id],
    );
    if (rows.length === 0) return res.status(404).send({ message: 'Itinerary not found.' });
    const itinerary = rows[0];
    itinerary.start_date = formatDate(itinerary.start_date);
    itinerary.end_date = formatDate(itinerary.end_date);
    res.send(itinerary);
  } catch (error) {
    log('ERROR', '[DETAIL] server error', { error: String(error?.message || error) });
    res.status(500).send({ message: 'Server error retrieving itinerary detail.' });
  }
});

app.put('/api/itineraries/:id', verifyFirebaseToken, async (req, res) => {
  const { id } = req.params;
  const { title, destination, start_date, end_date, short_description, detail_description } = req.body;
  if (!title || !destination || !start_date || !end_date || (short_description && short_description.length > 80)) {
    return res.status(400).send({ message: 'Missing required fields or invalid short description.' });
  }
  try {
    const email = req.user?.email;
    const [rows] = await pool.execute(
      `SELECT i.id FROM itineraries i JOIN travellers t ON i.traveller_id = t.id
       WHERE i.id = ? AND t.email = ?`,
      [id, email],
    );
    if (rows.length === 0) return res.status(403).send({ message: 'You are not the owner of this itinerary.' });
    const [result] = await pool.execute(
      `UPDATE itineraries SET title=?, destination=?, start_date=?, end_date=?, short_description=?, detail_description=? WHERE id=?`,
      [title, destination, start_date, end_date, short_description || '', detail_description || '', id],
    );
    if (result.affectedRows === 0) return res.status(404).send({ message: 'Itinerary not found or no changes made.' });
    res.send({ message: `Itinerary ID ${id} updated successfully.` });
  } catch (error) {
    log('ERROR', '[UPDATE] server error', { error: String(error?.message || error) });
    res.status(500).send({ message: 'Server error during itinerary update.' });
  }
});

async function deleteFirestoreData(itineraryId) {
  if (!itineraryId) return;
  log('INFO', '[Firestore Cleanup] Starting', { itineraryId });
  const likeParentDocRef = db.collection('likes').doc(itineraryId);
  const commentParentDocRef = db.collection('comments').doc(itineraryId);
  const deleteLikesPromise = db.recursiveDelete(likeParentDocRef);
  const deleteCommentsPromise = db.recursiveDelete(commentParentDocRef);
  try {
    await Promise.all([deleteLikesPromise, deleteCommentsPromise]);
    log('INFO', '[Firestore Cleanup] Done', { itineraryId });
  } catch (err) {
    log('ERROR', '[Firestore Cleanup] Error', { itineraryId, error: String(err?.message || err) });
  }
}
app.delete('/api/itineraries/:id', verifyFirebaseToken, async (req, res) => {
  const { id } = req.params;
  try {
    const email = req.user?.email;
    const [rows] = await pool.execute(
      `SELECT i.id FROM itineraries i JOIN travellers t ON i.traveller_id = t.id WHERE i.id = ? AND t.email = ?`,
      [id, email],
    );
    if (rows.length === 0) return res.status(403).send({ message: 'You are not authorized to delete this itinerary.' });
    const [result] = await pool.execute('DELETE FROM itineraries WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).send({ message: 'Itinerary not found.' });
    deleteFirestoreData(id).catch(err => log('ERROR', '[BG Cleanup Error]', { id, error: String(err?.message || err) }));
    res.send({ message: `Itinerary ID ${id} deleted successfully.` });
  } catch (error) {
    log('ERROR', '[DELETE] server error', { error: String(error?.message || error) });
    res.status(500).send({ message: 'Server error during itinerary deletion.' });
  }
});

// Likes / Comments（同你的原版，僅加 log）
app.post('/api/itineraries/:id/like/toggle', verifyFirebaseToken, async (req, res) => {
  try {
    const itineraryId = req.params.id;
    const userEmail = req.user?.email;
    if (!userEmail) return res.status(400).send({ message: 'Missing user email in token.' });
    const likeDocRef = db.collection('likes').doc(itineraryId).collection('userLikes').doc(userEmail);
    const snap = await likeDocRef.get();
    if (snap.exists) {
      await likeDocRef.delete();
      return res.send({ liked: false });
    } else {
      await likeDocRef.set({ email: userEmail, liked_at: Date.now() });
      return res.send({ liked: true });
    }
  } catch (err) {
    log('ERROR', 'toggle like error', { error: String(err?.message || err) });
    return res.status(500).send({ message: 'Like failed' });
  }
});
app.get('/api/itineraries/:id/like/count', async (req, res) => {
  try {
    const itineraryId = req.params.id;
    const qs = await db.collection('likes').doc(itineraryId).collection('userLikes').get();
    return res.send({ count: qs.size });
  } catch (err) {
    log('ERROR', 'get like count error', { error: String(err?.message || err) });
    return res.status(500).send({ message: 'Failed to get like count' });
  }
});
app.get('/api/itineraries/:id/like/list', async (req, res) => {
  try {
    const itineraryId = req.params.id;
    const qs = await db.collection('likes').doc(itineraryId).collection('userLikes').get();
    const users = qs.docs.map((doc) => ({ email: doc.id, ...doc.data() }));
    return res.send({ users });
  } catch (err) {
    log('ERROR', 'get like list error', { error: String(err?.message || err) });
    return res.status(500).send({ message: 'Failed to get like list' });
  }
});

// Comments
app.get('/api/itineraries/:id/comments', async (req, res) => {
  try {
    const itineraryId = req.params.id;
    const qs = await db.collection('comments').doc(itineraryId).collection('items').orderBy('created_at', 'asc').get();
    const comments = qs.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.send({ comments });
  } catch (err) {
    log('ERROR', 'get comments error', { error: String(err?.message || err) });
    return res.status(500).send({ message: 'Failed to load comments' });
  }
});
app.post('/api/itineraries/:id/comments', verifyFirebaseToken, async (req, res) => {
  try {
    const itineraryId = req.params.id;
    const email = req.user?.email;
    const text = (req.body?.text || '').toString().trim();
    if (!email || !text) return res.status(400).send({ message: 'Missing userEmail or text' });
    const payload = { email, text, created_at: Date.now() };
    const newDocRef = await db.collection('comments').doc(itineraryId).collection('items').add(payload);
    return res.status(201).send({ id: newDocRef.id, ...payload });
  } catch (err) {
    log('ERROR', 'add comment error', { error: String(err?.message || err) });
    return res.status(500).send({ message: 'Failed to add comment' });
  }
});

// Travellers ensure
const uploadMulter = multer({ storage: multer.memoryStorage() });
app.post('/api/travellers/ensure', verifyFirebaseToken, async (req, res) => {
  const email = req.user?.email;
  const name = (req.body?.name || 'Anonymous').toString().slice(0, 100);
  if (!email) return res.status(400).send({ message: 'Missing email in token' });
  try {
    const [rows] = await pool.execute('SELECT id FROM travellers WHERE email = ?', [email]);
    if (rows.length > 0) return res.send({ message: 'Exists', email });
    const [result] = await pool.execute('INSERT INTO travellers (email, name) VALUES (?, ?)', [email, name]);
    return res.status(201).send({ id: result.insertId, email, name, message: 'Created' });
  } catch (err) {
    log('ERROR', '[travellers/ensure] error', { error: String(err?.message || err) });
    return res.status(500).send({ message: 'Server error ensuring traveller' });
  }
});

// Avatar 上傳
app.post('/api/upload-avatar', verifyFirebaseToken, uploadMulter.single('avatar'), async (req, res) => {
  try {
    if (!storage) return res.status(503).send({ message: 'GCS client initializing, please retry in a moment.' });
    const email = req.user?.email;
    const file = req.file;
    if (!email) return res.status(400).send({ message: 'Missing user email in token.' });
    if (!file) return res.status(400).send({ message: 'Missing avatar file.' });
    if (!BUCKET_NAME) return res.status(500).send({ message: 'Server misconfig: GCP_BUCKET_NAME is not set.' });
    if (file.mimetype !== 'image/jpeg' && file.mimetype !== 'image/jpg') {
      return res.status(400).send({ message: 'Only JPEG allowed.' });
    }
    const destFileName = `avatar/${email}.jpg`;
    const bucket = storage.bucket(BUCKET_NAME);
    const gcFile = bucket.file(destFileName);
    await gcFile.save(file.buffer, { metadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=3600' }, resumable: false, timeout: 30000 });
    await gcFile.makePublic().catch(() => {});
    return res.status(200).send({ message: 'Avatar uploaded.' });
  } catch (err) {
    log('ERROR', 'Upload avatar error', { error: String(err?.message || err) });
    return res.status(500).send({ message: 'Failed to upload avatar.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 14) 全域錯誤處理與啟動日誌
process.on('unhandledRejection', (reason) => {
  log('ERROR', '[unhandledRejection]', { error: String(reason?.message || reason) });
});
process.on('uncaughtException', (err) => {
  log('ERROR', '[uncaughtException]', { error: String(err?.message || err), stack: err?.stack });
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

log('INFO', 'Starting service…', { env: safeEnvDump() });

app.listen(PORT, HOST, () => {
  log('INFO', `Backend listening`, { url: `http://${HOST}:${PORT}`, startedMs: Date.now() - startTime });
});
