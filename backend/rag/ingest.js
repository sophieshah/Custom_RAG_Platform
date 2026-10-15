import "dotenv/config";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { titleFromPath } from "./documents.js";
import { LocalEmbeddingWorker } from "./local-embeddings.js";
import { QdrantClient } from "./qdrant.js";
import { indexDocument } from "./index-document.js";

const dimensions = Number(process.env.EMBEDDING_DIMENSION || 1024);
const knowledgeDir = path.resolve(process.env.NODE_KNOWLEDGE_DIR || "knowledge-base");

async function collectDocuments(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectDocuments(entryPath));
    } else if ([".md", ".txt", ".pdf"].includes(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

async function syncSourceFile(embeddingWorker, qdrant, filePath) {
  const relativePath = path.relative(knowledgeDir, filePath).split(path.sep).join("/");
  const count = await indexDocument({
    filePath,
    sourceFile: relativePath,
    title: titleFromPath(filePath),
    embeddingWorker,
    qdrant,
  });
  console.log(`Indexed ${count} chunks from ${relativePath}`);
  return count;
}

async function main() {
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error("EMBEDDING_DIMENSION must be a positive integer.");
  }

  const files = await collectDocuments(knowledgeDir);
  if (files.length === 0) {
    throw new Error(`No .md, .txt, or .pdf source documents found under ${knowledgeDir}.`);
  }

  const embeddingWorker = new LocalEmbeddingWorker();
  const qdrant = new QdrantClient({ dimensions });
  try {
    await embeddingWorker.start();
    if (embeddingWorker.dimension !== dimensions) {
      throw new Error(
        `Embedding model returned ${embeddingWorker.dimension} dimensions; configured collection uses ${dimensions}.`,
      );
    }
    await qdrant.ensureCollection();

    let totalChunks = 0;
    for (const filePath of files) {
      totalChunks += await syncSourceFile(embeddingWorker, qdrant, filePath);
    }
    console.log(`Ingestion complete: ${files.length} documents, ${totalChunks} chunks.`);
  } finally {
    await embeddingWorker.close();
  }
}

main().catch((error) => {
  console.error("Document ingestion failed:", error);
  process.exitCode = 1;
});
