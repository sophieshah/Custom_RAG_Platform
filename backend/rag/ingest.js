import "dotenv/config";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { chunkDocumentPages, extractDocumentPages, stablePointId, titleFromPath } from "./documents.js";
import { LocalEmbeddingWorker } from "./local-embeddings.js";
import { QdrantClient } from "./qdrant.js";

const BATCH_SIZE = 64;
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
  const pages = await extractDocumentPages(filePath);
  const chunks = chunkDocumentPages(pages);
  if (chunks.length === 0) {
    throw new Error(`Document contains no extractable text: ${relativePath}`);
  }

  const pointIds = [];
  for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
    const batch = chunks.slice(start, start + BATCH_SIZE);
    const vectors = await embeddingWorker.embedPassages(batch.map((chunk) => chunk.text));
    const points = batch.map((chunk, batchIndex) => {
      const chunkIndex = start + batchIndex;
      const id = stablePointId(relativePath, chunkIndex, chunk.text);
      pointIds.push(id);
      return {
        id,
        vector: vectors[batchIndex],
        payload: {
          text: chunk.text,
          source_file: relativePath,
          title: titleFromPath(filePath),
          chunk_index: chunkIndex,
          ...(chunk.pageNumber === null ? {} : { page_number: chunk.pageNumber }),
        },
      };
    });
    await qdrant.upsert(points);
  }

  let offset = null;
  const staleIds = [];
  const indexedIds = new Set(pointIds);
  do {
    const page = await qdrant.scrollBySource(relativePath, offset);
    staleIds.push(...page.points.map((point) => point.id).filter((id) => !indexedIds.has(id)));
    offset = page.next_page_offset;
  } while (offset !== null && offset !== undefined);
  await qdrant.deletePoints(staleIds);
  console.log(`Indexed ${chunks.length} chunks from ${relativePath}`);
  return chunks.length;
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
