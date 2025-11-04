// test2.js

// 🚀 [FIX 1/3] (DNS)
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
console.log('[Test] Global DNS default order set to ipv4first.');

// 🚀 [FIX 2/3] (Legacy https.Agent)
const https = require('https');
const ipv4Agent = new https.Agent({ family: 4 });
console.log('[Test] Legacy https.Agent for IPv4 created.');

// 🚀 [FIX 3/3] (Modern undici/fetch)
const { setGlobalDispatcher, Agent } = require('undici');
try {
    setGlobalDispatcher(new Agent({ family: 4 }));
    console.log('[Test] Global fetch (undici) dispatcher set to IPv4-only.');
} catch (e) {
    console.error('[Test] Failed to set undici global dispatcher:', e);
}

// --- 測試需要的模組 ---
const fs = require('fs').promises; // 用 promise 版本的 fs
const path = require('path');
const { Storage } = require('@google-cloud/storage');

// 讀取 .env 檔案
require('dotenv').config();

// --- 你的 GCS 設定 (從 server.js 搬過來) ---

// 1. 你的 Bucket 名稱
const BUCKET_NAME =
    process.env.GCP_BUCKET_NAME || 'htwg-cloudapp-hw.firebasestorage.app';

// 2. 本地圖片路徑 (請確保這個檔案存在！)
const LOCAL_FILE_PATH = path.join(__dirname, 'test-image.jpg');

// 3. 上傳到 GCS 的檔案名稱
const DEST_FILE_NAME = `avatar/test-script-upload.jpg`;

// 4. GCS 服務帳號 (從 .env 讀取)
const GCS_CREDENTIALS_JSON = process.env.GCP_SERVICE_ACCOUNT_JSON;

// --- 測試主程式 ---

async function uploadTest() {
    console.log(`[Test] 準備上傳: ${LOCAL_FILE_PATH}`);
    console.log(`[Test] 目標 Bucket: ${BUCKET_NAME}`);

    if (!GCS_CREDENTIALS_JSON) {
        console.error('[Test] 錯誤: 找不到 .env 裡的 GCP_SERVICE_ACCOUNT_JSON');
        return;
    }

    let storage;
    try {
        // 1. 初始化 GCS (跟 server.js 一樣)
        const creds = JSON.parse(GCS_CREDENTIALS_JSON);
        storage = new Storage({
            projectId: creds.project_id,
            credentials: {
                client_email: creds.client_email,
                private_key: creds.private_key,
            },
            // 🚀 注入舊的 https agent 給 GCS
            httpsAgent: ipv4Agent,
        });
        console.log('[Test] GCS Storage (with ipv4Agent) 初始化完成。');

        // 2. 讀取本地圖片 (模擬 multer 的 memoryStorage)
        console.log('[Test] 正在讀取本地圖片 buffer...');
        const buffer = await fs.readFile(LOCAL_FILE_PATH);
        console.log(`[Test] 圖片讀取完畢 (Buffer size: ${buffer.length} bytes)`);

        // 3. 取得 GCS 檔案物件 (跟 server.js 一樣)
        const bucket = storage.bucket(BUCKET_NAME);
        const gcFile = bucket.file(DEST_FILE_NAME);

        // 4. 執行上傳 (跟 server.js 一樣)
        console.log(`[Test] 正在上傳 buffer 到 ${DEST_FILE_NAME}...`);

        await gcFile.save(buffer, {
            metadata: {
                contentType: 'image/jpeg',
                cacheControl: 'public, max-age=3600',
            },
            resumable: false,
        });

        // 5. 設為公開 (跟 server.js 一樣)
        await gcFile.makePublic().catch(() => {});

        console.log('✅ [Test] 上傳成功！');
        console.log(`[Test] 公開網址: https://storage.googleapis.com/${BUCKET_NAME}/${DEST_FILE_NAME}`);

    } catch (err) {
        console.error('❌ [Test] 上傳失敗:', err);
        // 這會印出跟 server.js 一模一樣的錯誤 (例如 ETIMEDOUT)
    }
}

// 執行測試
uploadTest();