import { chunkDocumentPages, extractDocumentPages, stablePointId } from "./documents.js";

const BATCH_SIZE = 64;

export async function indexDocument({
  filePath,
  sourceFile,
  title,
  embeddingWorker,
  qdrant,
}) {
  const pages = await extractDocumentPages(filePath);
  const chunks = chunkDocumentPages(pages);
  if (chunks.length === 0) {
    throw new Error(`Document contains no extractable text: ${sourceFile}`);
  }

  const pointIds = [];
  for (let start = 0; start < chunks.length; start += BATCH_SIZE) {
    const batch = chunks.slice(start, start + BATCH_SIZE);
    const vectors = await embeddingWorker.embedPassages(batch.map((chunk) => chunk.text));
    const points = batch.map((chunk, batchIndex) => {
      const chunkIndex = start + batchIndex;
      const id = stablePointId(sourceFile, chunkIndex, chunk.text);
      pointIds.push(id);
      return {
        id,
        vector: vectors[batchIndex],
        payload: {
          text: chunk.text,
          source_file: sourceFile,
          title,
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
    const page = await qdrant.scrollBySource(sourceFile, offset);
    staleIds.push(...page.points.map((point) => point.id).filter((id) => !indexedIds.has(id)));
    offset = page.next_page_offset;
  } while (offset !== null && offset !== undefined);
  await qdrant.deletePoints(staleIds);
  return chunks.length;
}
