// server.js
require('dotenv').config(); // Load .env file

const multer = require('multer');
const { Storage } = require('@google-cloud/storage');
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const admin = require('firebase-admin'); // <- NEW

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

const BUCKET_NAME =
    process.env.GCP_BUCKET_NAME || 'htwg-cloudapp-hw.firebasestorage.app';

const upload = multer({ storage: multer.memoryStorage() });

/* ========================
   Auth Middleware（一定要在用到之前宣告）
======================== */
async function verifyFirebaseToken(req, res, next) {
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

function formatDate(date) {
    if (!date) return null;

    const d = new Date(date);
    d.setDate(d.getDate()); // 保留你原邏輯

    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');

    return `${year}/${month}/${day}`;
}

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

/* ========================
   Core APIs (register, trips, etc)
======================== */

// 1. 註冊 / 登入（保留：給非 Firebase 流程；目前前端不再使用）
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
        res
            .status(201)
            .send({ id: result.insertId, message: 'Itinerary created successfully.' });
    } catch (error) {
        console.error(error);
        res
            .status(500)
            .send({ message: 'Server error during itinerary creation.' });
    }
});

// 3b. 取得行程列表（公開：維持原本回全部、前端自行過濾）
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

// 4. 行程詳細（公開）
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

// 5. 編輯（需登入 + 擁有者；不再從 body 收 traveller_email）
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

// 6. 刪除（需登入 + 擁有者；不再從 body 收 traveller_email）
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

/**
 * Toggle like for this itinerary by this user.
 * 需登入；使用 token email
 */
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

/**
 * Get like count for itinerary（公開讀）
 */
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

/**
 * Get who liked (for popup)（公開讀）
 */
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

/**
 * 取得某個行程的所有留言（公開讀）
 * GET /api/itineraries/:id/comments
 */
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

/**
 * 新增留言（需登入；email 從 token）
 * POST /api/itineraries/:id/comments
 * body: { text: string }
 */
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

/**
 * 刪除自己的留言（需登入；email 從 token）
 * DELETE /api/itineraries/:id/comments/:commentId
 */
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