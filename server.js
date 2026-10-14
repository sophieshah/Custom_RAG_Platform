import "dotenv/config";
import cors from "cors";
import express from "express";
import OpenAI from "openai";
import { createChatRouter } from "./backend/rag/chat-router.js";
import { LocalEmbeddingWorker } from "./backend/rag/local-embeddings.js";
import { QdrantClient } from "./backend/rag/qdrant.js";

const requiredEnvironment = ["OPENAI_API_KEY"];
for (const key of requiredEnvironment) {
  if (!process.env[key]) throw new Error(`${key} is required.`);
}

const embeddingDimensions = Number(process.env.EMBEDDING_DIMENSION || 1024);
if (!Number.isInteger(embeddingDimensions) || embeddingDimensions < 1) {
  throw new Error("EMBEDDING_DIMENSION must be a positive integer.");
}

const app = express();
app.use(cors({ exposedHeaders: ["X-TB-Case-State"] }));
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const qdrant = new QdrantClient({ dimensions: embeddingDimensions });
const embeddingWorker = new LocalEmbeddingWorker();
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
const port = Number(process.env.PORT || 3001);

await qdrant.ensureCollection();
await embeddingWorker.start();
if (embeddingWorker.dimension !== embeddingDimensions) {
  await embeddingWorker.close();
  throw new Error(
    `Embedding model returned ${embeddingWorker.dimension} dimensions; Qdrant is configured for ${embeddingDimensions}.`,
  );
}
app.use(createChatRouter({
  openai: client,
  qdrant,
  model,
  embedQuery: (text) => embeddingWorker.embedQueries([text]).then(([vector]) => vector),
}));

const server = app.listen(port, () => {
  console.log(`Backend running at http://localhost:${port}`);
  console.log(`Qdrant collection: ${qdrant.collection}`);
  console.log(`Local embedding model: ${process.env.EMBEDDING_MODEL || "intfloat/e5-large-v2"}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    server.close(() => {
      embeddingWorker.close().finally(() => {
        process.exitCode = 0;
      });
    });
  });
}
