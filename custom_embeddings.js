// ✅ Custom Embedding Class untuk LangChain menggunakan Transformers lokal (Xenova)
const { Embeddings } = require("@langchain/core/embeddings");

class CustomHuggingFaceEmbeddings extends Embeddings {
    constructor() {
        super({ maxConcurrency: 5 });
        this.pipeline = null;
        this.modelName = "Xenova/gte-base";
    }

    async _getPipeline() {
        if (this.pipeline === null) {
            const { pipeline, env } = await import('@xenova/transformers');

            env.allowLocalModels = true;
            env.cacheDir = './.cache';   

            console.log(`\nMemuat model embedding lokal: '${this.modelName}' (hanya sekali saat pertama kali)...`);
            this.pipeline = await pipeline("feature-extraction", this.modelName);
            console.log("✅ Model embedding lokal berhasil dimuat dan siap digunakan.");
        }
        return this.pipeline;
    }

    async _embed(texts) {
        const pipe = await this._getPipeline();
        const embeddings = await pipe(texts, { pooling: "mean", normalize: true });
        return embeddings.tolist();
    }

    embedDocuments(texts) {
        return this._embed(texts);
    }

    embedQuery(text) {
        return this._embed([text]).then(embeddings => embeddings[0]);
    }
}

module.exports = { CustomHuggingFaceEmbeddings };
