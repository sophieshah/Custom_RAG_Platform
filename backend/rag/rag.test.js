import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { readFile } from "node:fs/promises";
import { prepareAgentMessages } from "./agent.js";
import { createChatRouter } from "./chat-router.js";
import { chunkDocumentPages, chunkText, stablePointId } from "./documents.js";
import {
  extractCase,
  formatDecisionSupport,
  validateCaseStateEnvelope,
} from "./decision-support.js";
import { formatEvidence, formatSourceList, searchGuidance } from "./retrieval.js";
import { QdrantClient } from "./qdrant.js";
import { runRuleEngine } from "./rule-engine.js";
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
  assert.doesNotMatch(assessmentMessages.at(-1).content, /guideline\.pdf/);
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

  assert.equal(validated.case.setting, "community");
  assert.equal(evaluated.result.ruleset_version, "0.1.0-draft");
  assert.ok(["none", "moderate", "extensive"].includes(evaluated.result.isolation_level));
  assert.ok(Array.isArray(evaluated.result.release_blockers));
});

test("Python schema validation errors are returned instead of silently defaulted", async () => {
  const caseData = await loadExampleCase();
  caseData.smear = "positive";
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
            "Before I can run the deterministic case rules, I need you to clarify:",
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

test("decision formatter directly answers from each deterministic rule status", () => {
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

test("decision route asks for unresolved required fields before evaluating rules", async () => {
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

test("decision clarification replies are routed back into extraction and reach the rule engine", async () => {
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

test("case clarification patches only requested canonical fields and returns the next version", async () => {
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

test("decision route preserves Python rule output and adds evidence review/citations", async () => {
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

test("decision evidence conflict triggers one follow-up and escalates without choosing either source", async () => {
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
