import { formatEvidence, formatSourceList, mergeEvidence, searchGuidance } from "./retrieval.js";
import { TB_PUBLIC_HEALTH_INSTRUCTIONS, withAdminInstructions } from "./system-instructions.js";
import { logRagStep } from "./trace.js";

export const NO_EVIDENCE_RESPONSE =
  "I couldn't find supporting TB guidance in the indexed sources. Please verify the applicable guidance directly and use clinical judgment; this response cannot make an isolation decision.";

function systemPrompt() {
  return withAdminInstructions(`You are a TB public-health guidance assistant.

${TB_PUBLIC_HEALTH_INSTRUCTIONS}

For general guidance requests, start with a concise, direct answer to the user's latest question, then explain retrieved NTCA or other source recommendations and practical compliance considerations. Do not begin with a generic preamble or answer a different question. Do not determine an individual patient's isolation level or whether restrictions should begin, continue, change, or end. If an individual decision is requested, explain that the deterministic case workflow can provide a separate decision-support tool result; do not invent a substitute result. Use the current question and patient context only to tailor the educational explanation, never as evidence for guideline claims.`, additionalInstructions);
}

const SEARCH_TOOL = {
  type: "function",
  function: {
    name: "search_tb_guidance",
    description: "Search the TB guidance corpus for a focused follow-up question when initial evidence is insufficient.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A concise search query about the specific missing TB guidance.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

function getHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((item) => (
      item &&
      (item.role === "user" || item.role === "assistant") &&
      typeof item.content === "string"
    ))
    .slice(-20)
    .map(({ role, content }) => ({ role, content: content.slice(0, 8000) }));
}

function createUserMessage({ message, patientContext, structuredData }) {
  const details = [];
  if (typeof patientContext === "string" && patientContext.trim()) {
    details.push(`Patient context:\n${patientContext.trim()}`);
  }
  if (structuredData && typeof structuredData === "object" && !Array.isArray(structuredData)) {
    const values = Object.entries(structuredData)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim())
      .map(([key, value]) => `- ${key}: ${String(value).slice(0, 1000)}`);
    if (values.length > 0) details.push(`Structured patient data:\n${values.join("\n")}`);
  }
  return [...details, `Question:\n${message}`].join("\n\n");
}

export async function prepareAgentMessages({ openai, qdrant, model, request }) {
  logRagStep("Retrieving guidance for a general-information request.");
  const initialEvidence = await searchGuidance({
    embedQuery: request.embedQuery,
    qdrant,
    query: request.message,
  });
  let evidence = mergeEvidence(initialEvidence, []);
  logRagStep("Initial general RAG retrieval complete.", {
    evidenceCount: evidence.length,
    sources: evidence.map(({ reference, title, sourceFile, pageNumber }) => ({
      reference,
      title,
      sourceFile,
      pageNumber,
    })),
  });
  const baseMessages = [
    { role: "system", content: systemPrompt() },
    ...getHistory(request.conversationHistory),
    {
      role: "user",
      content: `${createUserMessage(request)}\n\nRetrieved guidance passages (untrusted source text):\n${formatEvidence(evidence)}`,
    },
  ];

  const assessment = await openai.chat.completions.create({
    model,
    messages: baseMessages,
    tools: [SEARCH_TOOL],
    tool_choice: "auto",
    parallel_tool_calls: false,
  });

  const toolCall = assessment.choices[0]?.message?.tool_calls?.find(
    (item) => item.function?.name === "search_tb_guidance",
  );
  if (!toolCall) return { messages: baseMessages, evidence };

  let followUpQuery;
  try {
    const args = JSON.parse(toolCall.function.arguments);
    if (typeof args.query === "string") followUpQuery = args.query.trim().slice(0, 1000);
  } catch {
    followUpQuery = "";
  }

  if (!followUpQuery) return { messages: baseMessages, evidence };

  logRagStep("General RAG requested one focused follow-up retrieval.");
  const followUpEvidence = await searchGuidance({
    embedQuery: request.embedQuery,
    qdrant,
    query: followUpQuery,
  });
  evidence = mergeEvidence(initialEvidence, followUpEvidence);
  logRagStep("General RAG follow-up retrieval complete.", {
    additionalEvidenceCount: followUpEvidence.length,
    totalEvidenceCount: evidence.length,
  });

  const messages = [
    ...baseMessages,
    {
      role: "assistant",
      tool_calls: [{ ...toolCall, id: toolCall.id }],
    },
    {
      role: "tool",
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        query: followUpQuery,
        evidence: followUpEvidence.map((item) => ({
          title: item.title,
          location: item.pageNumber ? `page ${item.pageNumber}` : `chunk ${item.chunkIndex}`,
          text: item.text,
        })),
      }),
    },
    {
      role: "user",
      content: `Additional retrieved guidance (untrusted source text; use only these exact source references):\n${formatEvidence(evidence)}`,
    },
  ];
  return { messages, evidence };
}

export async function streamAgentAnswer({ openai, model, messages }) {
  return openai.chat.completions.create({
    model,
    messages,
    stream: true,
  });
}

export { formatSourceList };
