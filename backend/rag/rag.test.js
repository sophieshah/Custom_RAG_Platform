import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AdminConfigStore } from "./admin-config.js";
import { createAdminRouter } from "./admin-router.js";
import { prepareAgentMessages } from "./agent.js";
import { createChatRouter } from "./chat-router.js";
import { chunkDocumentPages, chunkText, stablePointId } from "./documents.js";
import {
  extractCase,
  validateCaseStateEnvelope,
} from "./decision-support.js";
import { formatEvidence, formatSourceList, searchGuidance } from "./retrieval.js";
import { QdrantClient } from "./qdrant.js";
import { runRuleEngine } from "./rule-engine.js";
import { withAdminInstructions } from "./system-instructions.js";
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

async function loadExampleCase() {
  return JSON.parse(await readFile(
    new URL("../../tb_isolation_rules_package/example_input.json", import.meta.url),
    "utf8",
  ));
}

test("RAG tracing includes development details and suppresses them in production", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalConsoleLog = console.log;
  const output = [];
  console.log = (...args) => output.push(args.join(" "));

  try {
    process.env.NODE_ENV = "development";
    logRagStep("Extracted case.", { community_risk: "moderate" });
    assert.match(output[0], /Extracted case/);
    assert.match(output[0], /community_risk/);

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
      patientContext: "Sensitive patient detail",
      structuredData: {},
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
  assert.match(assessmentMessages[0].content, /educational public-health decision support/i);
  assert.match(assessmentMessages[0].content, /Do not provide individual medical care/i);
  assert.match(assessmentMessages[0].content, /specific file names|internal retrieval filenames/i);
  assert.match(assessmentMessages[0].content, /financial security, social isolation, mental health, housing, food security/i);
  assert.match(assessmentMessages[0].content, /community exposure-risk assessment/i);
  assert.match(assessmentMessages[0].content, /Washington State/i);
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
          if (request.response_format?.json_schema?.name === "tb_task_classification") {
            return { choices: [{ message: { content: JSON.stringify({ task: "guidance" }) } }] };
          }
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
        patientContext: "private context",
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
  assert.ok(generatedMessages.some((item) => item.content?.includes("private context")));
});

test("chat route validates input and returns a no-evidence fallback", async () => {
  let embeddingCalls = 0;
  let generatedCalls = 0;
  const openai = {
    chat: {
      completions: {
        create: async (request) => {
          if (request.response_format?.json_schema?.name === "tb_task_classification") {
            return { choices: [{ message: { content: JSON.stringify({ task: "guidance" }) } }] };
          }
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

test("Python bridge validates and evaluates the existing deterministic case schema", async () => {
  const caseData = await loadExampleCase();
  const validated = await runRuleEngine({ action: "validate", caseData });
  const evaluated = await runRuleEngine({ action: "evaluate", caseData: validated.case });

  assert.equal(validated.case.setting, "unknown");
  assert.equal(evaluated.result.ruleset_version, "0.2.0-user-policy");
  assert.ok(["no restriction", "moderate restrictions", "extensive restrictions", null]
    .includes(evaluated.result.restriction_level));
  assert.equal(evaluated.result.expected_days_of_restrictions, 5);
  assert.equal(evaluated.result.expected_remaining_days, 0);
  assert.ok(Array.isArray(evaluated.result.release_blockers));
});

test("Python schema validation errors are returned instead of silently defaulted", async () => {
  const caseData = await loadExampleCase();
  caseData.smear = "indeterminate";
  await assert.rejects(
    runRuleEngine({ action: "validate", caseData }),
    /smear must be one of/,
  );
});

test("latest clarification reply overrides the stale structured-form value", async () => {
  const caseData = await loadExampleCase();
  caseData.community_risk = "moderate";
  let extractionInstructions;
  const openai = {
    chat: {
      completions: {
        create: async (request) => {
          extractionInstructions = request.messages[0].content;
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  case: caseData,
                  confirmed_unknown_fields: [],
                  conflicted_fields: ["community_risk"],
                }),
              },
            }],
          };
        },
      },
    },
  };
  const extraction = await extractCase({
    openai,
    model: "test-model",
    request: {
      message: "The community risk is moderate.",
      patientContext: "",
      structuredData: { communityRisk: "low" },
      conversationHistory: [
        {
          role: "assistant",
          content: [
            "Before I can complete this assessment, I need you to clarify:",
            "1. What community contacts are anticipated outside the household or inner circle, how frequent are they, and what is the setting/ventilation? Would contacts include immunocompromised people or children under 10? Give a prospective community-risk level (low, moderate, high, or unknown) if assessed.",
            "You can answer in one message.",
          ].join("\n"),
        },
      ],
    },
  });

  assert.equal(extraction.caseData.community_risk, "moderate");
  assert.deepEqual(extraction.conflictedFields, []);
  assert.match(extractionInstructions, /user's explicit answer to a pending clarification is definitive/i);
});

test("canonical case-state envelopes reject invalid field values", async () => {
  const caseData = (await runRuleEngine({
    action: "validate",
    caseData: await loadExampleCase(),
  })).case;
  const envelope = {
    schemaVersion: 1,
    version: 1,
    case: caseData,
    confirmedUnknownFields: [],
    conflictedFields: [],
  };
  assert.equal(validateCaseStateEnvelope(envelope).case.community_risk, caseData.community_risk);
  assert.throws(
    () => validateCaseStateEnvelope({
      ...envelope,
      case: { ...caseData, community_risk: "extreme" },
    }),
    /invalid value for field: community_risk/,
  );
});

test.skip("legacy decision formatter is superseded by the rules narrative interpreter", () => {
  const base = {
    isolation_level: "moderate",
    release_blockers: [],
    duration: {},
  };
  const format = (decision_status, result = {}) => formatDecisionSupport({
    caseState: {
      schemaVersion: 1,
      version: 1,
      case: {
        setting: "community",
        respiratory_tb: "yes",
        pretreatment_burden: "high",
        on_treatment: "yes",
        regimen_appropriate: "yes",
        effectiveness_assessed: "yes",
        adherence_verified: "yes",
        tolerance_adequate: "yes",
        uninterrupted_effective_days: 5,
        clinical_response: "improving",
        community_risk: "moderate",
        patient_harm: "moderate",
      },
      confirmedUnknownFields: [],
      conflictedFields: [],
    },
    result: { ...base, decision_status, ...result },
    review: {
      assessment: "supports",
      direct_answer: "Yes, the tool supports continuing moderate restrictions to its conditional target.",
    },
    evidence: [],
  });

  assert.match(
    format("continue_to_conditional_target", {
      duration: { remaining_days_if_conditions_remain_met: 9 },
    }),
    /## Recommendation\nYes, the tool supports continuing moderate restrictions to its conditional target\. The deterministic tool result is: Continue moderate community restrictions to the rule engine's conditional treatment target\. The rule engine reports 9 verified effective treatment day\(s\) remain/,
  );
  assert.match(
    format("hold_pending_reassessment", { duration: { reassess_within_days: 1 } }),
    /Maintain the moderate provisional hold pending reassessment\. Reassessment is due within 1 day/,
  );
  assert.match(
    format("eligible_to_discontinue_under_draft_policy"),
    /The deterministic tool result is: The rule engine classifies this case as eligible to discontinue community restrictions/,
  );
  assert.match(
    format("no_community_restrictions", { isolation_level: "none" }),
    /The deterministic tool result is: The rule engine classifies this case as having no community restrictions/,
  );
  assert.match(
    format("out_of_scope_provisional_hold", { isolation_level: "extensive" }),
    /outside the rule engine's community-setting scope\. It returned an extensive provisional hold, not a setting-specific decision/,
  );
});

test("structured extraction preserves explicit frontend form selections", async () => {
  const caseData = await loadExampleCase();
  caseData.pretreatment_burden = "low";
  caseData.community_risk = "low";
  caseData.patient_harm = "low";
  caseData.resistance_suspected = "no";
  caseData.gxp_mtb = "unknown";
  caseData.rifampin = "unknown";

  const openai = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                case: caseData,
                confirmed_unknown_fields: [],
                conflicted_fields: [],
              }),
            },
          }],
        }),
      },
    },
  };
  const extraction = await extractCase({
    openai,
    model: "test-model",
    request: {
      message: "Use the values entered in the case form.",
      patientContext: "",
      structuredData: {
        bacterialBurden: "High",
        geneXpert: "Positive (rifampin resistant)",
        communityRisk: "Medium",
        patientHarm: "High",
        drugResistance: "Yes",
      },
      conversationHistory: [],
    },
  });

  assert.equal(extraction.caseData.pretreatment_burden, "high");
  assert.equal(extraction.caseData.gxp_mtb, "detected");
  assert.equal(extraction.caseData.rifampin, "resistant");
  assert.equal(extraction.caseData.community_risk, "moderate");
  assert.equal(extraction.caseData.patient_harm, "high");
  assert.equal(extraction.caseData.resistance_suspected, "yes");
});

test.skip("legacy decision clarification route is superseded by engine-authored questions", async () => {
  const caseData = await loadExampleCase();
  caseData.community_risk = "unknown";
  caseData.smear = "unknown";
  caseData.cavitation = "unknown";
  caseData.extensive_radiographic_disease = "unknown";
  caseData.cough = "unknown";
  caseData.gxp_mtb = "unknown";
  let searches = 0;
  const openai = {
    chat: {
      completions: {
        create: async (request) => {
          if (request.response_format?.json_schema?.name === "tb_task_classification") {
            return { choices: [{ message: { content: JSON.stringify({ task: "isolation_decision" }) } }] };
          }
          if (request.response_format?.json_schema?.name === "tb_case_extraction") {
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    case: caseData,
                    confirmed_unknown_fields: [],
                    conflicted_fields: [],
                  }),
                },
              }],
            };
          }
          throw new Error("Decision should not reach evidence review before required data is complete.");
        },
      },
    },
  };
  const qdrant = {
    search: async () => {
      searches += 1;
      return [];
    },
  };

  await withChatServer({ openai, qdrant }, async (url) => {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Should this patient discontinue community restrictions?" }),
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /community contacts/i);
    assert.match(body, /initial sputum smear/i);
    assert.match(body, /chest imaging/i);
    assert.match(body, /GeneXpert/i);
    assert.match(body, /run the deterministic case rules/i);
  });

  assert.equal(searches, 0);
});

test.skip("legacy clarification flow is superseded by canonical engine-question state", async () => {
  const completeCase = {
    ...(await loadExampleCase()),
    community_risk: "moderate",
    extensive_radiographic_disease: "no",
  };
  const incompleteCase = { ...completeCase, community_risk: "unknown" };
  let classificationCalls = 0;
  let extractionCalls = 0;
  let secondExtractionContext;
  const openai = {
    chat: {
      completions: {
        create: async (request) => {
          const name = request.response_format?.json_schema?.name;
          if (name === "tb_task_classification") {
            classificationCalls += 1;
            return { choices: [{ message: { content: JSON.stringify({ task: "isolation_decision" }) } }] };
          }
          if (name === "tb_case_extraction") {
            extractionCalls += 1;
            const context = JSON.parse(request.messages[1].content);
            if (extractionCalls === 1) {
              assert.equal(context.pending_case_clarification, null);
              return {
                choices: [{
                  message: {
                    content: JSON.stringify({
                      case: incompleteCase,
                      confirmed_unknown_fields: [],
                      conflicted_fields: [],
                    }),
                  },
                }],
              };
            }

            secondExtractionContext = context;
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    case: completeCase,
                    confirmed_unknown_fields: [],
                    conflicted_fields: [],
                  }),
                },
              }],
            };
          }
          throw new Error(`Unexpected model call: ${name}`);
        },
      },
    },
  };
  const qdrant = { search: async () => [] };

  await withChatServer({ openai, qdrant }, async (url) => {
    const firstResponse = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Should this patient continue community restrictions?" }),
    });
    const clarification = await firstResponse.text();
    assert.equal(firstResponse.status, 200);
    assert.match(clarification, /community contacts/i);

    const followUpAnswer = "Community risk is moderate.";
    const secondResponse = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: followUpAnswer,
        conversationHistory: [
          { role: "user", content: "Should this patient continue community restrictions?" },
          { role: "assistant", content: clarification },
        ],
      }),
    });
    const decision = await secondResponse.text();
    assert.equal(secondResponse.status, 200);
    assert.match(decision, /^## Recommendation\nThe deterministic tool result is:/);
    assert.match(decision, /Continue moderate community restrictions/);
    assert.doesNotMatch(decision, /Before I can run the deterministic case rules/);
  });

  assert.equal(classificationCalls, 1, "a pending clarification should bypass reclassification");
  assert.equal(extractionCalls, 2);
  assert.deepEqual(secondExtractionContext.pending_case_clarification.user_responses, [
    "Community risk is moderate.",
  ]);
  assert.match(secondExtractionContext.pending_case_clarification.prompt, /community contacts/i);
});

test.skip("legacy evidence-review flow is superseded by rules-only narrative generation", async () => {
  const caseData = (await runRuleEngine({
    action: "validate",
    caseData: {
    ...(await loadExampleCase()),
    community_risk: "unknown",
    extensive_radiographic_disease: "no",
    },
  })).case;
  const caseState = {
    schemaVersion: 1,
    version: 4,
    case: caseData,
    confirmedUnknownFields: [],
    conflictedFields: [],
  };
  const clarification = [
    "Before I can run the deterministic case rules, I need you to clarify:",
    "1. What community contacts are anticipated outside the household or inner circle, how frequent are they, and what is the setting/ventilation? Would contacts include immunocompromised people or children under 10? Give a prospective community-risk level (low, moderate, high, or unknown) if assessed.",
    "You can answer in one message.",
  ].join("\n");
  let updateInput;
  let updateInstructions;
  let reviewQuestion;
  let retrievalQuery;
  const openai = {
    chat: {
      completions: {
        create: async (request) => {
          const name = request.response_format?.json_schema?.name;
          if (name === "tb_case_update") {
            updateInstructions = request.messages[0].content;
            updateInput = JSON.parse(request.messages[1].content);
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    updates: { community_risk: "moderate" },
                    updated_fields: ["community_risk"],
                    confirmed_unknown_fields: [],
                    conflicted_fields: [],
                  }),
                },
              }],
            };
          }
          if (name === "tb_decision_evidence_review") {
            reviewQuestion = JSON.parse(request.messages[1].content).user_question;
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    assessment: "supports",
                    direct_answer: "The tool supports continuing restrictions to its conditional target.",
                    follow_up_query: "",
                    summary: "The retrieved passage supports that comparison [S1].",
                  }),
                },
              }],
            };
          }
          throw new Error(`Unexpected model call: ${name}`);
        },
      },
    },
  };
  const qdrant = {
    search: async () => {
      return [{
        id: "canonical-case-guidance",
        score: 0.9,
        payload: {
          text: "Guidance passage.",
          source_file: "guidance.pdf",
          title: "TB Guidance",
          chunk_index: 1,
        },
      }];
    },
  };

  await withChatServer({
    openai,
    qdrant,
    embedQuery: async (query) => {
      retrievalQuery = query;
      return [0.1, 0.2];
    },
  }, async (url) => {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Moderate risk.",
        patientContext: "Stale narrative says community risk is high.",
        structuredData: { communityRisk: "High" },
        caseState,
        conversationHistory: [
          { role: "user", content: "When can this patient stop community restrictions?" },
          { role: "assistant", content: clarification },
        ],
      }),
    });

    assert.equal(response.status, 200, await response.clone().text());
    assert.match(await response.text(), /^## Recommendation/);
    const stateHeader = response.headers.get("X-TB-Case-State");
    assert.ok(stateHeader);
    const updatedState = JSON.parse(Buffer.from(stateHeader, "base64url").toString("utf8"));
    assert.equal(updatedState.version, 5);
    assert.equal(updatedState.case.community_risk, "moderate");
    assert.equal(updatedState.case.pretreatment_burden, caseData.pretreatment_burden);
    assert.deepEqual(updatedState.conflictedFields, []);
  });

  assert.deepEqual(updateInput.target_fields, ["community_risk"]);
  assert.equal(updateInput.canonical_case.pretreatment_burden, caseData.pretreatment_burden);
  assert.match(updateInstructions, /never re-extract or overwrite it from prior conversation or patient narrative/i);
  assert.doesNotMatch(JSON.stringify(updateInput), /Stale narrative/);
  assert.equal(reviewQuestion, "When can this patient stop community restrictions?");
  assert.match(retrievalQuery, /When can this patient stop community restrictions/i);
});

test.skip("legacy evidence review is disabled in the rules-only decision workflow", async () => {
  const caseData = await loadExampleCase();
  caseData.extensive_radiographic_disease = "no";
  const responseNames = [];
  let searchCount = 0;
  let reviewInstructions = "";
  let reviewInput;
  const openai = {
    chat: {
      completions: {
        create: async (request) => {
          const name = request.response_format?.json_schema?.name;
          if (name) responseNames.push(name);
          if (name === "tb_task_classification") {
            return { choices: [{ message: { content: JSON.stringify({ task: "isolation_decision" }) } }] };
          }
          if (name === "tb_case_extraction") {
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    case: caseData,
                    confirmed_unknown_fields: [],
                    conflicted_fields: [],
                  }),
                },
              }],
            };
          }
          if (name === "tb_decision_evidence_review") {
            reviewInstructions = request.messages[0].content;
            reviewInput = JSON.parse(request.messages[1].content);
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    assessment: "supports",
                    direct_answer: "Yes. Continue restrictions to the tool's conditional target.",
                    follow_up_query: "",
                    summary: "The retrieved guidance supports continuing to the conditional target [S1].",
                  }),
                },
              }],
            };
          }
          throw new Error(`Unexpected model call: ${name}`);
        },
      },
    },
  };
  const qdrant = {
    search: async () => {
      searchCount += 1;
      return [{
        id: "decision-source",
        score: 0.95,
        payload: {
          text: "Retrieved TB isolation passage.",
          source_file: "guide.pdf",
          title: "TB Guidance",
          chunk_index: 4,
          page_number: 12,
        },
      }];
    },
  };

  await withChatServer({ openai, qdrant }, async (url) => {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Should the patient continue community restrictions?" }),
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /^## Recommendation\nYes\. Continue restrictions to the tool's conditional target\. The deterministic tool result is: Continue moderate community restrictions to the rule engine's conditional treatment target\./);
    assert.match(body, /## Why this applies\nThe decision tool classified this case as moderate\./);
    assert.match(body, /Restrict high-risk shared-air activities/);
    assert.match(body, /Material case facts:/);
    assert.match(body, /## What remains uncertain/);
    assert.match(body, /## Guideline basis\nThe retrieved guidance supports continuing to the conditional target \[S1\]\./);
    assert.match(body, /\[S1\] TB Guidance, page 12/);
    assert.match(body, /rule set is draft and not clinically validated/i);
    assert.doesNotMatch(body, /guide\.pdf/);
    assert.ok(body.indexOf("## Recommendation") < body.indexOf("## Why this applies"));
    assert.ok(body.indexOf("## Why this applies") < body.indexOf("## What remains uncertain"));
    assert.ok(body.indexOf("## What remains uncertain") < body.indexOf("## Guideline basis"));
  });

  assert.equal(searchCount, 1);
  assert.match(reviewInstructions, /one clinical decision-support tool, not a binding final recommendation/i);
  assert.match(reviewInstructions, /not be strictly constrained by it/i);
  assert.match(reviewInstructions, /If the evidence-based assessment differs substantially/i);
  assert.match(reviewInstructions, /financial security, social isolation, mental health, housing, food security/i);
  assert.match(reviewInstructions, /initial sputum smear and imaging\/cavitation\/cough/i);
  assert.match(reviewInstructions, /independently assess the supplied passages/i);
  assert.match(reviewInstructions, /supports, contradicts, or insufficient_to_assess/i);
  assert.match(reviewInstructions, /direct_answer as the very first user-facing answer/i);
  assert.equal(reviewInput.user_question, "Should the patient continue community restrictions?");
  assert.equal(reviewInput.deterministic_rule_tool_result.result.decision_status, "continue_to_conditional_target");
  assert.match(reviewInput.deterministic_rule_tool_result.context, /not a binding final recommendation/);
  assert.ok(responseNames.includes("tb_task_classification"));
  assert.ok(responseNames.includes("tb_case_extraction"));
});

test.skip("legacy evidence conflict workflow is disabled during rules-only testing", async () => {
  const caseData = await loadExampleCase();
  caseData.extensive_radiographic_disease = "no";
  let searchCount = 0;
  let reviewCount = 0;
  let reviewInstructions = "";
  const openai = {
    chat: {
      completions: {
        create: async (request) => {
          const name = request.response_format?.json_schema?.name;
          if (name === "tb_task_classification") {
            return { choices: [{ message: { content: JSON.stringify({ task: "isolation_decision" }) } }] };
          }
          if (name === "tb_case_extraction") {
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    case: caseData,
                    confirmed_unknown_fields: [],
                    conflicted_fields: [],
                  }),
                },
              }],
            };
          }
          if (name === "tb_decision_evidence_review") {
            reviewCount += 1;
            reviewInstructions = request.messages[0].content;
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    assessment: "contradicts",
                    direct_answer: "The retrieved guidance conflicts with the rule-engine result.",
                    follow_up_query: reviewCount === 1 ? "verify isolation duration guidance" : "",
                    summary: "The deterministic tool recommends continuing restrictions to the conditional target. The retrieved guidance instead supports reassessing whether targeted low-risk activities can resume, because it distinguishes those activities from high-risk shared-air contact [S2].",
                  }),
                },
              }],
            };
          }
          throw new Error(`Unexpected model call: ${name}`);
        },
      },
    },
  };
  const qdrant = {
    search: async () => {
      searchCount += 1;
      return [{
        id: `conflict-source-${searchCount}`,
        score: 0.9,
        payload: {
          text: `Evidence passage ${searchCount}`,
          source_file: "guideline.pdf",
          title: "TB Guideline",
          chunk_index: searchCount,
        },
      }];
    },
  };
  const expectedRuleResult = await runRuleEngine({ action: "evaluate", caseData });

  await withChatServer({ openai, qdrant }, async (url) => {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Should restrictions continue for this case?" }),
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(
      body,
      /Clinical review is required before selecting a recommendation\..*Retrieved guideline evidence independently contradicts this result\. No validated conflict-resolution policy is configured/s,
    );
    assert.match(
      body,
      new RegExp(`The deterministic tool result is: .*${expectedRuleResult.result.isolation_level}.*restrictions`, "i"),
    );
    assert.doesNotMatch(body, /## Recommendation\n(?!Clinical review is required)/);
    assert.match(body, /The deterministic tool recommends continuing restrictions to the conditional target/);
    assert.match(body, /retrieved guidance instead supports reassessing whether targeted low-risk activities can resume/);
    assert.match(body, /high-risk shared-air contact \[S2\]/);
    assert.match(body, /\[S2\] TB Guideline/);
  });

  assert.equal(searchCount, 2);
  assert.equal(reviewCount, 2);
  assert.match(reviewInstructions, /include the deterministic tool's result/i);
  assert.match(reviewInstructions, /explain the reasoning for the evidence-supported alternative approaches/i);
});

function createRulesOnlyOpenAI({
  initialCase,
  capture = {},
  task = "isolation_decision",
  caseUpdates = {},
  autoResolvePending = true,
}) {
  return {
    chat: {
      completions: {
        create: async (request) => {
          const name = request.response_format?.json_schema?.name;
          if (name === "tb_task_classification") {
            capture.classificationInput = JSON.parse(request.messages[1].content);
            return { choices: [{ message: { content: JSON.stringify({ task }) } }] };
          }
          if (name === "tb_case_extraction") {
            capture.extractionCount = (capture.extractionCount || 0) + 1;
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    case: initialCase,
                    confirmed_unknown_fields: [],
                    conflicted_fields: [],
                  }),
                },
              }],
            };
          }
          if (name === "tb_case_update") {
            capture.updateCount = (capture.updateCount || 0) + 1;
            const input = JSON.parse(request.messages[1].content);
            capture.updateInput = input;
            const patchUpdates = Object.fromEntries(input.target_fields.map((field) => [
              field,
              input.canonical_case[field],
            ]));
            Object.assign(patchUpdates, caseUpdates);
            if (autoResolvePending &&
              input.pending_engine_questions.some((item) => item.field === "pretreatment_burden")) {
              patchUpdates.pretreatment_burden = "low";
            }
            if (autoResolvePending &&
              input.pending_engine_questions.some((item) => item.field === "community_risk")) {
              patchUpdates.community_risk = "low";
            }
            return {
              choices: [{
                message: {
                  content: JSON.stringify({
                    updates: patchUpdates,
                    updated_fields: [
                      ...input.pending_engine_questions
                        .map((item) => item.field)
                        .filter((field) => ["pretreatment_burden", "community_risk"].includes(field)),
                      ...Object.keys(caseUpdates),
                    ].filter((field) => input.target_fields.includes(field)),
                    confirmed_unknown_fields: [],
                    conflicted_fields: [],
                  }),
                },
              }],
            };
          }

          if (request.messages[0]?.content?.includes("clinical narrative interpreter")) {
            capture.narrativeInput = JSON.parse(request.messages[1].content);
            capture.narrativeInstructions = request.messages[0].content;
            const { user_question: question, deterministic_engine_output: result } = capture.narrativeInput;
            const required = capture.narrativeInput.required_clarification_questions || [];
            const optional = capture.narrativeInput.optional_confirmation_questions || [];
            const recommendation = result.decision_status === "needs_input"
              ? `I can't finalize the answer to "${question}" because the deterministic rules returned needs_input; no restriction level or duration has been assigned, and the remaining duration cannot yet be determined.`
              : `The answer to "${question}" is ${result.restriction_level}; the total target is ${result.expected_days_of_restrictions} treatment days and the conditional remaining interval is ${result.expected_remaining_days} days.`;
            const text = [
              "## Recommendation",
              recommendation,
              "",
              "## Why this recommendation",
              `The rules engine returned ${result.decision_status} and supplied the result shown above.`,
              "",
              "## Assumptions and uncertainty",
              `Reported assumptions: ${JSON.stringify(result.assumptions)}.`,
              "",
              "## Reassessment",
              required.length
                ? `Required clarification: ${required.map((item) => item.question).join(" ")}`
                : "Reassess using the supplied rules-engine conditions.",
              optional.length
                ? ` Optional confirmations: ${optional.map((item) => item.question).join(" ")}`
                : "",
              "The result reflects the supplied rules-engine policy; exact guideline attribution has not been verified.",
            ].join("\n");
            return { choices: [{ message: { content: text } }] };
          }

          if (!request.response_format) {
            if (request.stream) {
              capture.guidanceAnswerMessages = request.messages;
              return (async function* streamGuidanceAnswer() {
                yield {
                  choices: [{
                    delta: { content: "Here is the answer using the current information." },
                  }],
                };
              }());
            }
            capture.guidanceAssessmentMessages = request.messages;
            return { choices: [{ message: { tool_calls: [] } }] };
          }
        },
      },
    },
  };
}

test("rules-only decision narrative preserves the sample engine output and skips Qdrant", async () => {
  const sample = await loadExampleCase();
  const initialCase = (await runRuleEngine({ action: "validate", caseData: sample })).case;
  initialCase.pretreatment_burden = "low";
  initialCase.community_risk = "low";
  const capture = {};
  const openai = createRulesOnlyOpenAI({ initialCase, capture });
  let qdrantSearches = 0;

  await withChatServer({
    openai,
    qdrant: { search: async () => { qdrantSearches += 1; return []; } },
    embedQuery: async () => { throw new Error("Decision support must not retrieve evidence in rules-only mode."); },
  }, async (url) => {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Should restrictions end now?",
        patientContext: "The user says there are five treatment days.",
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /## Provisional TB assessment/);
    assert.match(body, /Engine-reported restriction level: no restriction/);
    assert.match(body, /Conditional total effective-treatment target: 5 days/);
    assert.match(body, /Remaining effective-treatment days: 0/);
    assert.equal(capture.narrativeInput.deterministic_engine_output.restriction_level, "no restriction");
    assert.equal(capture.narrativeInput.deterministic_engine_output.expected_days_of_restrictions, 5);
    assert.equal(capture.narrativeInput.deterministic_engine_output.expected_remaining_days, 0);
    assert.match(capture.narrativeInstructions, /not universal NTCA guideline requirements/i);
    assert.match(capture.narrativeInstructions, /assumed adherent.*not.*adherence verified/i);
    assert.equal(qdrantSearches, 0);
  });
});

test("engine needs_input questions update the canonical case without re-extracting history", async () => {
  const initialCase = (await runRuleEngine({
    action: "validate",
    caseData: await loadExampleCase(),
  })).case;
  initialCase.pretreatment_burden = "unknown";
  initialCase.community_risk = "unknown";
  const capture = {};
  const openai = createRulesOnlyOpenAI({ initialCase, capture });
  const qdrant = { search: async () => { throw new Error("Unexpected Qdrant search."); } };

  await withChatServer({ openai, qdrant }, async (url) => {
    const first = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Can restrictions be stopped?" }),
    });
    const firstText = await first.text();
    const firstState = JSON.parse(Buffer.from(
      first.headers.get("x-tb-case-state"),
      "base64url",
    ).toString("utf8"));

    assert.equal(first.status, 200);
    assert.match(firstText, /need you to clarify/i);
    assert.match(firstText, /initial bacterial burden/);
    assert.doesNotMatch(firstText, /is extensive/);
    assert.equal(capture.narrativeInput, undefined);
    assert.ok(firstState.pendingFields.includes("pretreatment_burden"));
    assert.ok(firstState.pendingFields.includes("community_risk"));
    assert.equal(firstState.version, 1);

    const second = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Bacterial burden is low and community risk is low.",
        conversationHistory: [
          { role: "user", content: "Can restrictions be stopped?" },
          { role: "assistant", content: firstText },
        ],
        caseState: firstState,
      }),
    });
    const secondText = await second.text();
    const secondState = JSON.parse(Buffer.from(
      second.headers.get("x-tb-case-state"),
      "base64url",
    ).toString("utf8"));

    assert.equal(second.status, 200);
    assert.match(secondText, /Can restrictions be stopped\?/);
    assert.equal(secondState.case.pretreatment_burden, "low");
    assert.equal(secondState.case.community_risk, "low");
    assert.equal(secondState.version, 2);
    assert.equal(capture.extractionCount, 1);
    assert.equal(capture.updateCount, 1);
    assert.ok(firstState.pendingFields.every((field) =>
      capture.updateInput.target_fields.includes(field),
    ));
    assert.match(capture.narrativeInstructions, /required clarification question verbatim before optional confirmations/i);
  });
});

test("general questions remain conversational when a canonical case and clarification are present", async () => {
  const caseData = (await runRuleEngine({
    action: "validate",
    caseData: await loadExampleCase(),
  })).case;
  caseData.pretreatment_burden = "unknown";
  const caseState = {
    schemaVersion: 2,
    version: 3,
    case: caseData,
    confirmedUnknownFields: [],
    conflictedFields: [],
    pendingFields: ["pretreatment_burden"],
    pendingQuestions: [{
      field: "pretreatment_burden",
      question: "What was the pretreatment bacterial burden?",
      required_for_final_recommendation: true,
    }],
  };
  const capture = {};
  const openai = createRulesOnlyOpenAI({ capture, task: "guidance" });
  const qdrant = {
    search: async () => [{
      id: "general-guidance",
      score: 0.9,
      payload: {
        text: "Airborne precautions are used in healthcare settings.",
        source_file: "guide.pdf",
        title: "TB Guidance",
        chunk_index: 1,
        page_number: 2,
      },
    }],
  };

  await withChatServer({ openai, qdrant }, async (url) => {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "What does airborne precaution mean?",
        conversationHistory: [
          { role: "assistant", content: "Please clarify the pretreatment burden." },
        ],
        caseState,
      }),
    });
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.match(body, /Here is the answer using the current information/);
    assert.match(body, /\[S1\]/);
    assert.equal(capture.classificationInput.canonical_case_present, true);
    assert.deepEqual(capture.classificationInput.pending_case_fields, ["pretreatment_burden"]);
    assert.equal(capture.extractionCount, undefined);
    assert.equal(capture.updateCount, undefined);
    assert.equal(capture.narrativeInput, undefined);
  });
});

test("combined fact update and general question use the freshly evaluated deterministic result", async () => {
  const caseData = (await runRuleEngine({
    action: "validate",
    caseData: await loadExampleCase(),
  })).case;
  caseData.pretreatment_burden = "low";
  caseData.community_risk = "low";
  caseData.treatment_days = 2;
  const caseState = {
    schemaVersion: 2,
    version: 8,
    case: caseData,
    confirmedUnknownFields: [],
    conflictedFields: [],
    pendingFields: [],
    pendingQuestions: [],
  };
  const capture = {};
  const openai = createRulesOnlyOpenAI({
    capture,
    task: "combined",
    caseUpdates: { treatment_days: 5 },
  });
  const qdrant = {
    search: async () => [{
      id: "combined-guidance",
      score: 0.9,
      payload: {
        text: "The applicable local policy uses treatment duration in reassessment.",
        source_file: "guide.pdf",
        title: "TB Guidance",
        chunk_index: 2,
        page_number: 3,
      },
    }],
  };

  await withChatServer({ openai, qdrant }, async (url) => {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "The patient has actually completed five days of treatment. How does that affect reassessment?",
        conversationHistory: [
          { role: "user", content: "Earlier patient history." },
          { role: "assistant", content: "Previous response." },
        ],
        caseState,
      }),
    });
    const body = await response.text();
    const updatedState = JSON.parse(Buffer.from(
      response.headers.get("x-tb-case-state"),
      "base64url",
    ).toString("utf8"));
    const assessmentText = capture.guidanceAssessmentMessages
      .map((message) => message.content || "")
      .join("\n");

    assert.equal(response.status, 200);
    assert.match(body, /Here is the answer using the current information/);
    assert.equal(updatedState.case.treatment_days, 5);
    assert.equal(updatedState.version, 9);
    assert.equal(capture.updateInput.current_user_message,
      "The patient has actually completed five days of treatment. How does that affect reassessment?");
    assert.match(assessmentText, /"treatment_days":5/);
    assert.match(assessmentText, /expected_days_of_restrictions/);
    assert.match(assessmentText, /How does that affect reassessment/);
    assert.match(capture.guidanceAnswerMessages[0].content, /restriction level, conditions, and clearance status as authoritative/i);
  });
});

test("a case-only treatment update patches a non-pending field and reruns the engine", async () => {
  const caseData = (await runRuleEngine({
    action: "validate",
    caseData: await loadExampleCase(),
  })).case;
  caseData.pretreatment_burden = "unknown";
  caseData.community_risk = "low";
  caseData.treatment_days = 2;
  const caseState = {
    schemaVersion: 2,
    version: 11,
    case: caseData,
    confirmedUnknownFields: [],
    conflictedFields: [],
    pendingFields: ["pretreatment_burden"],
    pendingQuestions: [{
      field: "pretreatment_burden",
      question: "What was the pretreatment bacterial burden?",
      required_for_final_recommendation: true,
    }],
  };
  const capture = {};
  const openai = createRulesOnlyOpenAI({
    capture,
    task: "case_update",
    caseUpdates: { treatment_days: 5 },
    autoResolvePending: false,
  });

  await withChatServer({
    openai,
    qdrant: { search: async () => { throw new Error("Case-only update should not use Qdrant."); } },
  }, async (url) => {
    const response = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "The patient has actually completed five days of treatment.",
        conversationHistory: [
          { role: "assistant", content: "Please clarify pretreatment bacterial burden." },
        ],
        caseState,
      }),
    });
    const body = await response.text();
    const updatedState = JSON.parse(Buffer.from(
      response.headers.get("x-tb-case-state"),
      "base64url",
    ).toString("utf8"));

    assert.equal(response.status, 200);
    assert.match(body, /need you to clarify/i);
    assert.equal(updatedState.case.treatment_days, 5);
    assert.equal(updatedState.case.pretreatment_burden, "unknown");
    assert.deepEqual(updatedState.pendingFields, ["pretreatment_burden"]);
    assert.equal(updatedState.version, 12);
    assert.equal(capture.updateInput.current_user_message,
      "The patient has actually completed five days of treatment.");
    assert.ok(capture.updateInput.target_fields.includes("treatment_days"));
  });
});
