// indexer.js (versi gabungan terbaik)

const fs = require('fs');
const path = require('path');
const { FaissStore } = require("@langchain/community/vectorstores/faiss");
const { Document } = require("@langchain/core/documents");

// --- Modul Kustom ---
const db = require('./db');
const { CustomHuggingFaceEmbeddings } = require('./custom_embeddings');
const {
    extractTextFromPdf,
    extractTextFromDocx,
    extractTextFromCsv,
    terminateOcr
} = require('./doc_parsers');

// --- Inisialisasi & Konfigurasi ---
const embeddings = new CustomHuggingFaceEmbeddings();
const indexSavePath = './vector_index';
const BATCH_SIZE = 25;

async function main() {
    const isRebuildMode = process.argv.includes('--rebuild');
    console.log(isRebuildMode ? "\uD83D\uDE80 Memulai Indexing Mode REBUILD (Penuh)" : "\uD83D\uDE80 Memulai Indexing Mode INCREMENTAL (Cepat)...");

    let documentsFromDB = [];
    try {
        const query = isRebuildMode ?
            "SELECT * FROM chatbot_documents" :
            "SELECT * FROM chatbot_documents WHERE status = 'PENDING'";
        [documentsFromDB] = await db.query(query);
        console.log(`\n[Tahap 1] Ditemukan ${documentsFromDB.length} dokumen untuk diproses.`);
    } catch (err) {
        console.error("\u274C Gagal mengambil data dari database", err);
        return;
    }

    const docsToProcess = [];
    for (const file of documentsFromDB) {
        const filePath = path.join(file.file_path, file.file_name);
        console.log(`\uD83D\uDCC4 Memproses: ${file.original_name}`);

        if (!fs.existsSync(filePath)) {
            console.error(`  -> \u26D4 File tidak ditemukan: ${filePath}`);
            await db.query("UPDATE chatbot_documents SET status = 'ERROR_NOT_FOUND' WHERE id = ?", [file.id]);
            continue;
        }

        try {
            let docs = [];
            const ext = path.extname(file.original_name).toLowerCase();

            if (ext === '.pdf') docs = await extractTextFromPdf(filePath);
            else if (ext === '.docx') docs = await extractTextFromDocx(filePath);
            else if (ext === '.csv') docs = await extractTextFromCsv(filePath);
            else {
                console.warn(`  -> \u26A0\uFE0F Format tidak didukung: ${ext}`);
                await db.query("UPDATE chatbot_documents SET status = 'UNSUPPORTED' WHERE id = ?", [file.id]);
                continue;
            }

            docs.forEach(doc => {
                doc.metadata.source = file.original_name;
                doc.metadata.uploaded_at = file.upload_timestamp || new Date().toISOString();
                doc.metadata.file_id = file.id;
            });

            docsToProcess.push(...docs);
            await db.query(`
                UPDATE chatbot_documents 
                SET status = 'INDEXED', last_indexed_timestamp = CURRENT_TIMESTAMP 
                WHERE id = ?
            `, [file.id]);

            console.log(`     -> ✅ Berhasil ekstrak ${docs.length} chunk dari ${file.original_name}`);

        } catch (err) {
            console.error(`  -> \u274C Gagal parsing: ${err.message}`);
            await db.query("UPDATE chatbot_documents SET status = 'ERROR_PARSING' WHERE id = ?", [file.id]);
        }
    }

    if (docsToProcess.length === 0) {
        console.log("\n\uD83E\uDD37 Tidak ada dokumen yang akan di-index. Proses selesai.");
        return;
    }

    console.log(`\n[Tahap 2] Membangun/Update Vector Store dengan ${docsToProcess.length} potongan dokumen...`);

    if (isRebuildMode && fs.existsSync(indexSavePath)) {
        console.log("  -> Menghapus Vector Store lama...");
        fs.rmSync(indexSavePath, { recursive: true, force: true });
    }

    let vectorStore;
    console.time("⏱ Total Embedding + Indexing");

    const total = docsToProcess.length;
    console.log(`📦 Ukuran batch: ${BATCH_SIZE}`);
    console.log(`📊 Estimasi jumlah batch: ${Math.ceil(total / BATCH_SIZE)}\n`);

    if (isRebuildMode || !fs.existsSync(indexSavePath)) {
        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = docsToProcess.slice(i, i + BATCH_SIZE);
            const start = i + 1;
            const end = Math.min(i + BATCH_SIZE, total);
            const batchNumber = Math.floor(i / BATCH_SIZE) + 1;

            try {
                if (!vectorStore) {
                    vectorStore = await FaissStore.fromDocuments(batch, embeddings);
                } else {
                    await vectorStore.addDocuments(batch);
                }
                console.log(`    -> Menambahkan batch ${batchNumber}: dokumen ${start}-${end} (${batch.length} chunk)`);
            } catch (err) {
                console.error(`❌ Gagal batch ${start}-${end}: ${err.message}`);
            }
        }
    } else {
        vectorStore = await FaissStore.load(indexSavePath, embeddings);
        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = docsToProcess.slice(i, i + BATCH_SIZE);
            const start = i + 1;
            const end = Math.min(i + BATCH_SIZE, total);
            const batchNumber = Math.floor(i / BATCH_SIZE) + 1;

            try {
                await vectorStore.addDocuments(batch);
                console.log(`    -> Menambahkan batch ${batchNumber}: dokumen ${start}-${end} (${batch.length} chunk)`);
            } catch (err) {
                console.error(`❌ Gagal batch ${start}-${end}: ${err.message}`);
            }
        }
    }

    await vectorStore.save(indexSavePath);
    console.log(`\n✅ Total ${total} chunk berhasil diindex ke vector store.`);
    console.timeEnd("⏱ Total Embedding + Indexing");
    console.log(`\n✅ Vector Store berhasil disimpan di '${indexSavePath}'`);
    const docstorePath = path.join(indexSavePath, 'docstore.json');
    if (fs.existsSync(docstorePath)) {
        try {
            const raw = fs.readFileSync(docstorePath, 'utf-8');
            const parsed = JSON.parse(raw);
            fs.writeFileSync(docstorePath, JSON.stringify(parsed, null, 2)); // format dengan indentasi 2 spasi
            console.log("📄 'docstore.json' telah dirapikan agar mudah dibaca.");
        } catch (err) {
            console.warn("⚠️ Gagal merapikan docstore.json:", err.message);
        }
    }

}

main()
    .catch(err => console.error("\n💥 KESALAHAN FATAL:", err))
    .finally(async () => {
        await terminateOcr();
        await db.pool.end();
        console.log("\n✨ Proses indexing selesai.");
    });
