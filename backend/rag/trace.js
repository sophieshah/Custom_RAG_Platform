export function logRagStep(step, details) {
  if (process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test") return;
  if (details === undefined) {
    console.log(`[tb-rag] ${step}`);
    return;
  }
  console.log(`[tb-rag] ${step}\n${JSON.stringify(details, null, 2)}`);
}
