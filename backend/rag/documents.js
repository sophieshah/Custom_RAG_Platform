import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";

const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".pdf"]);

export async function extractDocumentPages(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(`Unsupported document type "${extension}" for ${filePath}. Use .md, .txt, or .pdf.`);
  }

  if (extension !== ".pdf") {
    return [{ pageNumber: null, text: (await readFile(filePath, "utf8")).trim() }];
  }

  const parser = new PDFParse({ data: new Uint8Array(await readFile(filePath)) });
  try {
    const result = await parser.getText();
    if (result.pages.length === 0 && result.text.trim()) {
      return [{ pageNumber: null, text: result.text.trim() }];
    }
    return result.pages.map((page) => ({
      pageNumber: page.num,
      text: page.text.trim(),
    }));
  } finally {
    await parser.destroy();
  }
}

export function chunkText(text, { maxChars = 2800, overlapChars = 300 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error("maxChars must be a positive integer.");
  }
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars) {
    throw new Error("overlapChars must be a non-negative integer smaller than maxChars.");
  }

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      const paragraphBoundary = normalized.lastIndexOf("\n\n", end);
      const minimumBoundary = start + Math.floor(maxChars * 0.6);
      if (paragraphBoundary >= minimumBoundary) {
        end = paragraphBoundary;
      } else {
        const wordBoundary = normalized.lastIndexOf(" ", end);
        if (wordBoundary > start + Math.floor(maxChars * 0.7)) end = wordBoundary;
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - overlapChars);
  }
  return chunks;
}

export function chunkDocumentPages(pages, options) {
  return pages.flatMap(({ pageNumber, text }) => (
    chunkText(text, options).map((chunk) => ({ pageNumber, text: chunk }))
  ));
}

export function stablePointId(sourceFile, chunkIndex, content) {
  const digest = createHash("sha256")
    .update(`${sourceFile}\0${chunkIndex}\0${content}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  digest[12] = "5";
  digest[16] = ((parseInt(digest[16], 16) & 0x3) | 0x8).toString(16);
  const value = digest.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function titleFromPath(filePath) {
  return path.basename(filePath, path.extname(filePath)).replace(/[_-]+/g, " ");
}
