import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import "./chat.css";

const API_URL = "http://localhost:3001/api";
const SUGGESTED_QUESTIONS = [
  "What guidance is available about tuberculosis transmission?",
  "What does the indexed guidance say about community restrictions?",
  "How should I interpret the retrieved TB recommendations?",
];

function defaultValueForField(field) {
  return field.type === "checkbox" ? false : "";
}

function valuesForConfig(config, previous = {}) {
  const values = {};
  for (const field of config.tabs.flatMap((tab) => tab.fields)) {
    const value = previous[field.id];
    values[field.id] = typeof value === "string" || typeof value === "boolean"
      ? value
      : defaultValueForField(field);
  }
  return values;
}

function valueForSubmission(config, values) {
  const submitted = {};
  for (const field of config.tabs.flatMap((tab) => tab.fields)) {
    const value = values[field.id];
    if (field.type === "checkbox") {
      if (field.required && !value) throw new Error(`${field.label} is required.`);
      if (field.required || value) submitted[field.id] = Boolean(value);
      continue;
    }
    if (value === "" || value === undefined) {
      if (field.required) throw new Error(`${field.label} is required.`);
      continue;
    }
    if (field.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`${field.label} must be a number.`);
      submitted[field.id] = number;
    } else {
      submitted[field.id] = value;
    }
  }
  return submitted;
}

function ConfiguredField({ field, value, onChange }) {
  const commonProps = {
    id: field.id,
    required: Boolean(field.required),
    placeholder: field.placeholder || "",
    onChange,
  };
  let control;
  if (field.type === "textarea") {
    control = <textarea {...commonProps} value={value ?? ""} />;
  } else if (field.type === "select") {
    control = (
      <select {...commonProps} value={value ?? ""}>
        <option value="">Not provided</option>
        {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  } else if (field.type === "checkbox") {
    control = (
      <input
        id={field.id}
        type="checkbox"
        required={Boolean(field.required)}
        checked={Boolean(value)}
        onChange={onChange}
      />
    );
  } else {
    control = (
      <input
        {...commonProps}
        type={field.type}
        value={value ?? ""}
        min={field.type === "number" ? 0 : undefined}
      />
    );
  }
  return (
    <label className={`context-field ${field.type === "checkbox" ? "context-checkbox" : ""}`} htmlFor={field.id}>
      {field.label}{field.required ? " *" : ""}
      {control}
    </label>
  );
}

export default function Chat({ onBackToHome }) {
  const [inputConfig, setInputConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [activeTab, setActiveTab] = useState("");
  const [inputValues, setInputValues] = useState({});
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showSuggestedQuestions, setShowSuggestedQuestions] = useState(true);
  const chatEndRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/input-config`)
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
        if (!result || result.version !== 1 || !Array.isArray(result.tabs)) {
          throw new Error("The server returned an invalid input form configuration.");
        }
        if (!cancelled) {
          setInputConfig(result);
          setActiveTab(result.tabs[0]?.id || "__guidance_chat");
          setInputValues(valuesForConfig(result));
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setConfigError(error instanceof Error ? error.message : "Unable to load the input form configuration.");
        }
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const updateField = (field) => (event) => {
    const value = field.type === "checkbox" ? event.target.checked : event.target.value;
    setInputValues((previous) => ({ ...previous, [field.id]: value }));
    setConfigError("");
  };

  const resetSession = () => {
    if (!window.confirm("Reset the conversation and clear all input values?")) return;
    setInputValues(valuesForConfig(inputConfig));
    setMessages([]);
    setInput("");
    setActiveTab(inputConfig.tabs[0]?.id || "__guidance_chat");
  };

  const handleSend = async (messageText = input) => {
    const trimmedMessage = messageText.trim();
    if (!trimmedMessage || isSending) return;

    let structuredData;
    try {
      structuredData = valueForSubmission(inputConfig, inputValues);
    } catch (error) {
      setConfigError(error.message);
      const requiredField = inputConfig.tabs
        .flatMap((tab) => tab.fields)
        .find((field) => field.required && (
          field.type === "checkbox"
            ? !inputValues[field.id]
            : inputValues[field.id] === "" || inputValues[field.id] === undefined
        ));
      if (requiredField) setActiveTab(inputConfig.tabs.find((tab) => (
        tab.fields.some((field) => field.id === requiredField.id)
      )).id);
      return;
    }
    setConfigError("");

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
      const response = await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmedMessage, conversationHistory, structuredData }),
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

  if (configError && !inputConfig) {
    return (
      <main className="app-layout">
        <section className="chat-container context-tab">
          <h1>Unable to load input forms</h1>
          <p className="input-config-error" role="alert">{configError}</p>
          <button className="primary-btn" onClick={() => window.location.reload()}>Retry</button>
        </section>
      </main>
    );
  }
  if (!inputConfig) {
    return <main className="app-layout"><section className="chat-container context-tab">Loading input forms…</section></main>;
  }

  const activeConfigTab = inputConfig.tabs.find((tab) => tab.id === activeTab);
  const chatTabId = "__guidance_chat";

  return (
    <div className="app-layout">
      <div className="chat-container">
        <div className="instructions-banner">
          <p>
            Enter optional details in the tabs. They are sent to the LLM as context;
            guidance answers are grounded in indexed sources.
          </p>
          {onBackToHome && (
            <button className="back-home-btn" onClick={onBackToHome}>Back to Home</button>
          )}
        </div>

        <div className="tab-header" role="tablist" aria-label="Input forms and guidance chat">
          {inputConfig.tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? "active" : ""}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.title}
            </button>
          ))}
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === chatTabId}
            className={activeTab === chatTabId ? "active" : ""}
            onClick={() => setActiveTab(chatTabId)}
          >
            Guidance Chat
          </button>
          <button className="reset-btn" onClick={resetSession}>Reset Session</button>
        </div>

        {activeConfigTab && (
          <section className="context-tab" role="tabpanel">
            <h2>{activeConfigTab.title}</h2>
            {activeConfigTab.description && <p>{activeConfigTab.description}</p>}
            {configError && <p className="input-config-error" role="alert">{configError}</p>}
            {activeConfigTab.fields.map((field) => (
              <ConfiguredField
                key={field.id}
                field={field}
                value={inputValues[field.id]}
                onChange={updateField(field)}
              />
            ))}
          </section>
        )}

        {activeTab === chatTabId && (
          <div className="chat-tab-container" role="tabpanel">
            {configError && <p className="input-config-error" role="alert">{configError}</p>}
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
