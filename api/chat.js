import OpenAI from "openai";
import {
  formatSourceList,
  NO_EVIDENCE_RESPONSE,
  prepareAgentMessages,
} from "../backend/rag/agent.js";
import {
  classifyTask,
  formatDecisionResult,
  formatDecisionSources,
  prepareDecisionSupport,
} from "../backend/rag/decision-support.js";
import { LocalEmbeddingWorker } from "../backend/rag/local-embeddings.js";
import { QdrantClient } from "../backend/rag/qdrant.js";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const qdrant = new QdrantClient();
const embeddingWorker = new LocalEmbeddingWorker();
const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

async function embedQuery(text) {
  await embeddingWorker.start();
  if (embeddingWorker.dimension !== qdrant.dimensions) {
    throw new Error(
      `Embedding model returned ${embeddingWorker.dimension} dimensions; Qdrant is configured for ${qdrant.dimensions}.`,
    );
  }
  const [vector] = await embeddingWorker.embedQueries([text]);
  return vector;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const message = req.body?.message || req.body?.prompt;
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "Message is required." });
  }

  const request = {
    message: message.trim(),
    patientContext: req.body.patientContext,
    structuredData: req.body.structuredData,
    conversationHistory: req.body.conversationHistory,
  };

  try {
    await qdrant.ensureCollection();
    const task = await classifyTask({ openai: client, model, request });
    if (task === "isolation_decision") {
      const decision = await prepareDecisionSupport({
        openai: client,
        qdrant,
        embedQuery,
        model,
        request,
      });
      if (decision.kind === "clarification") {
        return res.status(200).json({ reply: decision.text });
      }

      const warning = decision.review?.assessment === "conflict"
        ? "\n\nEvidence consistency: conflict detected. The deterministic result is unchanged; clinician review is needed."
        : decision.review?.assessment === "insufficient"
          ? "\n\nEvidence consistency: supporting evidence was insufficient. The deterministic result is unchanged."
          : "";
      if (!decision.explanationMessages) {
        return res.status(200).json({
          reply: `${decision.deterministicText}\n\nNo supporting guidance was retrieved for this rule result.`,
        });
      }

      const response = await client.chat.completions.create({
        model,
        messages: decision.explanationMessages,
      });
      const explanation = response.choices[0]?.message?.content || "";
      return res.status(200).json({
        reply: `${formatDecisionResult(decision.result)}${warning}\n\nExplanation:\n${explanation}${formatDecisionSources(decision.evidence)}`,
      });
    }

    const { messages, evidence } = await prepareAgentMessages({
      openai: client,
      qdrant,
      model,
      request: { ...request, embedQuery },
    });
    if (evidence.length === 0) {
      return res.status(200).json({ reply: NO_EVIDENCE_RESPONSE });
    }
    const response = await client.chat.completions.create({ model, messages });
    const reply = response.choices[0]?.message?.content || "";
    return res.status(200).json({ reply: `${reply}${formatSourceList(evidence)}` });
  } catch (error) {
    console.error("Chat handler failed:", error instanceof Error ? error.message : "Unknown error");
    return res.status(502).json({ error: "Unable to process this request." });
  }
}
