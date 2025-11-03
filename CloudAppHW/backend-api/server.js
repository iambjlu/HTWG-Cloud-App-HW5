// server.js
require('dotenv').config(); // Load .env file

const multer = require('multer');
const { Storage } = require('@google-cloud/storage');
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const admin = require('firebase-admin'); // <- NEW

// <-- 1. NEW IMPORT (AI Studio SDK) -->
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();

/* ========================
   CORS / middleware
======================== */
app.use(cors()); // 先全開，之後要上線再縮
app.use(express.json());

/* ========================
   GCS setup (avatar upload) + Firebase Admin
======================== */
let storage;
if (process.env.GCP_SERVICE_ACCOUNT_JSON) {
    const creds = JSON.parse(process.env.GCP_SERVICE_ACCOUNT_JSON);
    storage = new Storage({
        projectId: creds.project_id,
        credentials: {
            client_email: creds.client_email,
            private_key: creds.private_key,
        },
    });

    // 🔥 Firestore / Auth 也用同一組 creds
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: creds.project_id,
                clientEmail: creds.client_email,
                privateKey: creds.private_key,
            }),
        });
    }
} else {
    // fallback: GOOGLE_APPLICATION_CREDENTIALS
    storage = new Storage();
    if (!admin.apps.length) {
        admin.initializeApp(); // 會自動吃 GOOGLE_APPLICATION_CREDENTIALS
    }
}

// Firestore DB handle
const db = admin.firestore();

// <-- 1. NEW: Initialize Gemini (AI Studio) -->
let generativeModel;
if (process.env.GEMINI_API_KEY) {
    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        generativeModel = genAI.getGenerativeModel({
            model: 'gemini-2.5-flash', // Use AI Studio model name
        });
        console.log('Gemini (AI Studio) initialized successfully.');
    } catch (e) {
        console.error('Failed to initialize AI Studio Gemini API', e);
    }
} else {
    console.warn('GEMINI_API_KEY missing in .env. AI features will be disabled.');
}
// <-- END NEW 1 -->

const BUCKET_NAME =
    process.env.GCP_BUCKET_NAME || 'htwg-cloudapp-hw.firebasestorage.app';

const upload = multer({ storage: multer.memoryStorage() });

/* ========================
   Auth Middleware（一定要在用到之前宣告）
======================== */
async function verifyFirebaseToken(req, res, next) {
    // ... (no change) ...
    try {
        const hdr = req.headers.authorization || '';
        const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
        if (!token) {
            return res.status(401).send({ message: 'Missing Authorization Bearer token' });
        }
        const decoded = await admin.auth().verifyIdToken(token);
        req.user = decoded; // 內含 email, uid, ...
        return next();
    } catch (err) {
        console.error('Auth error:', err);
        return res.status(401).send({ message: 'Invalid or expired token' });
    }
}

/* ========================
   MySQL helpers
======================== */
// ... (formatDate function, no change) ...
function formatDate(date) {
    if (!date) return null;

    const d = new Date(date);
    d.setDate(d.getDate()); // 保留你原邏輯

    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');

    return `${year}/${month}/${day}`;
}

// ... (pool create, no change) ...
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});


// <-- 2. NEW HELPER FUNCTION (Gemini) -->
/**
 * Gets a travel suggestion from the Gemini API (AI Studio).
 * Returns null if the AI is not configured or fails.
 */
async function getGeminiSuggestion(itineraryData) {
    if (!generativeModel) {
        console.log('Gemini skipped (not initialized).');
        return null;
    }

    const {
        destination,
        start_date,
        end_date,
        short_description,
        detail_description,
    } = itineraryData;

    // 這是你提供的 Prompt
    const systemPrompt = `You are a concise travel assistant. Write ONE English comment under 180 words for a trip.

Trip:
- Destination: ${destination}
- Dates: ${start_date} to ${end_date}
- ${short_description ? `Description: ${short_description}` : ''}
- ${detail_description ? `Details: ${detail_description}` : ''}

Write in friendly tone with short sections:
1) Must-see highlights (3–5 bullets)
2) Must-try food (2–4 bullets)
3) Seasonal tips (2–4 bullets, tailored to the season)
4) Packing suggestions (2–4 bullets)
5) Local customs to know (2–4 bullets)
Avoid emojis, no marketing fluff, no links, no duplication.`;

    try {
        console.log('Sending request to Gemini (AI Studio)...');

        // AI Studio SDK call
        const result = await generativeModel.generateContent(systemPrompt);
        const response = await result.response;
        const text = response.text(); // Get text directly

        console.log('Gemini suggestion received.');
        return text.trim();

    } catch (err) {
        // 如果 AI 炸了，不要卡住主流程
        console.error('Gemini API (AI Studio) error:', err);
        return null; // Fail gracefully
    }
}
// <-- END NEW 2 -->


/* ========================
   Core APIs (register, trips, etc)
======================== */

// 1. 註冊 / 登入 ... (no change) ...
app.post('/api/register', async (req, res) => {
    const { email, name } = req.body;
    if (!email || !name) {
        return res
            .status(400)
            .send({ message: 'Email and name are required.' });
    }
    try {
        const [result] = await pool.execute(
            'INSERT INTO travellers (email, name) VALUES (?, ?)',
            [email, name],
        );
        res.status(201).send({
            id: result.insertId,
            email,
            name,
            message: 'Registration successful.',
        });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            const [traveller] = await pool.execute(
                'SELECT id, email, name FROM travellers WHERE email = ?',
                [email],
            );
            if (traveller.length > 0) {
                return res.status(409).send({
                    message: 'Email already exists. Logged in successfully.',
                    id: traveller[0].id,
                    email: traveller[0].email,
                    name: traveller[0].name,
                });
            }
            return res
                .status(409)
                .send({ message: 'Email already exists.' });
        }
        console.error(error);
        res
            .status(500)
            .send({ message: 'Server error during registration.' });
    }
});


// 2. 建立行程（改為需登入，email 從 token 取，不再接受 traveller_email）
// <-- 3. MODIFIED ROUTE -->
app.post('/api/itineraries', verifyFirebaseToken, async (req, res) => {
    const {
        title,
        destination,
        start_date,
        end_date,
        short_description,
        detail_description,
    } = req.body;

    if (
        !title ||
        !destination ||
        !start_date ||
        !end_date ||
        (short_description && short_description.length > 80)
    ) {
        return res.status(400).send({
            message:
                'Missing required fields or short description too long.',
        });
    }

    try {
        const email = req.user?.email;
        const [traveller] = await pool.execute(
            'SELECT id FROM travellers WHERE email = ?',
            [email],
        );
        if (traveller.length === 0) {
            return res
                .status(404)
                .send({ message: 'Traveller not found with this email.' });
        }
        const traveller_id = traveller[0].id;

        const [result] = await pool.execute(
            'INSERT INTO itineraries (traveller_id, title, destination, start_date, end_date, short_description, detail_description) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [
                traveller_id,
                title,
                destination,
                start_date,
                end_date,
                short_description || '',
                detail_description || '',
            ],
        );

        // ===== NEW: Call Gemini API (Non-blocking) =====
        let suggestion = null;
        try {
            // 把 req.body 丟進去 (包含 title, destination, dates, etc.)
            suggestion = await getGeminiSuggestion(req.body);
        } catch (aiError) {
            console.error('AI suggestion failed, but itinerary was created:', aiError);
            // suggestion 保持 null 沒關係
        }
        // ===============================================

        res
            .status(201)
            .send({
                id: result.insertId,
                message: 'Itinerary created successfully.',
                suggestion: suggestion, // <-- 3. NEW: 把建議加到 response
            });

    } catch (error) {
        console.error(error);
        res
            .status(500)
            .send({ message: 'Server error during itinerary creation.' });
    }
});
// <-- END NEW 3 -->


// 3b. 取得行程列表 ... (no change) ...
app.get('/api/itineraries/by-email/:email', async (req, res) => {
    const { email } = req.params; // 目前未在 SQL 用到，保留你的行為
    try {
        const [rows] = await pool.execute(
            `
                SELECT i.id, i.title, i.start_date, i.end_date, i.short_description, t.email AS traveller_email
                FROM itineraries i
                         JOIN travellers t ON i.traveller_id = t.id
                ORDER BY i.start_date DESC
            `,
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
        res.status(500).send({
            message: 'Server error retrieving itineraries by email.',
        });
    }
});

// 4. 行程詳細 ... (no change) ...
app.get('/api/itineraries/detail/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await pool.execute(
            `
                SELECT i.*, t.email AS traveller_email
                FROM itineraries i
                         JOIN travellers t ON i.traveller_id = t.id
                WHERE i.id = ?
            `,
            [id],
        );

        if (rows.length === 0) {
            return res.status(404).send({ message: 'Itinerary not found.' });
        }

        const itinerary = rows[0];
        itinerary.start_date = formatDate(itinerary.start_date);
        itinerary.end_date = formatDate(itinerary.end_date);

        res.send(itinerary);
    } catch (error) {
        console.error(error);
        res
            .status(500)
            .send({ message: 'Server error retrieving itinerary detail.' });
    }
});

// 5. 編輯 ... (no change) ...
app.put('/api/itineraries/:id', verifyFirebaseToken, async (req, res) => {
    const { id } = req.params;
    const {
        title,
        destination,
        start_date,
        end_date,
        short_description,
        detail_description,
    } = req.body;

    if (
        !title ||
        !destination ||
        !start_date ||
        !end_date ||
        (short_description && short_description.length > 80)
    ) {
        return res.status(400).send({
            message: 'Missing required fields or invalid short description.',
        });
    }

    try {
        const email = req.user?.email;

        // 授權檢查
        const [rows] = await pool.execute(
            `
                SELECT i.id
                FROM itineraries i
                         JOIN travellers t ON i.traveller_id = t.id
                WHERE i.id = ? AND t.email = ?
            `,
            [id, email],
        );

        if (rows.length === 0) {
            return res.status(403).send({
                message: 'You are not the owner of this itinerary.',
            });
        }

        const [result] = await pool.execute(
            `
                UPDATE itineraries SET
                                            title = ?,
                                            destination = ?,
                                            start_date = ?,
                                            end_date = ?,
                                            short_description = ?,
                                            detail_description = ?
                WHERE id = ?
            `,
            [
                title,
                destination,
                start_date,
                end_date,
                short_description || '',
                detail_description || '',
                id,
            ],
        );

        if (result.affectedRows === 0) {
            return res.status(404).send({
                message: 'Itinerary not found or no changes made.',
            });
        }

        res.send({ message: `Itinerary ID ${id} updated successfully.` });
    } catch (error) {
        console.error(error);
        res
            .status(500)
            .send({ message: 'Server error during itinerary update.' });
    }
});

// 6. 刪除 ... (no change) ...
app.delete('/api/itineraries/:id', verifyFirebaseToken, async (req, res) => {
    const { id } = req.params;

    try {
        const email = req.user?.email;

        // 授權檢查
        const [rows] = await pool.execute(
            `
                SELECT i.id
                FROM itineraries i
                         JOIN travellers t ON i.traveller_id = t.id
                WHERE i.id = ? AND t.email = ?
            `,
            [id, email],
        );

        if (rows.length === 0) {
            return res.status(403).send({
                message: 'You are not authorized to delete this itinerary.',
            });
        }

        const [result] = await pool.execute(
            'DELETE FROM itineraries WHERE id = ?',
            [id],
        );

        if (result.affectedRows === 0) {
            return res
                .status(404)
                .send({ message: 'Itinerary not found.' });
        }

        res.send({ message: `Itinerary ID ${id} deleted successfully.` });
    } catch (error) {
        console.error(error);
        res
            .status(500)
            .send({ message: 'Server error during itinerary deletion.' });
    }
});

/* ========================
   NEW: Likes API (Firestore)
======================== */
// ... (Likes API functions, no change) ...
app.post('/api/itineraries/:id/like/toggle', verifyFirebaseToken, async (req, res) => {
    try {
        const itineraryId = req.params.id;
        const userEmail = req.user?.email;

        if (!userEmail) {
            return res
                .status(400)
                .send({ message: 'Missing user email in token.' });
        }

        // doc path: likes/{itineraryId}/userLikes/{userEmail}
        const likeDocRef = db
            .collection('likes')
            .doc(itineraryId)
            .collection('userLikes')
            .doc(userEmail);

        const snap = await likeDocRef.get();

        if (snap.exists) {
            // already liked -> remove like
            await likeDocRef.delete();
            return res.send({ liked: false });
        } else {
            // not liked -> add like
            await likeDocRef.set({
                email: userEmail,
                liked_at: Date.now(), // ms timestamp
            });
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

        const qs = await db
            .collection('likes')
            .doc(itineraryId)
            .collection('userLikes')
            .get();

        const count = qs.size;
        return res.send({ count });
    } catch (err) {
        console.error('get like count error:', err);
        return res.status(500).send({ message: 'Failed to get like count' });
    }
});
app.get('/api/itineraries/:id/like/list', async (req, res) => {
    try {
        const itineraryId = req.params.id;

        const qs = await db
            .collection('likes')
            .doc(itineraryId)
            .collection('userLikes')
            .get();

        const users = qs.docs.map((doc) => ({
            email: doc.id,
            ...doc.data(),
        }));

        return res.send({ users });
    } catch (err) {
        console.error('get like list error:', err);
        return res.status(500).send({ message: 'Failed to get like list' });
    }
});


/* ========================
   NEW: Comments API (Firestore)
======================== */
// ... (Comments API functions, no change) ...
app.get('/api/itineraries/:id/comments', async (req, res) => {
    try {
        const itineraryId = req.params.id;

        const qs = await db
            .collection('comments')
            .doc(itineraryId)
            .collection('items')
            .orderBy('created_at', 'asc') // 最舊在上，想反過來就 'desc'
            .get();

        const comments = qs.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

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

        if (!email || !text) {
            return res.status(400).send({ message: 'Missing userEmail or text' });
        }

        const payload = { email, text, created_at: Date.now() };
        const newDocRef = await db
            .collection('comments')
            .doc(itineraryId)
            .collection('items')
            .add(payload);

        // 回傳與儲存一致的 created_at（避免兩次 Date.now()）
        return res.status(201).send({
            id: newDocRef.id,
            ...payload
        });
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
        if (!snap.exists) {
            return res.status(404).send({ message: 'Comment not found' });
        }

        const data = snap.data();
        if (data.email !== email) {
            return res.status(403).send({ message: 'Not allowed to delete this comment' });
        }

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
// ... (Travellers Ensure, no change) ...
app.post('/api/travellers/ensure', verifyFirebaseToken, async (req, res) => {
    const email = req.user?.email;
    const name = (req.body?.name || 'Anonymous').toString().slice(0, 100);
    if (!email) return res.status(400).send({ message: 'Missing email in token' });

    try {
        const [rows] = await pool.execute('SELECT id FROM travellers WHERE email = ?', [email]);
        if (rows.length > 0) return res.send({ message: 'Exists', email });

        const [result] = await pool.execute(
            'INSERT INTO travellers (email, name) VALUES (?, ?)', [email, name]
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
// ... (Avatar Upload, no change) ...
app.post('/api/upload-avatar', verifyFirebaseToken, upload.single('avatar'), async (req, res) => {
    try {
        const email = req.user?.email; // 改用 token
        const file = req.file;

        if (!email) {
            return res.status(400).send({ message: 'Missing user email in token.' });
        }
        if (!file) {
            return res.status(400).send({ message: 'Missing avatar file.' });
        }

        // 只收 JPEG（前端我們會轉成 jpeg 上傳）
        if (
            file.mimetype !== 'image/jpeg' &&
            file.mimetype !== 'image/jpg'
        ) {
            return res.status(400).send({ message: 'Only JPEG allowed.' });
        }

        const destFileName = `avatar/${email}.jpg`;

        const bucket = storage.bucket(BUCKET_NAME);
        const gcFile = bucket.file(destFileName);

        await gcFile.save(file.buffer, {
            metadata: {
                contentType: 'image/jpeg',
                cacheControl: 'public, max-age=3600',
            },
            resumable: false,
        });

        // bucket 如果本身就是 public 可以不用，但保險一次
        await gcFile.makePublic().catch(() => { });

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
