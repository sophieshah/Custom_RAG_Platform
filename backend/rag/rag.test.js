import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AdminConfigStore } from "./admin-config.js";
import { createAdminRouter } from "./admin-router.js";
import { prepareAgentMessages } from "./agent.js";
import { createChatRouter } from "./chat-router.js";
import { chunkDocumentPages, chunkText, stablePointId } from "./documents.js";
import { formatEvidence, formatSourceList, searchGuidance } from "./retrieval.js";
import { QdrantClient } from "./qdrant.js";
import {
  readSystemInstructionsFromSource,
  TB_PUBLIC_HEALTH_INSTRUCTIONS,
  withAdminInstructions,
} from "./system-instructions.js";
import { logRagStep } from "./trace.js";

if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";

async function withChatServer({
  openai,
  qdrant,
  embedQuery = async () => [0.1, 0.2],
}, run) {
  const app = express();
  app.use(express.json());
  app.use(createChatRouter({ openai, qdrant, embedQuery, model: "test-model" }));

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test("RAG tracing includes development details and suppresses them in production", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalConsoleLog = console.log;
  const output = [];
  console.log = (...args) => output.push(args.join(" "));

  try {
    process.env.NODE_ENV = "development";
    logRagStep("Retrieved guidance.", { sourceCount: 1 });
    assert.match(output[0], /Retrieved guidance/);
    assert.match(output[0], /sourceCount/);

    output.length = 0;
    process.env.NODE_ENV = "production";
    logRagStep("Sensitive production detail.", { community_risk: "high" });
    assert.deepEqual(output, []);
  } finally {
    console.log = originalConsoleLog;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test("chunkText keeps chunks within configured length and applies overlap", () => {
  const chunks = chunkText("abcdefghij klmnopqrst uvwxyz", {
    maxChars: 12,
    overlapChars: 3,
  });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 12));
  assert.match(chunks[0], /^abcdefghij/);
  assert.ok(chunks.some((chunk) => chunk.includes("uvwxyz")));
});

test("chunkText returns no chunks for empty input and validates options", () => {
  assert.deepEqual(chunkText("  \n "), []);
  assert.throws(() => chunkText("text", { maxChars: 4, overlapChars: 4 }), /overlapChars/);
});

test("chunkDocumentPages preserves PDF page references", () => {
  const chunks = chunkDocumentPages([
    { pageNumber: 2, text: "Guidance from page two." },
    { pageNumber: 3, text: "Guidance from page three." },
  ]);

  assert.deepEqual(chunks.map((chunk) => chunk.pageNumber), [2, 3]);
});

test("stablePointId returns a deterministic UUID", () => {
  const first = stablePointId("guide.pdf", 3, "passage");
  assert.equal(first, stablePointId("guide.pdf", 3, "passage"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("ensureCollection creates a missing collection with configured dimensions", async () => {
  const calls = [];
  const qdrant = new QdrantClient({
    url: "http://qdrant.test",
    collection: "test-guides",
    dimensions: 3,
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (calls.length === 1) return new Response("", { status: 404 });
      return new Response(JSON.stringify({ result: { status: "ok" } }), { status: 200 });
    },
  });

  await qdrant.ensureCollection();

  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, "PUT");
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    vectors: { size: 3, distance: "Cosine" },
  });
});

test("ensureCollection rejects an existing collection with incompatible dimensions", async () => {
  const qdrant = new QdrantClient({
    dimensions: 3,
    fetchImpl: async () => new Response(JSON.stringify({
      result: { config: { params: { vectors: { size: 4 } } } },
    }), { status: 200 }),
  });

  await assert.rejects(qdrant.ensureCollection(), /expected 3/);
});

test("search sends vector and limit and returns ranked matches", async () => {
  let requestBody;
  const qdrant = new QdrantClient({
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ result: [{ id: "point-1", score: 0.9 }] }), {
        status: 200,
      });
    },
  });

  const matches = await qdrant.search([0.1, 0.2], 5);

  assert.deepEqual(requestBody, { vector: [0.1, 0.2], limit: 5, with_payload: true });
  assert.deepEqual(matches, [{ id: "point-1", score: 0.9 }]);
});

test("Qdrant document listing groups chunks across scroll pages and supports source deletion", async () => {
  const calls = [];
  const qdrant = new QdrantClient({
    collection: "test-guides",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith("/points/delete?wait=true")) {
        return new Response(JSON.stringify({ result: { status: "ok" } }), { status: 200 });
      }
      const body = JSON.parse(options.body);
      const page = body.offset === null
        ? {
          points: [
            {
              id: "chunk-1",
              payload: { source_file: "admin_uploads/guide.pdf", title: "Guide" },
            },
            {
              id: "chunk-2",
              payload: { document_id: "legacy-1", document_name: "Legacy.pdf" },
            },
          ],
          next_page_offset: "next-page",
        }
        : {
          points: [{
            id: "chunk-3",
            payload: { source_file: "admin_uploads/guide.pdf", title: "Guide" },
          }],
          next_page_offset: null,
        };
      return new Response(JSON.stringify({ result: page }), { status: 200 });
    },
  });

  const documents = await qdrant.listDocuments();
  assert.deepEqual(documents, [
    {
      sourceFile: "admin_uploads/guide.pdf",
      sourceKey: "source_file",
      title: "Guide",
      pointCount: 2,
    },
    {
      sourceFile: "legacy-1",
      sourceKey: "document_id",
      title: "Legacy.pdf",
      pointCount: 1,
    },
  ]);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1].options.body).offset, "next-page");

  await qdrant.deleteBySource("legacy-1", "document_id");
  assert.equal(calls.length, 3);
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    filter: { must: [{ key: "document_id", match: { value: "legacy-1" } }] },
  });
  await assert.rejects(qdrant.deleteBySource("legacy-1", "payload"), /Unsupported Qdrant/);
});

test("retrieval uses the configured local query embedding and the Python index payload shape", async () => {
  let queriedVector;
  const evidence = await searchGuidance({
    embedQuery: async (query) => {
      assert.equal(query, "Should the patient remain isolated?");
      return [0.1, 0.2];
    },
    qdrant: {
      search: async (vector) => {
        queriedVector = vector;
        return [{
          id: "point-python",
          score: 0.88,
          payload: {
            content: "Evidence from the Python PDF index.",
            document_name: "Guideline.pdf",
            document_id: "doc-123",
            page: 8,
            parent_id: "parent-1",
          },
        }];
      },
    },
    query: "Should the patient remain isolated?",
  });

  assert.deepEqual(queriedVector, [0.1, 0.2]);
  assert.equal(evidence[0].text, "Evidence from the Python PDF index.");
  assert.equal(evidence[0].title, "Retrieved TB guidance");
  assert.equal(evidence[0].sourceFile, "Guideline.pdf");
  assert.equal(evidence[0].pageNumber, 8);
});

test("retrieval uses the approved teaching-case citation name without exposing filenames", async () => {
  const [retrieved] = await searchGuidance({
    embedQuery: async () => [0.1, 0.2],
    qdrant: {
      search: async () => [{
        id: "casebook-point",
        score: 0.9,
        payload: {
          content: "A representative teaching case.",
          source_file: "NTCA_TB_Isolation_Teaching_Cases_2_22_26.pdf",
          page: 4,
        },
      }],
    },
    query: "community TB teaching cases",
  });
  const evidence = { ...retrieved, reference: "S1" };

  assert.equal(evidence.title, "The NTCA Teaching Cases");
  assert.match(formatEvidence([evidence]), /\[S1\] The NTCA Teaching Cases \(page 4\)/);
  assert.match(formatSourceList([evidence]), /\[S1\] The NTCA Teaching Cases, page 4/);
  assert.doesNotMatch(formatEvidence([evidence]), /2_22_26|\.pdf/);
  assert.doesNotMatch(formatSourceList([evidence]), /2_22_26|\.pdf/);
});

test("agent performs one initial search and at most one model-requested follow-up", async () => {
  const embeddingInputs = [];
  let searchCount = 0;
  let assessmentMessages;
  const openai = {
    chat: {
      completions: {
        create: async ({ messages }) => {
          assessmentMessages = messages;
          return {
            choices: [{
              message: {
                tool_calls: [{
                  id: "call-follow-up",
                  type: "function",
                  function: {
                    name: "search_tb_guidance",
                    arguments: JSON.stringify({ query: "isolation discontinuation criteria" }),
                  },
                }],
              },
            }],
          };
        },
      },
    },
  };
  const qdrant = {
    search: async () => {
      searchCount += 1;
      return [{
        id: `point-${searchCount}`,
        score: 0.9,
        payload: {
          title: "Guideline",
          source_file: "guideline.pdf",
          chunk_index: searchCount,
          text: `Evidence ${searchCount}`,
        },
      }];
    },
  };

  const result = await prepareAgentMessages({
    openai,
    qdrant,
    model: "test-model",
    request: {
      message: "When may isolation stop?",
      conversationHistory: [],
      additionalSystemInstructions: "Use short paragraphs for general explanations.",
      embedQuery: async (query) => {
        embeddingInputs.push(query);
        return [0.1, 0.2];
      },
    },
  });

  assert.equal(searchCount, 2);
  assert.deepEqual(embeddingInputs, [
    "When may isolation stop?",
    "isolation discontinuation criteria",
  ]);
  assert.deepEqual(result.evidence.map((item) => item.reference), ["S1", "S2"]);
  assert.match(assessmentMessages[0].content, /educational public-health guidance/i);
  assert.match(assessmentMessages[0].content, /Ground clinical and guideline claims in the retrieved passages/i);
  assert.match(assessmentMessages[0].content, /internal retrieval filenames/i);
  assert.match(assessmentMessages[0].content, /individualized medical or legal advice/i);
  assert.match(assessmentMessages[0].content, /Use short paragraphs for general explanations/);
  assert.match(assessmentMessages[0].content, /mandatory instructions above take precedence/i);
  assert.doesNotMatch(assessmentMessages.at(-1).content, /guideline\.pdf/);
});

test("administrator instructions are supplemental and cannot supersede required policies", () => {
  const composed = withAdminInstructions("Mandatory grounding policy.", "Use concise headings.");
  assert.ok(composed.indexOf("Mandatory grounding policy.") < composed.indexOf("Use concise headings."));
  assert.match(composed, /mandatory instructions above take precedence/i);
  assert.equal(withAdminInstructions("Mandatory grounding policy.", "  "), "Mandatory grounding policy.");
});

test("system instruction editor reads and safely saves multiline instructions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-instructions-test-"));
  try {
    const sourcePath = fileURLToPath(new URL("./system-instructions.js", import.meta.url));
    const modulePath = path.join(directory, "system-instructions.mjs");
    await copyFile(sourcePath, modulePath);
    const instructionsModule = await import(pathToFileURL(modulePath).href);
    assert.equal(
      await instructionsModule.readSystemInstructionsFromSource(),
      TB_PUBLIC_HEALTH_INSTRUCTIONS,
    );

    const updatedInstructions = 'Use "clear" language with `code` and multiple\nlines.';
    await instructionsModule.saveSystemInstructionsToSource(updatedInstructions);
    assert.equal(
      await instructionsModule.readSystemInstructionsFromSource(),
      updatedInstructions,
    );
    assert.equal(instructionsModule.TB_PUBLIC_HEALTH_INSTRUCTIONS, updatedInstructions);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("admin endpoints authenticate, reject malformed instructions, and index uploaded files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tb-admin-test-"));
  const configStore = new AdminConfigStore({ directory });
  const indexedPoints = new Map();
  const app = express();
  app.use(express.json());
  app.locals.adminConfig = configStore;
  app.locals.embeddingWorker = {
    embedPassages: async (texts) => texts.map(() => [0.1, 0.2]),
  };
  app.locals.qdrant = {
    upsert: async (points) => points.forEach((point) => indexedPoints.set(point.id, point)),
    listDocuments: async () => {
      const documents = new Map();
      for (const point of indexedPoints.values()) {
        const sourceFile = point.payload.source_file;
        const document = documents.get(sourceFile) || {
          sourceFile,
          sourceKey: "source_file",
          title: point.payload.title,
          pointCount: 0,
        };
        document.pointCount += 1;
        documents.set(sourceFile, document);
      }
      return [...documents.values()];
    },
    deleteBySource: async (sourceFile, sourceKey) => {
      for (const [id, point] of indexedPoints) {
        if (point.payload[sourceKey] === sourceFile) indexedPoints.delete(id);
      }
    },
    scrollBySource: async (sourceFile) => ({
      points: [...indexedPoints.values()]
        .filter((point) => point.payload.source_file === sourceFile)
        .map((point) => ({ id: point.id })),
      next_page_offset: null,
    }),
    deletePoints: async (ids) => ids.forEach((id) => indexedPoints.delete(id)),
  };
  app.use("/api/admin", createAdminRouter({
    username: "operator",
    password: "a-very-long-test-password",
  }));

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/admin`;
  try {
    const forbidden = await fetch(`${url}/instructions`);
    assert.equal(forbidden.status, 401);
    const forbiddenDocuments = await fetch(`${url}/documents`);
    assert.equal(forbiddenDocuments.status, 401);

    const loginResponse = await fetch(`${url}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "operator", password: "a-very-long-test-password" }),
    });
    assert.equal(loginResponse.status, 200);
    const { token } = await loginResponse.json();
    const headers = { Authorization: `Bearer ${token}` };

    const saveResponse = await fetch(`${url}/instructions`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ additionalInstructions: "Use concise headings." }),
    });
    assert.equal(saveResponse.status, 400);
    assert.match((await saveResponse.json()).error, /must be text/i);

    const unsupportedForm = new FormData();
    unsupportedForm.append("file", new Blob(["executable-like content"]), "payload.exe");
    const unsupportedResponse = await fetch(`${url}/documents`, {
      method: "POST",
      headers,
      body: unsupportedForm,
    });
    assert.equal(unsupportedResponse.status, 400);
    assert.equal(indexedPoints.size, 0);

    const form = new FormData();
    form.append("file", new Blob(["One paragraph of guidance for the retrieval index."]), "../quick-reference.txt");
    const uploadResponse = await fetch(`${url}/documents`, {
      method: "POST",
      headers,
      body: form,
    });
    assert.equal(uploadResponse.status, 200);
    const uploadResult = await uploadResponse.json();
    assert.equal(uploadResult.filename, "quick-reference.txt");
    assert.equal(uploadResult.chunkCount, 1);
    assert.equal(indexedPoints.size, 1);
    assert.equal([...indexedPoints.values()][0].payload.source_file, "admin_uploads/quick-reference.txt");
    assert.equal(
      await readFile(path.join(directory, "uploads", "quick-reference.txt"), "utf8"),
      "One paragraph of guidance for the retrieval index.",
    );

    const replacementForm = new FormData();
    replacementForm.append("file", new Blob(["Updated guidance replaces the previous file contents."]), "quick-reference.txt");
    const replacementResponse = await fetch(`${url}/documents`, {
      method: "POST",
      headers,
      body: replacementForm,
    });
    assert.equal(replacementResponse.status, 200);
    assert.equal(indexedPoints.size, 1);
    assert.equal(
      await readFile(path.join(directory, "uploads", "quick-reference.txt"), "utf8"),
      "Updated guidance replaces the previous file contents.",
    );

    const listResponse = await fetch(`${url}/documents`, { headers });
    assert.equal(listResponse.status, 200);
    const listedDocuments = await listResponse.json();
    assert.deepEqual(listedDocuments.documents, [{
      sourceFile: "admin_uploads/quick-reference.txt",
      sourceKey: "source_file",
      title: "quick reference",
      pointCount: 1,
    }]);

    const invalidDelete = await fetch(`${url}/documents`, {
      method: "DELETE",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceFile: "../quick-reference.txt" }),
    });
    assert.equal(invalidDelete.status, 404);

    const deleteResponse = await fetch(`${url}/documents`, {
      method: "DELETE",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ sourceFile: "admin_uploads/quick-reference.txt" }),
    });
    assert.equal(deleteResponse.status, 200);
    assert.equal(indexedPoints.size, 0);
    await assert.rejects(
      readFile(path.join(directory, "uploads", "quick-reference.txt"), "utf8"),
      { code: "ENOENT" },
    );

    const logoutResponse = await fetch(`${url}/logout`, { method: "POST", headers });
    assert.equal(logoutResponse.status, 204);
    const loggedOut = await fetch(`${url}/instructions`, { headers });
    assert.equal(loggedOut.status, 401);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await rm(directory, { recursive: true, force: true });
  }
});

test("chat route streams an answer followed by its source citation", async () => {
  let embeddedQuery;
  let generatedMessages;
  const openai = {
    chat: {
      completions: {
        create: async (request) => {
          if (!request.stream) {
            generatedMessages = request.messages;
            return { choices: [{ message: {} }] };
          }
          return {
            async *[Symbol.asyncIterator]() {
              yield { choices: [{ delta: { content: "Guidance summary." } }] };
            },
          };
        },
      },
    },
  };
  const qdrant = {
    search: async () => [{
      id: "source-1",
      score: 0.95,
      payload: {
        text: "Isolation guidance evidence.",
        source_file: "guideline.pdf",
        title: "TB Guideline",
        chunk_index: 0,
        page_number: 7,
      },
    }],
  };

  await withChatServer({
    openai,
    qdrant,
    embedQuery: async (query) => {
      embeddedQuery = query;
      return [0.1, 0.2];
    },
  }, async (url) => {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "When can isolation end?",
        conversationHistory: [{ role: "assistant", content: "Previous answer context." }],
        patientContext: "Patient reports a persistent cough.",
        structuredData: {
          bacterialBurden: "High",
          treatmentDays: "12",
        },
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/plain/);
    assert.equal(
      await response.text(),
      "Guidance summary.\n\nSources:\n[S1] TB Guideline, page 7",
    );
  });

  assert.deepEqual(embeddedQuery, "When can isolation end?");
  assert.ok(generatedMessages.some((item) => item.content === "Previous answer context."));
  const userMessage = generatedMessages.find((item) => (
    item.role === "user" && item.content.includes("Question:\nWhen can isolation end?")
  ));
  assert.match(userMessage.content, /Patient reports a persistent cough/);
  assert.match(userMessage.content, /bacterialBurden: High/);
  assert.match(userMessage.content, /treatmentDays: 12/);
  assert.match(userMessage.content, /not guideline evidence/);
});

test("chat route validates input and returns a no-evidence fallback", async () => {
  let embeddingCalls = 0;
  let generatedCalls = 0;
  const openai = {
    chat: {
      completions: {
        create: async (request) => {
          generatedCalls += 1;
          return { choices: [{ message: {} }] };
        },
      },
    },
  };
  const qdrant = { search: async () => [] };

  await withChatServer({
    openai,
    qdrant,
    embedQuery: async () => {
      embeddingCalls += 1;
      return [0.1, 0.2];
    },
  }, async (url) => {
    const invalid = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    assert.equal(invalid.status, 400);

    const invalidContext = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Question", patientContext: { unexpected: true } }),
    });
    assert.equal(invalidContext.status, 400);

    const invalidStructuredData = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Question", structuredData: { labs: ["nested"] } }),
    });
    assert.equal(invalidStructuredData.status, 400);

    const noEvidence = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Question without indexed evidence" }),
    });
    assert.equal(noEvidence.status, 200);
    assert.match(await noEvidence.text(), /couldn't find supporting TB guidance/i);
  });

  assert.equal(embeddingCalls, 1);
  assert.equal(generatedCalls, 1);
});
