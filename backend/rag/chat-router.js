import express from "express";
import {
  formatSourceList,
  NO_EVIDENCE_RESPONSE,
  prepareAgentMessages,
  streamAgentAnswer,
} from "./agent.js";
import { logRagStep } from "./trace.js";

export function createChatRouter({
  openai,
  qdrant,
  embedQuery,
  model,
  getAdditionalInstructions = async () => "",
}) {
  const router = express.Router();

  router.post("/api/chat", async (req, res) => {
    const {
      message,
      conversationHistory = [],
      patientContext,
      structuredData,
    } = req.body || {};
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message is required." });
    }
    if (message.length > 8000) {
      return res.status(400).json({ error: "Message must be 8,000 characters or fewer." });
    }
    if (!Array.isArray(conversationHistory)) {
      return res.status(400).json({ error: "Conversation history must be an array." });
    }
    if (patientContext !== undefined && typeof patientContext !== "string") {
      return res.status(400).json({ error: "Patient context must be text." });
    }
    if (typeof patientContext === "string" && patientContext.length > 32000) {
      return res.status(400).json({ error: "Patient context must be 32,000 characters or fewer." });
    }
    if (
      structuredData !== undefined &&
      (!structuredData || typeof structuredData !== "object" || Array.isArray(structuredData))
    ) {
      return res.status(400).json({ error: "Structured input data must be an object." });
    }
    if (
      structuredData &&
      Object.values(structuredData).some((value) => (
        value !== null &&
        !["string", "number", "boolean"].includes(typeof value)
      ))
    ) {
      return res.status(400).json({ error: "Structured input values must be scalar values." });
    }
    if (structuredData && JSON.stringify(structuredData).length > 32000) {
      return res.status(400).json({ error: "Structured input data must be 32,000 characters or fewer." });
    }

    try {
      const request = {
        message: message.trim(),
        conversationHistory,
        patientContext,
        structuredData,
        embedQuery,
        additionalSystemInstructions: await getAdditionalInstructions(),
      };
      const { messages, evidence } = await prepareAgentMessages({
        openai,
        qdrant,
        model,
        request,
      });
      if (evidence.length === 0) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        logRagStep("RAG found no evidence; returning the no-evidence response.");
        return res.end(NO_EVIDENCE_RESPONSE);
      }
      const stream = await streamAgentAnswer({ openai, model, messages });

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      let ragOutput = "";
      for await (const event of stream) {
        if (res.destroyed) break;
        const content = event.choices[0]?.delta?.content;
        if (typeof content === "string") {
          ragOutput += content;
          res.write(content);
        }
      }

      logRagStep("Generated RAG response.", ragOutput);
      const sources = formatSourceList(evidence);
      if (!res.destroyed) {
        res.end(sources);
        logRagStep("Overall RAG response assembled.", `${ragOutput}${sources}`);
      }
    } catch (error) {
      console.error("Chat request failed:", error instanceof Error ? error.message : "Unknown error");
      if (res.headersSent) {
        if (!res.destroyed) res.end("\n\n[The response was interrupted by a service error.]");
      } else {
        res.status(502).json({ error: "Unable to retrieve guidance or generate a response." });
      }
    }
  });

  return router;
}
