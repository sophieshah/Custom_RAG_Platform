import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import "./chat.css";

const TABS = [
  { id: "narrative", label: "Patient Narrative" },
  { id: "labs", label: "Labs" },
  { id: "community", label: "Community Risk" },
  { id: "patientHarm", label: "Patient Harm" },
  { id: "treatment", label: "Treatment" },
  { id: "chat", label: "Decision Support" },
];

const INITIAL_STRUCTURED_DATA = {
  bacterialBurden: "",
  geneXpert: "",
  communityRisk: "",
  patientHarm: "",
  treatmentDays: "",
  treatmentDrugs: "",
  treatmentTolerance: "",
  drugResistance: "",
};

const SUGGESTED_QUESTIONS = [
  "What guidance is available about tuberculosis transmission?",
  "What does the indexed guidance say about community restrictions?",
  "How should I interpret the retrieved TB recommendations?",
];

export default function Chat({ onBackToHome }) {
  const [activeTab, setActiveTab] = useState("narrative");
  const [patientContext, setPatientContext] = useState("");
  const [structuredData, setStructuredData] = useState(INITIAL_STRUCTURED_DATA);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showSuggestedQuestions, setShowSuggestedQuestions] = useState(true);
  const chatEndRef = useRef(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const updateField = (field) => (event) => {
    setStructuredData((previous) => ({ ...previous, [field]: event.target.value }));
  };

  const resetSession = () => {
    if (!window.confirm("Reset the conversation and clear all patient inputs?")) return;
    setPatientContext("");
    setStructuredData({ ...INITIAL_STRUCTURED_DATA });
    setMessages([]);
    setInput("");
    setActiveTab("narrative");
  };

  const handleSend = async (messageText = input) => {
    const trimmedMessage = messageText.trim();
    if (!trimmedMessage || isSending) return;

    const conversationHistory = [
      ...messages
        .filter((message) => !message.isThinking)
        .map(({ role, content }) => ({ role, content })),
      { role: "user", content: trimmedMessage },
    ];
    setMessages((previous) => [
      ...previous,
      { role: "user", content: trimmedMessage },
      { role: "assistant", content: "Thinking.", isThinking: true },
    ]);
    setInput("");
    setIsSending(true);

    try {
      const response = await fetch("http://localhost:3001/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmedMessage,
          conversationHistory,
          patientContext,
          structuredData,
        }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Backend error (${response.status})`);
      }
      if (!response.body) throw new Error("The server returned an empty response stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantText = "";
      let firstChunk = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        assistantText += decoder.decode(value, { stream: true });
        setMessages((previous) => [
          ...previous.slice(0, -1),
          { role: "assistant", content: assistantText, isThinking: false },
        ]);
        firstChunk = false;
      }

      assistantText += decoder.decode();
      if (firstChunk || assistantText) {
        setMessages((previous) => [
          ...previous.slice(0, -1),
          {
            role: "assistant",
            content: assistantText || "The server returned no response.",
            isThinking: false,
          },
        ]);
      }
    } catch (error) {
      setMessages((previous) => [
        ...previous.slice(0, -1),
        {
          role: "assistant",
          content: `Error: ${error instanceof Error ? error.message : "Unable to complete the request."}`,
          isThinking: false,
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div className="app-layout">
      <div className="chat-container">
        <div className="instructions-banner">
          <p>
            Enter optional patient details in the tabs. They are sent to the LLM as context;
            guidance answers are grounded in indexed sources.
          </p>
          {onBackToHome && (
            <button className="back-home-btn" onClick={onBackToHome}>
              Back to Home
            </button>
          )}
        </div>

        <div className="tab-header" role="tablist" aria-label="Patient inputs and guidance chat">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={activeTab === id}
              className={activeTab === id ? "active" : ""}
              onClick={() => setActiveTab(id)}
            >
              {label}
            </button>
          ))}
          <button className="reset-btn" onClick={resetSession}>Reset Session</button>
        </div>

        {activeTab === "narrative" && (
          <section className="context-tab" role="tabpanel">
            <h2>Patient Narrative</h2>
            <p>Enter any relevant details you want the LLM to consider when answering your question.</p>
            <label className="context-field">
              Patient details
              <textarea
                value={patientContext}
                onChange={(event) => setPatientContext(event.target.value)}
                maxLength={32000}
                placeholder="Describe relevant history, symptoms, or other context."
              />
            </label>
            <button className="primary-btn" onClick={() => setActiveTab("labs")}>
              Continue to Labs
            </button>
          </section>
        )}

        {activeTab === "labs" && (
          <section className="context-tab" role="tabpanel">
            <h2>Laboratory Data</h2>
            <label className="context-field">
              Pre-treatment bacterial burden
              <select value={structuredData.bacterialBurden} onChange={updateField("bacterialBurden")}>
                <option value="">Not provided</option>
                <option>Low</option>
                <option>Moderate</option>
                <option>High</option>
                <option>Unknown</option>
              </select>
            </label>
            <label className="context-field">
              GeneXpert and drug susceptibility
              <select value={structuredData.geneXpert} onChange={updateField("geneXpert")}>
                <option value="">Not provided</option>
                <option>Positive (rifampin resistant)</option>
                <option>Positive (rifampin susceptible—no resistance detected)</option>
                <option>Negative</option>
                <option>Pending or not available</option>
              </select>
            </label>
            <button className="primary-btn" onClick={() => setActiveTab("community")}>
              Continue to Community Risk
            </button>
          </section>
        )}

        {activeTab === "community" && (
          <section className="context-tab" role="tabpanel">
            <h2>Community Risk</h2>
            <p>These selections are user-provided context, not an automated assessment.</p>
            <label className="context-field">
              Community risk
              <select value={structuredData.communityRisk} onChange={updateField("communityRisk")}>
                <option value="">Not provided</option>
                <option>Low</option>
                <option>Medium</option>
                <option>High</option>
                <option>Unknown</option>
              </select>
            </label>
            <button className="primary-btn" onClick={() => setActiveTab("patientHarm")}>
              Continue to Patient Harm
            </button>
          </section>
        )}

        {activeTab === "patientHarm" && (
          <section className="context-tab" role="tabpanel">
            <h2>Patient Harm</h2>
            <p>Share any impacts or concerns that should inform the answer.</p>
            <label className="context-field">
              Patient harm or impact
              <select value={structuredData.patientHarm} onChange={updateField("patientHarm")}>
                <option value="">Not provided</option>
                <option>Low</option>
                <option>Medium</option>
                <option>High</option>
                <option>Unknown</option>
              </select>
            </label>
            <button className="primary-btn" onClick={() => setActiveTab("treatment")}>
              Continue to Treatment
            </button>
          </section>
        )}

        {activeTab === "treatment" && (
          <section className="context-tab" role="tabpanel">
            <h2>Treatment Information</h2>
            <label className="context-field">
              Days on treatment
              <input
                type="number"
                min="0"
                value={structuredData.treatmentDays}
                onChange={updateField("treatmentDays")}
                placeholder="Not provided"
              />
            </label>
            <label className="context-field">
              Treatment drugs or regimen
              <textarea
                value={structuredData.treatmentDrugs}
                onChange={updateField("treatmentDrugs")}
                maxLength={4000}
                placeholder="Enter any known treatment details."
              />
            </label>
            <label className="context-field">
              Treatment tolerance or adherence details
              <textarea
                value={structuredData.treatmentTolerance}
                onChange={updateField("treatmentTolerance")}
                maxLength={4000}
                placeholder="Enter any relevant details."
              />
            </label>
            <label className="context-field">
              Concern for drug resistance
              <select value={structuredData.drugResistance} onChange={updateField("drugResistance")}>
                <option value="">Not provided</option>
                <option>Yes</option>
                <option>No</option>
                <option>Unknown</option>
              </select>
            </label>
            <button className="primary-btn" onClick={() => setActiveTab("chat")}>
              Continue to Decision Support Chat
            </button>
          </section>
        )}

        {activeTab === "chat" && (
          <div className="chat-tab-container" role="tabpanel">
            <div className="chat-messages">
              {messages.map((message, index) => (
                <div
                  key={index}
                  className={`chat-bubble ${message.role === "user" ? "user" : "assistant"}`}
                >
                  {message.isThinking
                    ? <ThinkingDots />
                    : message.role === "assistant"
                      ? <ReactMarkdown>{message.content}</ReactMarkdown>
                      : message.content}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            <div className="suggested-questions-container">
              {showSuggestedQuestions ? (
                <div className="suggested-questions">
                  <div className="suggested-header">
                    <p className="suggested-label">Suggested questions:</p>
                    <button
                      className="collapse-suggested-btn"
                      onClick={() => setShowSuggestedQuestions(false)}
                      aria-label="Hide suggested questions"
                    >
                      ×
                    </button>
                  </div>
                  <div className="suggested-buttons">
                    {SUGGESTED_QUESTIONS.map((question) => (
                      <button
                        key={question}
                        className="suggested-question-btn"
                        onClick={() => handleSend(question)}
                        disabled={isSending}
                      >
                        {question}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="suggested-questions-collapsed">
                  <button
                    className="show-suggested-btn"
                    onClick={() => setShowSuggestedQuestions(true)}
                  >
                    Show suggested questions
                  </button>
                </div>
              )}
            </div>

            <div className="chat-input-container">
              <textarea
                className="chat-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Ask a question..."
                rows={1}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    handleSend();
                  }
                }}
              />
              <button onClick={() => handleSend()} disabled={isSending}>Send</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkingDots() {
  const [dots, setDots] = useState(".");

  useEffect(() => {
    const interval = setInterval(() => {
      setDots((previous) => previous.length === 3 ? "." : `${previous}.`);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  return <span style={{ color: "#333" }}>Thinking{dots}</span>;
}
