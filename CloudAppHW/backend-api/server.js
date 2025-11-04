
// server.js — Hardened + AI background fallback + Firestore logging
// IPv4-only networking, GCS token diagnostics, Gemini lazy-init with retries,
// soft-timeout foreground + background generation, ai_status, ai_log_id, rich logs.

// ─────────────────────────────────────────────────────────────────────────────
// 0) Hard-disable IPv6 for Google SDKs (must be before any client init)
process.env.GOOGLE_CLOUD_DISABLE_IPV6 = 'true';

require('dotenv').config();

// 1) DNS: prefer IPv4
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
console.log('Global DNS default order set to ipv4first.');

// 2) IPv4-only https.Agent for legacy SDKs
const https = require('https');
const ipv4Agent = new https.Agent({
    family: 4,
    keepAlive: true,
    lookup: (hostname, opts, cb) => dns.lookup(hostname, { family: 4, all: false }, cb),
});
console.log('Legacy https.Agent for IPv4 created.');

// 3) Express & deps
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mysql = require('mysql2/promise');
const { Storage } = require('@google-cloud/storage');
const admin = require('firebase-admin');

// 4) Force all fetch-based libs (Gemini SDK) to IPv4
const { setGlobalDispatcher, Agent } = require('undici');
try {
    setGlobalDispatcher(new Agent({ family: 4 }));
    console.log('Global fetch (undici) dispatcher set to IPv4-only.');
} catch (e) {
    console.error('Failed to set undici global dispatcher:', e);
}

// 5) google-auth-library for controlled OAuth client
const { GoogleAuth } = require('google-auth-library');

// 6) Global hardened fetch for Gemini SDK (IPv4 + timeout + retries)
const delay = (ms) => new Promise(r => setTimeout(r, ms));
function makeHardenedFetch(agent, { timeoutMs = 20000, maxRetries = 1, backoffBaseMs = 400 } = {}) {
    return async function hardenedFetch(url, options = {}) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const nf = (await import('node-fetch')).default;
                const res = await nf(url, { ...options, agent, signal: controller.signal });
                clearTimeout(id);
                return res;
            } catch (err) {
                clearTimeout(id);
                const isAbort = err?.name === 'AbortError';
                const isNetworky = isAbort || /ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|fetch failed/i.test(err?.message || '');
                if (!isNetworky || attempt === maxRetries) throw err;
                const wait = backoffBaseMs * Math.pow(2, attempt - 1);
                console.warn(`[Gemini fetch] network retry #${attempt} after ${wait}ms ... (${err?.message})`);
                await delay(wait);
            }
        }
    };
}
// Override global fetch so @google/generative-ai will use it
globalThis.fetch = makeHardenedFetch(ipv4Agent, {
    timeoutMs: parseInt(process.env.GEMINI_TIMEOUT_MS || '20000', 10),
    maxRetries: parseInt(process.env.GEMINI_MAX_RETRIES || '1', 10),
    backoffBaseMs: parseInt(process.env.GEMINI_BACKOFF_BASE_MS || '400', 10),
});

// Utility: soft-timeout wrapper (doesn't cancel underlying request)
async function runWithSoftTimeout(promise, ms) {
    let soft = false;
    const softTimer = new Promise((resolve) => {
        setTimeout(() => {
            soft = true;
            resolve({ __softTimeout: true });
        }, ms);
    });
    const result = await Promise.race([promise, softTimer]);
    return { result, soft };
}

// 7) Express app & middleware
const app = express();
app.use(cors());
app.use(express.json());

/* ========================
   MySQL
======================== */
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});
function formatDate(date) {
    if (!date) return null;
    const d = new Date(date);
    d.setDate(d.getDate());
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
}

/* ========================
   Firebase Admin & Firestore
======================== */
let creds = null;
if (process.env.GCP_SERVICE_ACCOUNT_JSON) {
    try {
        creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
    } catch (e) {
        console.error('GCP_SERVICE_ACCOUNT_JSON 解析失敗：', e);
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
}
const db = admin.firestore();

/* ========================
   GCS (IPv4 + OAuth2 client) with token refresh diagnostics
======================== */
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
                console.log(`[GCS Auth] Access token obtained/refreshed. Expires at: ${expStr}`);
                lastToken = token;
            }
            if (expiry_date && (expiry_date - Date.now()) < 2 * 60 * 1000) {
                console.warn('[GCS Auth] Token will expire in < 2 min; SDK should auto-refresh soon.');
            }
        } catch (e) {
            console.error('[GCS Auth] getAccessToken() failed:', e?.message || e);
        }
    };
    check();
    setInterval(check, 5 * 60 * 1000);
}

async function initGcs() {
    const { GoogleAuth } = require('google-auth-library');
    const auth = new GoogleAuth({
        projectId: creds?.project_id || process.env.GCLOUD_PROJECT || undefined,
        credentials: creds
            ? { client_email: creds.client_email, private_key: creds.private_key }
            : undefined,
        scopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
        fetchImplementation: makeHardenedFetch(ipv4Agent, { timeoutMs: 8000, maxRetries: 3, backoffBaseMs: 300 }),
    });

    const oauthClient = await auth.getClient();
    try {
        const token = await oauthClient.getAccessToken();
        console.log('[GCS Auth] SA email:', creds?.client_email || '(ADC/default)');
        console.log('[GCS Auth] Got token?:', !!token?.token);
    } catch (e) {
        console.error('[GCS Auth] initial getAccessToken() 失敗：', e);
    }

    startAuthDiagnostics(oauthClient);

    storage = new Storage({
        projectId: creds?.project_id || process.env.GCLOUD_PROJECT,
        authClient: oauthClient,
        httpsAgent: ipv4Agent,
        apiEndpoint: 'https://storage.googleapis.com',
    });
}
initGcs().catch(e => console.error('initGcs() 失敗：', e));

/* ========================
   Gemini (AI Studio)
======================== */
const { GoogleGenerativeAI } = require('@google/generative-ai');
let generativeModel = null;
let activeGeminiModel = null;

// Tunables
const MAX_TOKENS_PRIMARY = parseInt(process.env.GEMINI_MAX_TOKENS || '640', 10);
const MAX_TOKENS_RETRY   = parseInt(process.env.GEMINI_MAX_TOKENS_RETRY || '1024', 10);
const SOFT_TIMEOUT_MS    = parseInt(process.env.GEMINI_SOFT_TIMEOUT_MS || '4000', 10); // foreground time budget

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
    if (!apiKey) { console.warn('GEMINI_API_KEY missing. AI features disabled.'); return; }
    const preferred = process.env.GEMINI_MODEL;
    const candidates = preferred ? [preferred] : ['gemini-2.5-flash', 'gemini-2.0-flash-exp', 'gemini-1.5-flash'];
    const genAI = new GoogleGenerativeAI(apiKey);

    for (const m of candidates) {
        try {
            const model = genAI.getGenerativeModel({ model: m });
            await model.countTokens({ contents: [{ role: 'user', parts: [{ text: 'ping' }] }] });
            generativeModel = model;
            activeGeminiModel = m;
            console.log(`[Gemini] Initialized with model: ${m}`);
            return;
        } catch (err) {
            console.warn(`[Gemini] Model "${m}" failed in init:`, summarizeGeminiError(err));
        }
    }
    console.error('[Gemini] All candidate models failed to init. AI disabled.');
}

// Lazy init guard
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
        try {
            return await model.generateContent(payload);
        } catch (e) {
            lastErr = e;
            if (!/fetch failed|ETIMEDOUT|ENETUNREACH|ECONNRESET|aborted/i.test(e?.message || '')) throw e;
            console.warn(`[Gemini biz retry] attempt ${i} failed: ${e?.message}`);
            await delay(500 * i);
        }
    }
    throw lastErr;
}

function getFinishReason(result) {
    return result?.response?.candidates?.[0]?.finishReason || null;
}

// Core generator returning { text, meta }
async function getGeminiSuggestion(itineraryData) {
    const ready = await ensureGeminiReady();
    if (!ready) {
        console.warn('[Gemini] Not ready after ensure, skip suggestion.');
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
        // Attempt 1
        let result = await generateContentWithRetry(generativeModel, {
            contents: [{ role: 'user', parts: [{ text: basePrompt }] }],
            generationConfig: { maxOutputTokens: MAX_TOKENS_PRIMARY, temperature: 0.7, responseMimeType: 'text/plain' },
        }, 1);

        let reason = getFinishReason(result);
        let text1 = (result?.response?.text?.() ?? '').trim();
        console.log('[Gemini A1 RAW]', JSON.stringify(result?.response || {}, null, 2).slice(0, 1200));
        meta.attempts.push({
            no: 1,
            finishReason: reason,
            hadText: !!text1,
            usage: result?.response?.usageMetadata || null,
        });

        if (!text1 || reason === 'MAX_TOKENS') {
            console.warn(`[Gemini] A1 empty or MAX_TOKENS(${reason}). Retry with higher cap...`);
            // Attempt 2
            result = await generateContentWithRetry(generativeModel, {
                contents: [{ role: 'user', parts: [{ text: basePrompt }] }],
                generationConfig: { maxOutputTokens: MAX_TOKENS_RETRY, temperature: 0.7, responseMimeType: 'text/plain' },
            }, 1);
            reason = getFinishReason(result);
            const textR = (result?.response?.text?.() ?? '').trim();
            console.log('[Gemini A2 RAW]', JSON.stringify(result?.response || {}, null, 2).slice(0, 1200));
            meta.attempts.push({
                no: 2,
                finishReason: reason,
                hadText: !!textR,
                usage: result?.response?.usageMetadata || null,
            });
            text1 = textR;
        }

        if (!text1) {
            console.warn('[Gemini] Still empty after retry. Try shorter prompt.');
            // Attempt 3
            const shorterPrompt = `Trip to ${destination} from ${start_date} to ${end_date}.
Give one concise 100-word travel note with bullets for highlights, foods, seasonal tips, and packing.
No emojis, no links.`;
            const retry2 = await generateContentWithRetry(generativeModel, {
                contents: [{ role: 'user', parts: [{ text: shorterPrompt }] }],
                generationConfig: { maxOutputTokens: MAX_TOKENS_RETRY, temperature: 0.7, responseMimeType: 'text/plain' },
            }, 1);
            const text2 = (retry2?.response?.text?.() ?? '').trim();
            console.log('[Gemini A3 RAW]', JSON.stringify(retry2?.response || {}, null, 2).slice(0, 1200));
            meta.attempts.push({
                no: 3,
                finishReason: getFinishReason(retry2),
                hadText: !!text2,
                usage: retry2?.response?.usageMetadata || null,
            });
            text1 = text2;
            reason = meta.attempts.at(-1).finishReason;
        }

        meta.finalFinishReason = reason;
        meta.ok = !!text1;
        if (text1) console.log(`[Gemini] FINAL suggestion length=${text1.length}, finishReason=${reason}`);
        else console.warn('[Gemini] FINAL result still empty.');

        return { text: text1 || null, meta };

    } catch (err) {
        const s = summarizeGeminiError(err);
        console.error('[Gemini] generateContent error:', s);
        meta.error = s;
        return { text: null, meta };
    }
}

// Kick off init (non-blocking)
initGemini().catch(e => console.error('initGemini() 失敗：', e));

/* ========================
   Auth Middleware
======================== */
async function verifyFirebaseToken(req, res, next) {
    try {
        const hdr = req.headers.authorization || '';
        const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
        if (!token) return res.status(401).send({ message: 'Missing Authorization Bearer token' });
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded;
        return next();
    } catch (err) {
        console.error('Auth error (with ipv4Agent):', err);
        return res.status(401).send({ message: 'Invalid or expired token' });
    }
}

/* ========================
   Multer
======================== */
const upload = multer({ storage: multer.memoryStorage() });

/* ========================
   Diagnostics (AI)
======================== */
app.get('/api/diagnostics/ai', async (req, res) => {
    try {
        if (!process.env.GEMINI_API_KEY) {
            return res.status(200).send({ ok: false, reason: 'NO_API_KEY' });
        }
        const ready = await ensureGeminiReady();
        if (!ready) {
            return res.status(200).send({ ok: false, reason: 'MODEL_NOT_READY', tried: activeGeminiModel });
        }
        const result = await generateContentWithRetry(generativeModel, 'ping', 1);
        const text = result?.response?.text?.() ?? '';
        res.send({ ok: true, model: activeGeminiModel, sample: ('' + text).slice(0, 60) });
    } catch (err) {
        res.status(200).send({ ok: false, reason: 'GENERATION_ERROR', error: summarizeGeminiError(err) });
    }
});

/* ========================
   Core APIs
======================== */
// ========================
// 2) 建立行程（需登入）— 無底線版 Firestore: aiSuggestions
// ========================
app.post('/api/itineraries', verifyFirebaseToken, async (req, res) => {
    const { title, destination, start_date, end_date, short_description, detail_description } = req.body;

    if (!title || !destination || !start_date || !end_date || (short_description && short_description.length > 80)) {
        return res.status(400).send({ message: 'Missing required fields or short description too long.' });
    }

    try {
        const email = req.user?.email;
        const [traveller] = await pool.execute('SELECT id FROM travellers WHERE email = ?', [email]);
        if (traveller.length === 0) {
            return res.status(404).send({ message: 'Traveller not found with this email.' });
        }
        const traveller_id = traveller[0].id;

        const [result] = await pool.execute(
            'INSERT INTO itineraries (traveller_id, title, destination, start_date, end_date, short_description, detail_description) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [traveller_id, title, destination, start_date, end_date, short_description || '', detail_description || '']
        );
        const itineraryId = String(result.insertId);

        console.log('[ITINERARY CREATE] MySQL inserted:', {
            id: itineraryId, email, title, destination, start_date, end_date,
            hasShort: !!short_description, hasDetail: !!detail_description
        });

        // 固定用「沒底線」集合名
        const AI_COL = 'aiSuggestions';
        const writeAi = true;

        // ── 前景：soft-timeout 嘗試生成（不阻塞回應）
        let suggestion = null;
        let ai_status = 'queued';
        let ai_log_id = null;

        try {
            const { result: aiResult, soft } = await runWithSoftTimeout(getGeminiSuggestion(req.body), SOFT_TIMEOUT_MS);
            if (soft) {
                console.warn(`[AI FOREGROUND] soft-timeout after ${SOFT_TIMEOUT_MS}ms → queue background run.`);
            } else if (aiResult && typeof aiResult === 'object') {
                suggestion = aiResult.text || null;
                ai_status = suggestion ? 'ok' : (aiResult?.meta?.error ? 'error' : 'no_suggestion');

                if (writeAi) {
                    const docRef = db.collection(AI_COL).doc(itineraryId);
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

                    console.log('[AI WRITE][FG]', {
                        collection: AI_COL, docId: ai_log_id, status: ai_status,
                        hasText: !!suggestion
                    });
                }
            }
        } catch (fgErr) {
            ai_status = 'error';
            console.error('[AI FOREGROUND] error:', fgErr?.message || fgErr);
        }

        // ── 背景：如果還沒拿到內容，排背景任務寫入 Firestore（集合：aiSuggestions）
        if (!suggestion || ai_status === 'no_suggestion' || ai_status === 'queued' || ai_status === 'error') {
            (async () => {
                try {
                    console.log('[AI BG] start for itinerary', itineraryId);
                    const ai = await getGeminiSuggestion(req.body);
                    const status = ai?.text ? 'ok' : (ai?.meta?.error ? 'error' : 'no_suggestion');

                    if (writeAi) {
                        const docRef = db.collection(AI_COL).doc(itineraryId);
                        await docRef.set({
                            itineraryId,
                            model: ai?.meta?.model || activeGeminiModel || null,
                            status,
                            finishReason: ai?.meta?.finalFinishReason || null,
                            attempts: ai?.meta?.attempts || [],
                            suggestion: ai?.text || null,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        });
                        console.log('[AI WRITE][BG]', {
                            collection: AI_COL, docId: docRef.id, status, hasText: !!ai?.text
                        });
                    }
                } catch (bgErr) {
                    console.error('[AI BG] failed:', bgErr?.message || bgErr);
                }
            })();
        }

        // 先回前端（可能 suggestion 為 null，狀態會是 queued/no_suggestion/error/ok）
        return res.status(201).send({
            id: Number(itineraryId),
            message: 'Itinerary created successfully.',
            suggestion,   // 有前景結果就給，否則交給背景
            ai_status,    // ok | no_suggestion | error | queued
            ai_log_id,    // 前景有寫入時會帶 id
        });

    } catch (error) {
        console.error('[ITINERARY CREATE] server error:', error);
        return res.status(500).send({ message: 'Server error during itinerary creation.' });
    }
});

// 3b. List itineraries (public)
app.get('/api/itineraries/by-email/:email', async (req, res) => {
    const { email } = req.params;
    try {
        const [rows] = await pool.execute(
            `SELECT i.id, i.title, i.start_date, i.end_date, i.short_description, t.email AS traveller_email
       FROM itineraries i JOIN travellers t ON i.traveller_id = t.id
       ORDER BY i.start_date DESC`,
            [email],
        );
        const formattedRows = rows.map((row) => ({
            ...row,
            start_date: formatDate(row.start_date),
            end_date: formatDate(row.end_date),
        }));
        res.send(formattedRows);
    } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Server error retrieving itineraries by email.' });
    }
});

// 4. Get itinerary detail (public)
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
        console.error(error);
        res.status(500).send({ message: 'Server error retrieving itinerary detail.' });
    }
});

// ========================
// 讀回 AI 建議（固定讀沒底線集合 aiSuggestions）
// ========================
app.get('/api/itineraries/:id/ai', async (req, res) => {
    try {
        const itineraryId = String(req.params.id);
        const snap = await db.collection('aiSuggestions').doc(itineraryId).get();
        if (!snap.exists) {
            return res.status(404).send({ message: 'AI record not found yet.' });
        }
        const data = snap.data();
        console.log('[AI READ]', { id: itineraryId, status: data?.status, hasText: !!data?.suggestion });
        return res.send({ id: itineraryId, ...data });
    } catch (err) {
        console.error('[AI READ] failed:', err?.message || err);
        return res.status(500).send({ message: 'Failed to load AI record.' });
    }
});

// 5. Update itinerary (owner)
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
        console.error(error);
        res.status(500).send({ message: 'Server error during itinerary update.' });
    }
});

// 6. Delete itinerary (owner) + cleanup Firestore likes/comments
async function deleteFirestoreData(itineraryId) {
    if (!itineraryId) return;
    console.log(`[Firestore Cleanup] Starting for itinerary ID: ${itineraryId}`);
    const likeParentDocRef = db.collection('likes').doc(itineraryId);
    const commentParentDocRef = db.collection('comments').doc(itineraryId);
    const deleteLikesPromise = db.recursiveDelete(likeParentDocRef);
    const deleteCommentsPromise = db.recursiveDelete(commentParentDocRef);
    try {
        await Promise.all([deleteLikesPromise, deleteCommentsPromise]);
        console.log(`[Firestore Cleanup] Successfully deleted likes and comments for ID: ${itineraryId}`);
    } catch (err) {
        console.error(`[Firestore Cleanup] Error deleting data for ID: ${itineraryId}`, err);
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

        deleteFirestoreData(id).catch(err => console.error(`[BG Cleanup Error] Failed cleanup for ${id}:`, err));
        res.send({ message: `Itinerary ID ${id} deleted successfully.` });
    } catch (error) {
        console.error(error);
        res.status(500).send({ message: 'Server error during itinerary deletion.' });
    }
});

/* ========================
   Likes API (Firestore)
======================== */
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
        console.error('toggle like error:', err);
        return res.status(500).send({ message: 'Like failed' });
    }
});

app.get('/api/itineraries/:id/like/count', async (req, res) => {
    try {
        const itineraryId = req.params.id;
        const qs = await db.collection('likes').doc(itineraryId).collection('userLikes').get();
        return res.send({ count: qs.size });
    } catch (err) {
        console.error('get like count error:', err);
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
        console.error('get like list error:', err);
        return res.status(500).send({ message: 'Failed to get like list' });
    }
});

/* ========================
   Comments API (Firestore)
======================== */
app.get('/api/itineraries/:id/comments', async (req, res) => {
    try {
        const itineraryId = req.params.id;
        const qs = await db
            .collection('comments')
            .doc(itineraryId)
            .collection('items')
            .orderBy('created_at', 'asc')
            .get();
        const comments = qs.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        return res.send({ comments });
    } catch (err) {
        console.error('get comments error:', err);
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
        const newDocRef = await db
            .collection('comments')
            .doc(itineraryId)
            .collection('items')
            .add(payload);

        return res.status(201).send({ id: newDocRef.id, ...payload });
    } catch (err) {
        console.error('add comment error:', err);
        return res.status(500).send({ message: 'Failed to add comment' });
    }
});

app.delete('/api/itineraries/:id/comments/:commentId', verifyFirebaseToken, async (req, res) => {
    try {
        const itineraryId = req.params.id;
        const commentId = req.params.commentId;
        const email = req.user?.email;

        const commentRef = db
            .collection('comments')
            .doc(itineraryId)
            .collection('items')
            .doc(commentId);

        const snap = await commentRef.get();
        if (!snap.exists) return res.status(404).send({ message: 'Comment not found' });

        const data = snap.data();
        if (data.email !== email) return res.status(403).send({ message: 'Not allowed to delete this comment' });

        await commentRef.delete();
        return res.send({ message: 'Comment deleted' });
    } catch (err) {
        console.error('delete comment error:', err);
        return res.status(500).send({ message: 'Failed to delete comment' });
    }
});

/* ========================
   Travellers Ensure（需登入；第一次登入自動建）
======================== */
app.post('/api/travellers/ensure', verifyFirebaseToken, async (req, res) => {
    const email = req.user?.email;
    const name = (req.body?.name || 'Anonymous').toString().slice(0, 100);
    if (!email) return res.status(400).send({ message: 'Missing email in token' });

    try {
        const [rows] = await pool.execute('SELECT id FROM travellers WHERE email = ?', [email]);
        if (rows.length > 0) return res.send({ message: 'Exists', email });

        const [result] = await pool.execute(
            'INSERT INTO travellers (email, name) VALUES (?, ?)',
            [email, name]
        );

        return res.status(201).send({ id: result.insertId, email, name, message: 'Created' });
    } catch (err) {
        console.error(err);
        return res.status(500).send({ message: 'Server error ensuring traveller' });
    }
});

/* ========================
   Avatar 上傳（需登入；用 token 的 email 當檔名）
======================== */
const uploadMulter = multer({ storage: multer.memoryStorage() });
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

        await gcFile.save(file.buffer, {
            metadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=3600' },
            resumable: false,
            timeout: 30000,
        });

        await gcFile.makePublic().catch(() => {});

        return res.status(200).send({ message: 'Avatar uploaded.' });
    } catch (err) {
        console.error('Upload avatar error:', err);
        return res.status(500).send({ message: 'Failed to upload avatar.' });
    }
});

/* ========================
   start server
======================== */
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log(`Backend running at http://${HOST}:${PORT}`);
});
