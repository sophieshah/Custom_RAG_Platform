import "dotenv/config";
import cors from "cors";
import express from "express";
import OpenAI from "openai";
import { AdminConfigStore } from "./backend/rag/admin-config.js";
import { createAdminRouter } from "./backend/rag/admin-router.js";
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
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const qdrant = new QdrantClient({ dimensions: embeddingDimensions });
const embeddingWorker = new LocalEmbeddingWorker();
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
const port = Number(process.env.PORT || 3001);
const adminUsername = process.env.ADMIN_USERNAME;
const adminPassword = process.env.ADMIN_PASSWORD;
if (Boolean(adminUsername) !== Boolean(adminPassword)) {
  throw new Error("Set both ADMIN_USERNAME and ADMIN_PASSWORD to enable admin access.");
}
if (adminPassword && adminPassword.length < 14) {
  throw new Error("ADMIN_PASSWORD must be at least 14 characters.");
}
const adminConfig = new AdminConfigStore();

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
  getAdditionalInstructions: () => adminConfig.getAdditionalInstructions(),
  getInputConfig: () => adminConfig.getInputConfig(),
}));
app.locals.adminConfig = adminConfig;
app.locals.embeddingWorker = embeddingWorker;
app.locals.qdrant = qdrant;
app.use("/api/admin", createAdminRouter({
  username: adminUsername,
  password: adminPassword,
}));
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  console.error("Unhandled API error:", error instanceof Error ? error.message : "Unknown error");
  return res.status(500).json({ error: "The server could not complete the request." });
});

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
