import express from "express";
import {
  formatSourceList,
  NO_EVIDENCE_RESPONSE,
  prepareAgentMessages,
  streamAgentAnswer,
} from "./agent.js";
import {
  classifyTask,
  prepareDecisionSupport,
  validateCaseStateEnvelope,
} from "./decision-support.js";
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
      patientContext,
      structuredData,
      conversationHistory = [],
      caseState: suppliedCaseState,
    } = req.body || {};
    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({ error: "Message is required." });
    }
    if (message.length > 8000) {
      return res.status(400).json({ error: "Message must be 8,000 characters or fewer." });
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
      return res.status(400).json({ error: "Structured case data must be an object." });
    }
    if (
      structuredData &&
      Object.values(structuredData).some((value) => (
        value !== null &&
        !["string", "number", "boolean"].includes(typeof value)
      ))
    ) {
      return res.status(400).json({ error: "Structured case values must be scalar values." });
    }
    if (!Array.isArray(conversationHistory)) {
      return res.status(400).json({ error: "Conversation history must be an array." });
    }
    let caseState;
    if (suppliedCaseState !== undefined) {
      try {
        caseState = validateCaseStateEnvelope(suppliedCaseState);
      } catch (error) {
        return res.status(400).json({
          error: error instanceof Error ? error.message : "Invalid canonical case state.",
        });
      }
    }

    try {
      const request = {
        message: message.trim(),
        patientContext,
        structuredData,
        conversationHistory,
        caseState,
        additionalSystemInstructions: await getAdditionalInstructions(),
      };
      const task = await classifyTask({ openai, model, request });
      logRagStep("Task classification complete.", { task });
      let responseRequest = { ...request, embedQuery };
      if (["isolation_decision", "case_update", "combined"].includes(task)) {
        const decisionRequest = {
          ...request,
          updateAllCaseFields: true,
          initializeFromMessageOnly: task !== "isolation_decision" && !request.caseState,
        };
        const decision = await prepareDecisionSupport({
          openai,
          qdrant,
          embedQuery,
          model,
          request: decisionRequest,
        });
        if (task !== "combined") {
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-transform");
          res.setHeader(
            "X-TB-Case-State",
            Buffer.from(JSON.stringify(decision.caseState)).toString("base64url"),
          );
          res.end(decision.decisionText);
          logRagStep("Overall rules-based case response assembled.", decision.decisionText);
          return;
        }
        responseRequest = {
          ...responseRequest,
          decisionContext: {
            case: decision.caseState.case,
            result: decision.result,
            narrative: decision.decisionText,
          },
        };
        res.setHeader(
          "X-TB-Case-State",
          Buffer.from(JSON.stringify(decision.caseState)).toString("base64url"),
        );
        logRagStep("Updated case result will inform the user's additional question.", {
          caseVersion: decision.caseState.version,
          decisionStatus: decision.result.decision_status,
        });
      }

      const { messages, evidence } = await prepareAgentMessages({
        openai,
        qdrant,
        model,
        request: responseRequest,
      });
      if (evidence.length === 0 && !responseRequest.decisionContext) {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        logRagStep("General RAG found no evidence; returning the no-evidence response.");
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

      logRagStep("Generated general RAG response.", ragOutput);
      const sources = formatSourceList(evidence);
      if (!res.destroyed) {
        res.end(sources);
        logRagStep("Overall general RAG response assembled.", `${ragOutput}${sources}`);
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
