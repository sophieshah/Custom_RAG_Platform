export const RESULT_LIMIT = 8;
export const MAX_EVIDENCE_CHARS = 4000;

function sourceTitle(payload) {
  const title = typeof payload.title === "string" && payload.title.trim()
    ? payload.title.trim().split(/[\\/]/).at(-1).replace(/\.[^.]+$/, "").replaceAll("_", " ")
    : "Retrieved TB guidance";
  const sourceIdentity = [
    title,
    payload.document_name,
    payload.source_file,
  ].filter(Boolean).join(" ");
  if (/ntca.*teaching.*case|teaching.*case.*ntca/i.test(sourceIdentity)) return "The NTCA Teaching Cases";
  return title;
}

export async function embedText(text, embedQuery) {
  if (typeof embedQuery !== "function") {
    throw new Error("The configured local query-embedding worker is not available.");
  }

  const vector = await embedQuery(text);
  if (!Array.isArray(vector) || vector.length === 0 || !vector.every(Number.isFinite)) {
    throw new Error("The configured local embedding model returned an invalid vector.");
  }
  return vector;
}

export async function searchGuidance({ embedQuery, qdrant, query }) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) throw new Error("A non-empty retrieval query is required.");

  const vector = await embedText(normalizedQuery, embedQuery);
  const results = await qdrant.search(vector, RESULT_LIMIT);
  return results
    .filter((result) => (
      typeof (result.payload?.text || result.payload?.content) === "string" &&
      (result.payload.text || result.payload.content).trim()
    ))
    .map((result) => ({
      id: result.id,
      score: result.score,
      title: sourceTitle(result.payload),
      sourceFile: result.payload.source_file || result.payload.document_name || result.payload.document_id || "Unknown source",
      chunkIndex: result.payload.chunk_index ?? result.payload.parent_id ?? result.id,
      pageNumber: result.payload.page_number ?? result.payload.page,
      text: (result.payload.text || result.payload.content).slice(0, MAX_EVIDENCE_CHARS),
    }));
}

export function mergeEvidence(primary, followUp) {
  const combined = [...primary];
  const knownIds = new Set(primary.map((item) => String(item.id)));
  for (const item of followUp) {
    const key = String(item.id);
    if (!knownIds.has(key)) {
      knownIds.add(key);
      combined.push(item);
    }
  }
  return combined.map((item, index) => ({ ...item, reference: `S${index + 1}` }));
}

export function formatEvidence(evidence) {
  if (evidence.length === 0) return "No matching guidance passages were found.";
  return evidence.map((item) => (
    `[${item.reference}] ${item.title} (${item.pageNumber ? `page ${item.pageNumber}` : "retrieved passage"})\n${item.text}`
  )).join("\n\n");
}

export function formatSourceList(evidence) {
  if (evidence.length === 0) return "";
  return `\n\nSources:\n${evidence.map((item) => (
    `[${item.reference}] ${item.title}${item.pageNumber ? `, page ${item.pageNumber}` : ""}`
  )).join("\n")}`;
}
