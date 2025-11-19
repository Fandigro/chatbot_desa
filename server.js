const express = require("express");
const cors = require("cors");
const XLSX = require("xlsx");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const multer = require('multer');
const db = require('./db');
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();
const { FaissStore } = require("@langchain/community/vectorstores/faiss");
const { Embeddings } = require("@langchain/core/embeddings");
const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);
const CACHE_TTL_MS = 1000 * 60 * 5; // 5 menit

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const sessions = {};
const intents = JSON.parse(fs.readFileSync("intents.json", "utf-8"));

// === Pengaturan Data & Direktori ===
const statistikFilePath = path.join(__dirname, 'data', 'statistik_desa.xlsx');
const uploadDir = path.join(__dirname, 'data');
const tempUploadDir = path.join(__dirname, 'temp_uploads');

//toogle chatbot on/off
let chatbotAktif = true;

app.post("/chatbot/toggle", (req, res) => {
    chatbotAktif = !chatbotAktif;
    res.json({ active: chatbotAktif });
});

app.get("/chatbot/status", (req, res) => {
    res.json({ active: chatbotAktif });
});

app.get("/cache", async (req, res) => {
    try {
        const [rows] = await db.query("SELECT id, question, source, usage_count, last_accessed FROM chatbot_cache ORDER BY last_accessed DESC");
        res.json(rows);
    } catch (err) {
        console.error("❌ Gagal memuat cache:", err);
        res.status(500).json([]);
    }
});

app.delete("/cache/delete/:id", async (req, res) => {
    const id = req.params.id;
    try {
        await db.query("DELETE FROM chatbot_cache WHERE id = ?", [id]);
        res.json({ success: true });
    } catch (err) {
        console.error("❌ Gagal hapus cache:", err);
        res.status(500).json({ success: false });
    }
});

app.get("/cache/list", async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT id, question, source, usage_count, last_accessed 
         FROM chatbot_cache 
         ORDER BY last_accessed DESC`
        );
        res.json(rows);
    } catch (err) {
        console.error("❌ Gagal mengambil daftar cache:", err);
        res.status(500).json({ error: "Gagal mengambil daftar cache." });
    }
});

// === Pemuatan Data Statistik ke Memori Server ===
let statistikData = [];
let statistikHeaders = [];
function loadStatistikData() {
    try {
        console.log("📊 Memuat data statistik mentah ke memori...");
        const workbook = XLSX.readFile(statistikFilePath);
        const sheetName = workbook.SheetNames[0];
        // Baca data mentah dengan header yang bersih
        const jsonDataRaw = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
        statistikData = jsonDataRaw.map(row => {
            const newRow = {};
            for (const key in row) {
                newRow[key.trim()] = row[key];
            }
            return newRow;
        });

        if (statistikData.length > 0) {
            statistikHeaders = Object.keys(statistikData[0]);
            console.log("✅ Data statistik siap dengan header:", statistikHeaders);
        }
    } catch (error) {
        console.error("❌ Gagal memuat file statistik.", error.message);
        statistikData = [];
        statistikHeaders = [];
    }
}
loadStatistikData();

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(tempUploadDir)) fs.mkdirSync(tempUploadDir, { recursive: true });

// === Pengaturan Upload File (Multer) ===
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });
const tempUpload = multer({ dest: tempUploadDir });

let vectorStore;

// === Custom Embedding Class ===
class CustomHuggingFaceEmbeddings extends Embeddings {
    constructor() { super({ maxConcurrency: 5 }); this.pipeline = null; this.modelName = 'Xenova/gte-base'; }
    async _getPipeline() { if (this.pipeline === null) { const { pipeline } = await import('@xenova/transformers'); this.pipeline = await pipeline('feature-extraction', this.modelName); } return this.pipeline; }
    async _embed(texts) { const pipe = await this._getPipeline(); const embeddings = await pipe(texts, { pooling: 'mean', normalize: true }); return embeddings.tolist(); }
    embedDocuments(texts) { return this._embed(texts); }
    embedQuery(text) { return this._embed([text]).then(embeddings => embeddings[0]); }
}
const embeddings = new CustomHuggingFaceEmbeddings();

// === Fungsi Utama & Server Start ===
async function main() {
    const indexSavePath = './vector_index';
    if (!fs.existsSync(indexSavePath)) {
        console.error("\n❌ KESALAHAN: 'otak' AI (vector_index) tidak ditemukan.");
        console.error("   Harap jalankan indexing penuh sekali melalui panel admin atau upload file statistik.");
        // Tidak keluar, biarkan server berjalan agar admin bisa memicu indexing
    } else {
        console.log("🧠 Memuat 'otak' AI (Vector Store) dari file...");
        vectorStore = await FaissStore.load(indexSavePath, embeddings);
        console.log("✅ 'Otak' AI siap.");
    }

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`\n🚀 Server berjalan di http://localhost:${PORT}`);
    });
}

async function reloadVectorStore() {
    try {
        console.log("🔄 Memuat ulang vector store...");
        vectorStore = await FaissStore.load('./vector_index', embeddings);
        console.log("✅ Vector store berhasil dimuat ulang.");
    } catch (err) {
        console.error("❌ Gagal memuat ulang vector store:", err.message);
    }
}


function detectIntent(text) {
    const q = text.toLowerCase();
    for (const intent of intents) {
        if (intent.keywords.some(k => q.includes(k))) return intent.response;
    }
    return null;
}

async function getCache(question) {
    const [rows] = await db.query(
        "SELECT answer, created_at FROM chatbot_cache WHERE question = ? LIMIT 1",
        [question]
    );
    if (rows.length === 0) return null;

    const cached = rows[0];
    const cacheAge = Date.now() - new Date(cached.created_at).getTime();

    if (cacheAge > CACHE_TTL_MS) {
        await db.query("DELETE FROM chatbot_cache WHERE question = ?", [question]);
        return null;
    }

    // update last_accessed & usage_count biar statistiknya akurat
    await db.query(
        "UPDATE chatbot_cache SET last_accessed = NOW(), usage_count = usage_count + 1 WHERE question = ?",
        [question]
    );

    return cached.answer;
}

async function setCache(question, answer, source = 'RAG') {
    await db.query(
        `REPLACE INTO chatbot_cache (question, answer, source, created_at, usage_count)
         VALUES (?, ?, ?, NOW(), 1)`,
        [question, answer, source]
    );
}

async function clearCache() {
    await db.query("DELETE FROM chatbot_cache");
    console.log("🧹 Cache database dibersihkan karena dokumen diperbarui.");
}
main();


// === ENDPOINTS API ===

app.get("/documents/size", (req, res) => {
    let totalSize = 0;
    if (fs.existsSync(uploadDir)) {
        fs.readdirSync(uploadDir).forEach(file => {
            const filePath = path.join(uploadDir, file);
            const stats = fs.statSync(filePath);
            if (stats.isFile()) {
                totalSize += stats.size;
            }
        });
    }
    res.json({ totalBytes: totalSize });
});

app.get("/documents/storage", (req, res) => {
    const uploadDir = path.join(__dirname, 'data'); // pastikan ini sesuai dengan folder upload kamu
    let totalSize = 0;

    if (fs.existsSync(uploadDir)) {
        fs.readdirSync(uploadDir).forEach(file => {
            const filePath = path.join(uploadDir, file);
            const stats = fs.statSync(filePath);
            if (stats.isFile()) {
                totalSize += stats.size;
            }
        });
    }

    const usedKB = totalSize / 1024;
    const maxKB = 1024 * 1024; // 1 GB = 1024 * 1024 KB

    res.json({ usedKB, maxKB });
});


app.get("/cache/stats", async (req, res) => {
    try {
        const [rows] = await db.query("SELECT COUNT(*) AS total, SUM(CHAR_LENGTH(answer)) AS totalChars FROM chatbot_cache");
        const usedKB = (rows[0].totalChars || 0) / 1024;
        const maxMB = 50;
        const maxKB = maxMB * 1024;
        const percent = (usedKB / maxKB) * 100;
        res.json({ usedKB, maxKB, maxMB, percent });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Gagal membaca statistik cache." });
    }
});

app.post("/cache/clear", async (req, res) => {
    await clearCache();
    res.json({ success: true, message: "Cache berhasil dibersihkan dari database." });
});

app.get('/documents/stats', async (req, res) => {
    try {
        const [rows] = await db.query(`
        SELECT 
          COUNT(*) AS total,
          SUM(status = 'INDEXED') AS indexed,
          SUM(status = 'PENDING') AS pending,
          SUM(status = 'FAILED') AS failed
        FROM chatbot_documents
      `);
        res.json({ success: true, ...rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Gagal mengambil statistik dokumen' });
    }
});

// Fungsi untuk hitung total ukuran file di folder penyimpanan
function getTotalFilesSize(folderPath) {
    const files = fs.readdirSync(folderPath);
    return files.reduce((total, file) => {
        const filePath = path.join(folderPath, file);
        const stats = fs.statSync(filePath);
        return total + stats.size;
    }, 0);
}

// -- Endpoint untuk upload dokumen baru --
// AKSI: Menjalankan Indexing CEPAT (Incremental) secara otomatis
app.post('/upload', upload.single('document'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Tidak ada file yang diupload.' });
    }
    if (req.file.originalname === 'statistik_desa.xlsx') {
        return res.status(400).json({ success: false, message: 'File statistik harus diupload melalui form "Kelola Data Statistik".' });
    }

    // 🔹 Cek ukuran total folder setelah ditambah file baru
    const currentSize = getTotalFilesSize(uploadDir); // ukuran saat ini
    const newSize = currentSize + req.file.size; // ukuran total jika file ini ditambahkan
    const maxSize = 1024 * 1024 * 1024; // 1 GB dalam bytes

    if (newSize > maxSize) {
        // Hapus file yang baru saja diupload (karena multer sudah menyimpannya)
        fs.unlinkSync(req.file.path);
        return res.status(400).json({
            success: false,
            message: 'Upload dibatalkan. Total ukuran file melebihi 1 GB.'
        });
    }

    try {
        const { filename, originalname } = req.file;
        await db.query(
            "INSERT INTO chatbot_documents (file_name, original_name, file_path, status) VALUES (?, ?, ?, 'PENDING')",
            [filename, originalname, uploadDir]
        );

        console.log(`✅ File '${originalname}' diupload. Menunggu proses indexing manual...`);
        res.json({ success: true, message: `File '${originalname}' berhasil diupload. Silakan jalankan proses indexing secara manual.` });

    } catch (err) {
        console.error("❌ Gagal upload:", err.message);
        res.status(500).json({ success: false, message: 'Terjadi kesalahan saat memproses file.' });
    }
});


// -- Endpoint untuk tombol "Index Ulang Semua" --
// AKSI: Menjalankan Indexing PENUH (Rebuild) secara manual
let indexProgress = {
    percent: 0,
    message: "Menunggu proses indexing...",
    running: false
};

app.post('/run-indexer', async (req, res) => {
    const { spawn } = require('child_process');
    indexProgress.running = true;
    indexProgress.percent = 0;
    indexProgress.message = "🔄 Menyiapkan proses indexing...";

    let totalDocs = 0;
    let docsDone = 0;
    let totalBatches = 0;
    let batchesDone = 0;

    const indexer = spawn('node', ['indexer.js', '--rebuild']);

    indexer.stdout.on('data', (data) => {
        const line = data.toString();
        console.log(line);

        // Tahap 1: Hitung total dokumen
        const matchDocsTotal = line.match(/Ditemukan (\d+) dokumen/);
        if (matchDocsTotal) {
            totalDocs = parseInt(matchDocsTotal[1]);
            docsDone = 0;
            indexProgress.message = `Menemukan ${totalDocs} dokumen untuk diproses...`;
        }

        // Dokumen selesai diekstrak
        if (line.includes("Berhasil ekstrak")) {
            docsDone++;
            let percentExtract = (docsDone / totalDocs) * 50; // 50% tahap ekstrak
            indexProgress.percent = Math.round(percentExtract);
            indexProgress.message = `Memproses dokumen ${docsDone}/${totalDocs}...`;
        }

        // Tahap 2: Hitung total batch embedding
        const matchBatchTotal = line.match(/Estimasi jumlah batch: (\d+)/);
        if (matchBatchTotal) {
            totalBatches = parseInt(matchBatchTotal[1]);
            batchesDone = 0;
            indexProgress.message = `Menyimpan data ke otak AI (${totalBatches} batch)...`;
        }

        // Batch selesai diproses
        const matchBatchDone = line.match(/Menambahkan batch (\d+):/);
        if (matchBatchDone) {
            batchesDone = parseInt(matchBatchDone[1]);
            let percentEmbedding = 50 + (batchesDone / totalBatches) * 50; // 50% tahap embedding
            indexProgress.percent = Math.min(100, Math.round(percentEmbedding));
            indexProgress.message = `Menyimpan data ke otak AI: batch ${batchesDone}/${totalBatches}...`;
        }
    });

    indexer.on('close', () => {
        indexProgress.running = false;
        indexProgress.percent = 100;
        indexProgress.message = "Indexing selesai! Semua dokumen siap digunakan AI.";
    });

    res.json({ success: true });
});

app.get('/index-progress', (req, res) => {
    res.json({
        percent: indexProgress.percent,
        message: indexProgress.message,
        running: indexProgress.running
    });
});


app.post('/run-incremental-indexer', async (req, res) => {
    console.log('🚀 Menjalankan proses indexing dokumen baru (incremental)...');

    try {
        const { stdout, stderr } = await execAsync('node indexer.js');
        if (stderr) console.error(`❌ Stderr indexing incremental: ${stderr}`);
        console.log(`✅ Log dari indexing incremental:\n${stdout}`);

        await reloadVectorStore();
        clearCache();

        res.json({ success: true, message: 'Indexing dokumen baru selesai.' });
    } catch (err) {
        console.error("❌ Error saat indexing incremental:", err.message);
        res.status(500).json({ success: false, message: 'Gagal melakukan indexing dokumen baru.' });
    }
});


// -- Endpoint untuk upload file statistik utama --
// AKSI: Menjalankan Indexing PENUH (Rebuild)
app.post('/upload-statistik', tempUpload.single('statistik_file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'File tidak ditemukan.' });
    fs.rename(req.file.path, statistikFilePath, (err) => {
        if (err) return res.status(500).json({ success: false, message: 'Gagal memproses file.' });
        console.log("🔄 File statistik diperbarui. Memuat ulang data ke memori...");
        loadStatistikData(); // Cukup panggil fungsi ini
        res.json({ success: true, message: 'File data statistik berhasil diperbarui.' });
    });
});

// AKSI: Menjalankan Indexing PENUH (Rebuild)
// -- Endpoint untuk daftar dokumen dan download (tidak berubah) --
app.get('/documents', async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT id, original_name, status, upload_timestamp, last_indexed_timestamp 
            FROM chatbot_documents 
            ORDER BY upload_timestamp DESC
        `);
        res.json(rows); // ini dikonsumsi oleh `fetchFiles()`
    } catch (err) {
        console.error('Gagal mengambil daftar dokumen:', err.message);
        res.status(500).json({ success: false, message: 'Gagal mengambil daftar dokumen' });
    }
});

// -- Endpoint untuk downlaod statistik --
app.get('/download-statistik', (req, res) => {
    res.download(statistikFilePath, 'statistik_desa_terbaru.xlsx', (err) => {
        if (err && !res.headersSent) res.status(404).send("File tidak ditemukan.");
    });
});

app.get("/download/:id", async (req, res) => {
    try {
        const docId = req.params.id;

        const [rows] = await db.query(
            "SELECT file_name, original_name, file_path FROM chatbot_documents WHERE id = ? LIMIT 1",
            [docId]
        );

        if (rows.length === 0)
            return res.status(404).send("Dokumen tidak ditemukan di database.");

        const { file_name, original_name, file_path } = rows[0];

        // pakai fallback folder upload kalau file_path null
        const basePath = file_path || path.join(process.cwd(), "data");
        const fullPath = path.join(basePath, file_name);

        if (!fs.existsSync(fullPath))
            return res.status(404).send("File tidak ditemukan di server.");

        res.download(fullPath, original_name, (err) => {
            if (err) {
                console.error("Gagal mengunduh file:", err);
                if (!res.headersSent)
                    res.status(500).send("Terjadi kesalahan saat mengunduh file.");
            }
        });
    } catch (err) {
        console.error("Error saat proses download:", err);
        res.status(500).send("Terjadi kesalahan server saat mengunduh file.");
    }
});


// -- Endpoint untuk menghapus dokumen --
app.delete("/delete-document/:id", async (req, res) => {
    const docId = req.params.id;

    try {
        // Ambil metadata file dari database
        const [rows] = await db.query("SELECT file_name, file_path FROM chatbot_documents WHERE id = ?", [docId]);

        if (rows.length === 0) {
            return res.status(404).json({ message: "Dokumen tidak ditemukan di database." });
        }

        const { file_name, file_path } = rows[0];
        const fullPath = path.join(file_path || uploadDir, file_name); // ✅ Gunakan path dari database atau fallback

        // Pastikan file ada sebelum dihapus
        if (!fs.existsSync(fullPath)) {
            console.warn("⚠️ File tidak ditemukan secara fisik, tetapi tetap menghapus dari database...");
            await db.query("DELETE FROM chatbot_documents WHERE id = ?", [docId]);
            clearCache();
            return res.json({ message: "File tidak ditemukan di sistem, namun entri di database telah dihapus." });
        }

        // Hapus file
        fs.unlink(fullPath, async (err) => {
            if (err) {
                console.error("❌ Gagal menghapus file:", err.message);
                return res.status(500).json({ message: "Gagal menghapus file fisik." });
            }

            // Hapus dari database
            await db.query("DELETE FROM chatbot_documents WHERE id = ?", [docId]);
            clearCache();
            res.json({ message: "Dokumen berhasil dihapus." });
        });
    } catch (err) {
        console.error("❌ Error saat menghapus dokumen:", err.message);
        res.status(500).json({ message: "Terjadi kesalahan pada server." });
    }
});


// === Endpoint Chat AI (/ask) ===
app.post("/ask", async (req, res) => {
    const { question, sessionId } = req.body;
    if (!question) return res.status(400).json({ answer: "Pertanyaan kosong." });
    // === TAHAP 0: Cek intent sederhana dari intents.json ===
    const intentResponse = detectIntent(question);
    if (intentResponse) {
        return res.json({ answer: intentResponse, sessionId: uuidv4() });
    }
    const cachedAnswer = await getCache(question);
    if (cachedAnswer) {
        console.log("⚡ Jawaban diambil dari cache database.");
        return res.json({ answer: cachedAnswer, sessionId: uuidv4() });
    }

    const headers = { "Authorization": `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" };

    try {
        // --- TAHAP 1: AI ROUTER (Tidak Berubah) ---
        const routerPrompt = `
        You are a routing agent for a village chatbot. Classify the user's question into one of the following categories:

        1. "data_query" → Questions about structured data like gender, age, education, religion, number of people, or citizenship. These usually relate to statistics stored in an Excel file.
        Examples:
        - Berapa jumlah penduduk laki-laki?
        - Berapa warga yang beragama Islam?
        - Siapa saja yang sedang menempuh pendidikan SMA?

        2. "general_query" → Questions about documents like regulations, procedures, policies, or written rules in PDF/DOCX/CSV. These are unstructured and found in uploaded files.
        Examples:
        - Apa isi peraturan desa tentang pengelolaan sampah?
        - Bagian Bab II Peraturan Desa Socah
        - Peraturan desa terbaru
        - Apakah ada dokumen tentang kebersihan lingkungan?

        3. "chitchat" → Greetings or casual questions not related to data or documents.
        Examples:
        - Hai, siapa namamu?
        - Pertanyaan tentang cuaca, presiden, teknologi, politik nasional/internasional
        - Topik agama, kesehatan umum, hewan, ramalan, horoskop
        - Pertanyaan lucu atau aneh (misalnya: kamu bisa pacaran?, kamu robot ya?, kamu makan apa?)
        - Pertanyaan iseng seperti "Apa itu AI?", "Kamu suka mie goreng?", "Berapa umurmu?", "Apakah kamu manusia?", dsb.


        User question: "${question}"

        Respond ONLY with a JSON like: {"category": "data_query"}
`

        const routerResponse = await axios.post("https://api.groq.com/openai/v1/chat/completions",
            { model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: routerPrompt }], temperature: 0, response_format: { type: "json_object" } },
            { headers }
        );
        const { category } = JSON.parse(routerResponse.data.choices[0].message.content);
        console.log(`🚦 AI Router mengklasifikasikan pertanyaan sebagai: "${category}"`);

        let finalAnswer = "";

        // --- TAHAP 2: Arahkan ke "Departemen" yang Tepat ---
        switch (category) {
            case 'data_query':
                console.log("  -> Meneruskan ke AI Analis Data...");

                const plannerPrompt = `
                You are a JavaScript expert helping to analyze village data.
                
                You will receive a question from the user, and a list of headers from a dataset.
                
                Based on the question: "${question}"
                and the headers: [${statistikHeaders.join(', ')}]
                
                Generate ONLY the condition for a JavaScript filter function, like:
                
                (row["Jenis Kelamin"] || "").toLowerCase().includes("laki-laki")
                
                If the user asks about "jumlah laki laki", assume it refers to:
                (row["Jenis Kelamin"] || "").toLowerCase().replace(/\\s+/g, " ").includes("laki-laki")
                
                Do NOT include 'function', 'filter', or any explanation. Just return the raw condition code.
                Normalize comparisons by removing extra spaces, and converting everything to lowercase.
                
                Important examples:
                - "jumlah laki laki" => (row["Jenis Kelamin"] || "").toLowerCase().replace(/\\s+/g," ").includes("laki-laki")
                - "penduduk perempuan" => (row["Jenis Kelamin"] || "").toLowerCase().replace(/\\s+/g," ").includes("perempuan")
                - "agama islam" => (row["Agama"] || "").toLowerCase().includes("islam")
                `;

                const plannerResponse = await axios.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    {
                        model: "llama-3.3-70b-versatile",
                        messages: [{ role: "user", content: plannerPrompt }],
                        temperature: 0
                    },
                    { headers }
                );

                let rawFilterCode = plannerResponse.data.choices[0].message.content.trim();

                // Hapus backticks dan keyword javascript
                rawFilterCode = rawFilterCode.replace(/`/g, '').replace('javascript', '').trim();

                if (!rawFilterCode) {
                    throw new Error("AI Planner tidak menghasilkan kode.");
                }

                // Normalisasi properti menjadi format row["Properti"]
                const normalizedBody = rawFilterCode
                    .replace(/row\.([A-Za-z_][A-Za-z0-9_]*)/g, 'row["$1"]')
                    .replace(/row\["([^"]+)"\]/g, '(row["$1"] || "").toString().toLowerCase().replace(/\\s+/g, " ").trim()');

                // Buat fungsi filter yang aman
                let filterFunction;
                try {
                    filterFunction = new Function('row', `return (${normalizedBody});`);
                } catch (e) {
                    throw new Error(`Gagal membuat fungsi filter: ${e.message}`);
                }

                // Jalankan filter
                const filteredData = statistikData.filter(item => {
                    try {
                        return filterFunction(item);
                    } catch (e) {
                        console.error("Error pada filterFunction:", e);
                        return false;
                    }
                });

                const resultCount = filteredData.length;

                // 🔁 Tambahan fallback jika data kosong
                if (resultCount === 0 && vectorStore) {
                    console.warn("⚠️ Tidak ada data ditemukan. Mencoba menjawab dari dokumen (fallback ke general_query).");
                    const relevantDocs = await vectorStore.similaritySearch(question, 10);
                    const context = relevantDocs.map(doc => doc.pageContent).join("\n\n---\n\n");

                    const fallbackPrompt = `You are LAAKON, a friendly and helpful village assistant from Alas Kokon Village. User question: "${question}". Try to answer ONLY based on the following context:\n\n${context}\n\nAnswer in Indonesian. If the context doesn't help, say you don't have the information.`;
                    const fallbackResponse = await axios.post(
                        "https://api.groq.com/openai/v1/chat/completions",
                        {
                            model: "llama-3.3-70b-versatile",
                            messages: [{ role: "user", content: fallbackPrompt }],
                            temperature: 0.5
                        },
                        { headers }
                    );

                    finalAnswer = fallbackResponse.data.choices[0].message.content.trim();
                    break;
                }
                let analysisResult = `Ditemukan ${resultCount} data yang cocok.`;
                if (resultCount > 0 && resultCount <= 5) {
                    analysisResult += ` Nama: ${filteredData.map(r => r.Nama).join(', ')}.`;
                }

                const dataFormatterPrompt = `You are LAAKON, a friendly and helpful village assistant from Alas Kokon Village. The user asked: "${question}". The analysis result is: "${analysisResult}". Formulate a friendly answer in Indonesian.(dont show the formulate)`;

                const dataFormatterResponse = await axios.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    {
                        model: "llama-3.3-70b-versatile",
                        messages: [{ role: "user", content: dataFormatterPrompt }],
                        temperature: 0.5
                    },
                    { headers }
                );

                finalAnswer = dataFormatterResponse.data.choices[0].message.content.trim();
                break;

            case 'general_query':
                console.log("  -> Meneruskan ke Pencarian Dokumen Umum...");
                if (!vectorStore) {
                    finalAnswer = "Maaf, database pengetahuan dokumen sedang tidak siap.";
                    break;
                }
                const relevantDocs = await vectorStore.similaritySearch(question, 10);
                const context = relevantDocs.map(doc => doc.pageContent).join("\n\n---\n\n");
                const generalFormatterPrompt = `You are LAAKON, a friendly and helpful village assistant from Alas Kokon Village. Answer the user's question: "${question}" based ONLY on the following context:\n\n${context}\n\nIf the context is not relevant, say you don't have the information. Answer in Indonesian.`;
                const generalFormatterResponse = await axios.post("https://api.groq.com/openai/v1/chat/completions", { model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: generalFormatterPrompt }], temperature: 0.5 }, { headers });
                finalAnswer = generalFormatterResponse.data.choices[0].message.content.trim();
                break;

            case 'chitchat':
            default:
                console.log("  -> Menangani sebagai Obrolan Ringan...");
                const chitchatPrompt = `You are LAAKON, a friendly and helpful village assistant from Alas Kokon Village. The user says: "${question}". Respond briefly and politely in Indonesian.`;
                const chitchatResponse = await axios.post("https://api.groq.com/openai/v1/chat/completions", { model: "llama-3.1-8b-instant", messages: [{ role: "user", content: chitchatPrompt }], temperature: 0.7 }, { headers });
                finalAnswer = chitchatResponse.data.choices[0].message.content.trim();
                break;
        }

        await setCache(question, finalAnswer);

        res.json({ answer: finalAnswer, sessionId: uuidv4() });

    } catch (err) {
        console.error("❌ ERROR pada proses AI Router:", err.message);
        res.status(500).json({ answer: "Maaf, terjadi kesalahan pada sistem AI." });
    }
});