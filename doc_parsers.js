const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const mammoth = require("mammoth");
const csv = require("csv-parser");
const { createCanvas } = require("canvas");
const { createWorker } = require("tesseract.js");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");

let ocrWorker;
const textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });

// 🔧 Inisialisasi Tesseract
async function initializeOcr() {
    if (ocrWorker) return;
    console.log("  🧠 Inisialisasi OCR worker...");
    ocrWorker = await createWorker("ind");
    console.log("  ✅ OCR Worker siap.");
}

// 🧹 Hentikan OCR Worker
async function terminateOcr() {
    if (ocrWorker) {
        await ocrWorker.terminate();
        console.log("  🧹 OCR Worker dihentikan.");
        ocrWorker = null;
    }
}

// 🔍 OCR fallback untuk PDF yang tidak bisa diekstrak teksnya
async function ocrPdfFromBuffer(pdfBuffer) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.js");
    const getDocument = pdfjs.getDocument || pdfjs.default.getDocument;

    class NodeCanvasFactory {
        create(width, height) {
            const canvas = createCanvas(width, height);
            return { canvas, context: canvas.getContext("2d") };
        }
        reset(canvasAndContext, width, height) {
            canvasAndContext.canvas.width = width;
            canvasAndContext.canvas.height = height;
        }
        destroy(canvasAndContext) { /* no-op */ }
    }

    await initializeOcr();

    const factory = new NodeCanvasFactory();
    const pdf = await getDocument({ data: pdfBuffer, canvasFactory: factory }).promise;

    const allPagesText = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        console.log(`  📄 OCR halaman ${i}/${pdf.numPages}`);
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvasAndContext = factory.create(viewport.width, viewport.height);
        await page.render({ canvasContext: canvasAndContext.context, viewport }).promise;
        const imageBuffer = canvasAndContext.canvas.toBuffer("image/png");
        const result = await ocrWorker.recognize(imageBuffer);
        allPagesText.push(result.data.text);
    }

    return allPagesText.join("\n\n");
}

// 📄 Ekstrak teks dari PDF (auto fallback ke OCR jika teks sedikit)
async function extractTextFromPdf(filePath) {
    const fileData = new Uint8Array(fs.readFileSync(filePath));
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.js");
    const getDocument = pdfjs.getDocument || pdfjs.default.getDocument;

    async function extractTextContent(data) {
        const pdf = await getDocument({ data }).promise;
        let text = "";
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            text += content.items.map(item => item.str).join(" ") + "\n\n";
        }
        return text;
    }

    let text = await extractTextContent(fileData).catch(() => "");
    if (text.trim().length < 200) {
        console.log("  ⚠️  Teks PDF terlalu sedikit, fallback ke OCR...");
        const start = Date.now();
        text = await ocrPdfFromBuffer(fileData);
        console.log(`  🧠 OCR selesai dalam ${(Date.now() - start) / 1000}s`);
    }

    return textSplitter.createDocuments([text]);
}

// 📄 Ekstrak teks dari DOCX (Word)
async function extractTextFromDocx(filePath) {
    const result = await mammoth.extractRawText({ path: filePath });
    return textSplitter.createDocuments([result.value]);
}

// 📊 Ekstrak teks dari XLSX (Excel)
async function extractTextFromXlsx(filePath) {
    const workbook = XLSX.readFile(filePath);
    let fullText = "";
    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        fullText += `--- Sheet: ${sheetName} ---\n${XLSX.utils.sheet_to_csv(sheet)}\n\n`;
    }
    return textSplitter.createDocuments([fullText]);
}

// ✅ Ekspor fungsi-fungsi
module.exports = {
    extractTextFromPdf,
    extractTextFromDocx,
    extractTextFromXlsx,
    terminateOcr
};
