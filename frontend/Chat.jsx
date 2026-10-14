import React, { useState, useRef, useEffect } from "react";
import "./chat.css";

export default function Chat({ onBackToHome }) {
  const [activeTab, setActiveTab] = useState("narrative");
  const [patientContext, setPatientContext] = useState("");
  const [structuredData, setStructuredData] = useState({
    bacterialBurden: null,
    geneXpert: null,
    communityRisk: null,
    patientHarm: null,
    treatmentDays: null,
    treatmentDrugs: null,
    treatmentTolerance: null,
    drugResistance: null,
  });
  const [messages, setMessages] = useState([]);
  const [caseState, setCaseState] = useState(null);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showSuggestedQuestions, setShowSuggestedQuestions] = useState(true);
  const chatEndRef = useRef(null);

  // Help panel state
  const [helpPanel, setHelpPanel] = useState({
    isOpen: false,
    topic: "",
    messages: [],
    input: "",
    isSending: false
  });
  const helpChatEndRef = useRef(null);

  // Auto-scroll main chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-scroll help panel chat
  useEffect(() => {
    if (helpPanel.isOpen) {
      helpChatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [helpPanel.messages, helpPanel.isOpen]);

  const resetSession = () => {
    if (!window.confirm("Reset chatbot and clear patient context?")) return;
    setPatientContext("");
    setStructuredData({
      bacterialBurden: null,
      geneXpert: null,
      communityRisk: null,
      patientHarm: null,
      treatmentDays: null,
      treatmentDrugs: null,
      treatmentTolerance: null,
      drugResistance: null,
    });
    setMessages([]);
    setCaseState(null);
    setInput("");
    setActiveTab("narrative");
  };

  // Open help panel and automatically send the help question
  const openHelpPanel = async (topic) => {
    const questions = {
      bacterialBurden: "How do I determine the pre-treatment bacterial burden for a TB patient?",
      geneXpert: "How do I interpret GeneXpert results for drug resistance?",
      communityRisk: "How do I assess the community risk level for TB transmission?",
      patientHarm: "How do I evaluate the potential harm to a TB patient from isolation?",
      treatmentDays: "How do I determine how long a TB patient has been on treatment?",
      treatmentDrugs: "What information should I collect about TB treatment drugs?",
      treatmentTolerance: "How do I assess if a patient is tolerating TB treatment?",
      drugResistance: "How do I determine if there is concern for drug resistance in a TB patient?"
    };

    const topicLabels = {
      bacterialBurden: "Bacterial Burden",
      geneXpert: "Drug Resistance",
      communityRisk: "Community Risk",
      patientHarm: "Patient Harm",
      treatmentDays: "Treatment Duration",
      treatmentDrugs: "Treatment Drugs",
      treatmentTolerance: "Treatment Tolerance",
      drugResistance: "Drug Resistance"
    };

    const question = questions[topic];
    const topicLabel = topicLabels[topic];
    
    setHelpPanel({
      isOpen: true,
      topic: topicLabel,
      messages: [],
      input: "",
      isSending: true
    });

    const thinkingMessage = { role: "assistant", content: "Thinking.", isThinking: true };
    setHelpPanel(prev => ({
      ...prev,
      messages: [thinkingMessage]
    }));

    try {
      const res = await fetch("http://localhost:3001/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          message: question,
          patientContext: patientContext,
          structuredData: structuredData,
          conversationHistory: [] // No history for help panel
        })
      });

      if (!res.ok) throw new Error("Backend error");
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      
      let aiMessage = { role: "assistant", content: "", isThinking: false };
      let isFirstChunk = true;
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        aiMessage.content += chunk;
        
        if (isFirstChunk && aiMessage.content.trim().length > 0) {
          setHelpPanel(prev => ({
            ...prev,
            messages: [{ ...aiMessage }]
          }));
          isFirstChunk = false;
        } else if (!isFirstChunk) {
          setHelpPanel(prev => ({
            ...prev,
            messages: [{ ...aiMessage }]
          }));
        }
        
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } catch (err) {
      setHelpPanel(prev => ({
        ...prev,
        messages: [{ role: "assistant", content: "Error: " + err.message }]
      }));
    } finally {
      setHelpPanel(prev => ({ ...prev, isSending: false }));
    }
  };

  // Send follow-up message in help panel
  const sendHelpMessage = async () => {
    if (!helpPanel.input.trim()) return;

    const userMessage = { role: "user", content: helpPanel.input };
    setHelpPanel(prev => ({
      ...prev,
      messages: [...prev.messages, userMessage],
      input: "",
      isSending: true
    }));

    const thinkingMessage = { role: "assistant", content: "Thinking.", isThinking: true };
    setHelpPanel(prev => ({
      ...prev,
      messages: [...prev.messages, thinkingMessage]
    }));

    try {
      // Build conversation history from help panel messages (excluding thinking messages)
      const helpHistory = helpPanel.messages
        .filter(msg => !msg.isThinking)
        .map(msg => ({ role: msg.role, content: msg.content }));

      const res = await fetch("http://localhost:3001/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          message: helpPanel.input,
          patientContext: patientContext,
          structuredData: structuredData,
          conversationHistory: helpHistory
        })
      });

      if (!res.ok) throw new Error("Backend error");
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      
      let aiMessage = { role: "assistant", content: "", isThinking: false };
      let isFirstChunk = true;
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        aiMessage.content += chunk;
        
        if (isFirstChunk && aiMessage.content.trim().length > 0) {
          setHelpPanel(prev => ({
            ...prev,
            messages: [...prev.messages.slice(0, -1), { ...aiMessage }]
          }));
          isFirstChunk = false;
        } else if (!isFirstChunk) {
          setHelpPanel(prev => ({
            ...prev,
            messages: [...prev.messages.slice(0, -1), { ...aiMessage }]
          }));
        }
        
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } catch (err) {
      setHelpPanel(prev => ({
        ...prev,
        messages: [
          ...prev.messages.slice(0, -1),
          { role: "assistant", content: "Error: " + err.message }
        ]
      }));
    } finally {
      setHelpPanel(prev => ({ ...prev, isSending: false }));
    }
  };

  const closeHelpPanel = () => {
    setHelpPanel({
      isOpen: false,
      topic: "",
      messages: [],
      input: "",
      isSending: false
    });
  };

  const handleSend = async (messageText = input) => {
    if (!messageText.trim()) return;

    const userMessage = { role: "user", content: messageText };
    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setIsSending(true);
    
    const thinkingMessage = { role: "assistant", content: "Thinking.", isThinking: true };
    setMessages(prev => [...prev, thinkingMessage]);

    try {
      // Build conversation history (excluding thinking messages and isThinking property)
      const conversationHistory = messages
        .filter(msg => !msg.isThinking)
        .map(msg => ({ role: msg.role, content: msg.content }));

      const res = await fetch("http://localhost:3001/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          message: messageText,
          patientContext: patientContext,
          structuredData: structuredData,
          conversationHistory: conversationHistory,
          ...(caseState ? { caseState } : {})
        })
      });

      if (!res.ok) throw new Error("Backend error");
      const encodedCaseState = res.headers.get("X-TB-Case-State");
      if (encodedCaseState) {
        const base64State = encodedCaseState.replace(/-/g, "+").replace(/_/g, "/");
        const paddedState = base64State.padEnd(Math.ceil(base64State.length / 4) * 4, "=");
        const binaryState = atob(paddedState);
        const stateBytes = Uint8Array.from(binaryState, character => character.charCodeAt(0));
        setCaseState(JSON.parse(new TextDecoder().decode(stateBytes)));
      }
      
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      
      let aiMessage = { role: "assistant", content: "", isThinking: false };
      let isFirstChunk = true;
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        aiMessage.content += chunk;
        
        if (isFirstChunk && aiMessage.content.trim().length > 0) {
          setMessages(prev => [...prev.slice(0, -1), { ...aiMessage }]);
          isFirstChunk = false;
        } else if (!isFirstChunk) {
          setMessages(prev => [...prev.slice(0, -1), { ...aiMessage }]);
        }
        
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } catch (err) {
      setMessages(prev => [
        ...prev.slice(0, -1),
        { role: "assistant", content: "Error: " + err.message }
      ]);
    } finally {
      setIsSending(false);
      setActiveTab("agent");
    }
  };

  // Suggested questions
  const suggestedQuestions = [
    "How long does the NTCA recommend the patient isolate?",
    "Would the patient need to continue isolating?",
    "What are the isolation criteria for TB patients?",
    "When can a TB patient discontinue isolation?"
  ];

  const handleSuggestedQuestion = (question) => {
    setInput(question);
    handleSend(question);
  };

  return (
    <div className="app-layout">
      {/* Main Chat Container */}
      <div className={`chat-container ${helpPanel.isOpen ? 'with-help-panel' : ''}`}>
        {/* Instructions Banner */}
        <div className="instructions-banner">
          <p>📋 <strong>Getting Started:</strong> Fill out the Patient Narrative → Complete Labs, Community Risk, Patient Harm, and Treatment tabs → Use the Decision-Support Agent for guidance</p>
          {onBackToHome && (
            <button className="back-home-btn" onClick={onBackToHome}>
              ← Back to Home
            </button>
          )}
        </div>

        <div className="tab-header">
          <button
            className={activeTab === "narrative" ? "active" : ""}
            onClick={() => setActiveTab("narrative")}
          >
            Patient Narrative
          </button>
          <button
            className={activeTab === "labs" ? "active" : ""}
            onClick={() => setActiveTab("labs")}
          >
            Labs
          </button>
          <button
            className={activeTab === "community" ? "active" : ""}
            onClick={() => setActiveTab("community")}
          >
            Community Risk
          </button>
          <button
            className={activeTab === "patientHarm" ? "active" : ""}
            onClick={() => setActiveTab("patientHarm")}
          >
            Patient Harm
          </button>
          <button
            className={activeTab === "treatment" ? "active" : ""}
            onClick={() => setActiveTab("treatment")}
          >
            Treatment
          </button>
          <button
            className={activeTab === "agent" ? "active" : ""}
            onClick={() => setActiveTab("agent")}
          >
            Decision-Support Agent
          </button>
          <button className="reset-btn" onClick={resetSession}>
            Reset Session
          </button>
        </div>

        {activeTab === "narrative" && (
          <div className="context-tab">
            <h2>Patient Narrative</h2>
            <p>
              Enter relevant patient information below. This will be used by the
              Decision-Support Agent once you start chatting.
            </p>
            <textarea
              value={patientContext}
              onChange={e => setPatientContext(e.target.value)}
              placeholder="e.g. 30 year old female, 3 week productive cough and mild fatigue, chest radiograph: non‑cavitary right middle‑lobe infiltrate"
            />
            <button
              className="primary-btn"
              onClick={() => setActiveTab("labs")}
            >
              Continue to Labs
            </button>
          </div>
        )}

        {activeTab === "labs" && (
          <div className="context-tab">
            <h2>Laboratory Data</h2>

            <div className="field-with-help">
              <label>Pre-Treatment Bacterial Burden: {structuredData.bacterialBurden ?? 'Not set'}</label>
              <button className="help-btn" onClick={() => openHelpPanel('bacterialBurden')}>
                Help me decide
              </button>
            </div>
            <div className="field-instructions">
              <p><strong>Please consider the following questions:</strong></p>
              <ul>
                <li>Was the patient sputum smear-positive?</li>
                <li>Any chest imaging findings such as cavitary lesions?</li>
                <li>Are they coughing?</li>
              </ul>
              <p><em>If smear-negative, non-cavitary, and no active cough, the pre-treatment bacterial burden is generally considered low. Alternatively, if they are smear-positive and have cavity on lung imaging, you can consider them 'high'.</em></p>
            </div>
            <select
              value={structuredData.bacterialBurden ?? ""}
              onChange={e =>
                setStructuredData(prev => ({ ...prev, bacterialBurden: e.target.value }))
              }
            >
              <option value="">-- Select --</option>
              <option>Low</option>
              <option>Moderate</option>
              <option>High</option>
            </select>

            <div className="field-with-help">
              <label>GeneXpert and Drug Susceptibility: {structuredData.geneXpert ?? 'Not set'}</label>
              <button className="help-btn" onClick={() => openHelpPanel('geneXpert')}>
                Help me decide
              </button>
            </div>
            <div className="field-instructions">
              <p><strong>Please consider:</strong></p>
              <ul>
                <li>Has GeneXpert or any rapid molecular test been done?</li>
                <li>Is rifampin susceptibility confirmed, or are we waiting on results?</li>
              </ul>
            </div>
            <select
              value={structuredData.geneXpert ?? ""}
              onChange={e =>
                setStructuredData(prev => ({ ...prev, geneXpert: e.target.value }))
              }
            >
              <option value="">-- Select --</option>
              <option>Positive (rifampin resistant)</option>
              <option>Positive (rifampin susceptible—no resistance detected)</option>
              <option>Negative</option>
              <option>Pending or Not Available</option>
            </select>

            <button
              className="primary-btn"
              onClick={() => setActiveTab("community")}
            >
              Continue to Community Risk
            </button>
          </div>
        )}

        {activeTab === "community" && (
          <div className="context-tab">
            <h2>Community Risk Assessment</h2>

            <div className="field-with-help">
              <label>Community Risk: {structuredData.communityRisk ?? 'Not set'}</label>
              <button className="help-btn" onClick={() => openHelpPanel('communityRisk')}>
                Help me decide
              </button>
            </div>
            <div className="field-instructions">
              <p><strong>Please consider these factors in making a judgement on the level of community risk of transmission (if infectious):</strong></p>
              <ul>
                <li>How many new contacts is the patient likely to have?</li>
                <li>Are any of the contacts vulnerable to infection or disease progression (e.g., children, immunocompromised individuals)?</li>
                <li>How often? In what kind of ventilation settings?</li>
              </ul>
            </div>
            <select
              value={structuredData.communityRisk ?? ""}
              onChange={e =>
                setStructuredData(prev => ({ ...prev, communityRisk: e.target.value }))
              }
            >
              <option value="">-- Select --</option>
              <option>Low</option>
              <option>Medium</option>
              <option>High</option>
            </select>

            <button
              className="primary-btn"
              onClick={() => setActiveTab("patientHarm")}
            >
              Continue to Patient Harm
            </button>
          </div>
        )}

        {activeTab === "patientHarm" && (
          <div className="context-tab">
            <h2>Patient Harm Assessment</h2>

            <div className="field-with-help">
              <label>Patient Harm: {structuredData.patientHarm ?? 'Not set'}</label>
              <button className="help-btn" onClick={() => openHelpPanel('patientHarm')}>
                Help me decide
              </button>
            </div>
            <div className="field-instructions">
              <p><strong>Please consider each of the following dimensions in determining the likely or anticipated impact of restrictions on patient well-being:</strong></p>
              <p>A common signaling question is: <em>"How would isolation affect housing, finances, food security, employment, or mental health?"</em></p>
            </div>
            <select
              value={structuredData.patientHarm ?? ""}
              onChange={e =>
                setStructuredData(prev => ({ ...prev, patientHarm: e.target.value }))
              }
            >
              <option value="">-- Select --</option>
              <option>Low</option>
              <option>Medium</option>
              <option>High</option>
            </select>

            <button
              className="primary-btn"
              onClick={() => setActiveTab("treatment")}
            >
              Continue to Treatment
            </button>
          </div>
        )}

        {activeTab === "treatment" && (
          <div className="context-tab">
            <h2>Treatment Information</h2>

            <div className="field-instructions">
              <p><strong>Please consider:</strong></p>
              <ul>
                <li>Has the patient started TB treatment?</li>
                <li>Which regimen?</li>
                <li>How many days of treatment have they completed?</li>
                <li>Are they tolerating treatment well, and is there any direct observation (DOT or VDOT)?</li>
              </ul>
            </div>

            <div className="field-with-help">
              <label>Days on Treatment: {structuredData.treatmentDays ?? 'Not set'}</label>
              <button className="help-btn" onClick={() => openHelpPanel('treatmentDays')}>
                Help me decide
              </button>
            </div>
            <input
              type="number"
              min="0"
              placeholder="Enter number of days"
              value={structuredData.treatmentDays ?? ""}
              onChange={e =>
                setStructuredData(prev => ({ ...prev, treatmentDays: e.target.value }))
              }
              style={{
                width: '100%',
                padding: '8px',
                marginBottom: '12px',
                borderRadius: '6px',
                border: '1px solid #ccc'
              }}
            />

            <div className="field-with-help">
              <label>Treatment Drugs Started: {structuredData.treatmentDrugs ? 'Entered' : 'Not set'}</label>
              <button className="help-btn" onClick={() => openHelpPanel('treatmentDrugs')}>
                Help me decide
              </button>
            </div>
            <textarea
              placeholder="Please indicate the drugs that have been started (e.g., rifampin, isoniazid, pyrazinamide, ethambutol)"
              value={structuredData.treatmentDrugs ?? ""}
              onChange={e =>
                setStructuredData(prev => ({ ...prev, treatmentDrugs: e.target.value }))
              }
              style={{
                width: '100%',
                minHeight: '80px',
                padding: '8px',
                marginBottom: '12px',
                borderRadius: '6px',
                border: '1px solid #ccc',
                resize: 'vertical'
              }}
            />

            <div className="field-with-help">
              <label>Treatment Tolerance & Verification: {structuredData.treatmentTolerance ? 'Entered' : 'Not set'}</label>
              <button className="help-btn" onClick={() => openHelpPanel('treatmentTolerance')}>
                Help me decide
              </button>
            </div>
            <textarea
              placeholder="Is the patient tolerating treatment? Has verification been confirmed by DOT/vDOT?"
              value={structuredData.treatmentTolerance ?? ""}
              onChange={e =>
                setStructuredData(prev => ({ ...prev, treatmentTolerance: e.target.value }))
              }
              style={{
                width: '100%',
                minHeight: '80px',
                padding: '8px',
                marginBottom: '12px',
                borderRadius: '6px',
                border: '1px solid #ccc',
                resize: 'vertical'
              }}
            />

            <div className="field-with-help">
              <label>Concern for Drug Resistance: {structuredData.drugResistance ?? 'Not set'}</label>
              <button className="help-btn" onClick={() => openHelpPanel('drugResistance')}>
                Help me decide
              </button>
            </div>
            <div className="field-instructions">
              <p><strong>Please consider:</strong></p>
              <ul>
                <li>Is there any known or suspected resistance to first-line medications?</li>
                <li>Any epidemiologic risk factors for MDR TB?</li>
              </ul>
            </div>
            <select
              value={structuredData.drugResistance ?? ""}
              onChange={e =>
                setStructuredData(prev => ({ ...prev, drugResistance: e.target.value }))
              }
            >
              <option value="">-- Select --</option>
              <option>Yes</option>
              <option>No</option>
            </select>

            <button
              className="primary-btn"
              onClick={() => setActiveTab("agent")}
            >
              Continue to Decision-Support Agent
            </button>
          </div>
        )}

        {activeTab === "agent" && (
          <div className="chat-tab-container">
            <div className="chat-messages">
              {messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`chat-bubble ${msg.role === "user" ? "user" : "assistant"}`}
                >
                  {msg.isThinking ? (
                    <span style={{ 
                      fontStyle: 'italic', 
                      opacity: 1, 
                      color: '#333',
                      display: 'inline-block',
                      minWidth: '80px'
                    }}>
                      <ThinkingDots />
                    </span>
                  ) : (
                    msg.content
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>

            {/* Suggested Questions - Fixed height container */}
            <div className="suggested-questions-container">
              {showSuggestedQuestions ? (
                <div className="suggested-questions">
                  <div className="suggested-header">
                    <p className="suggested-label">Suggested questions:</p>
                    <button 
                      className="collapse-suggested-btn" 
                      onClick={() => setShowSuggestedQuestions(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="suggested-buttons">
                    {suggestedQuestions.map((question, idx) => (
                      <button
                        key={idx}
                        className="suggested-question-btn"
                        onClick={() => handleSuggestedQuestion(question)}
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
                onChange={e => setInput(e.target.value)}
                placeholder="Ask a question..."
                rows={1}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <button onClick={() => handleSend()} disabled={isSending}>
                Send
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Help Side Panel */}
      {helpPanel.isOpen && (
        <div className="help-side-panel">
          <div className="help-panel-header">
            <h3>Help me decide: {helpPanel.topic}</h3>
            <button className="close-panel-btn" onClick={closeHelpPanel}>×</button>
          </div>
          
          <div className="help-panel-messages">
            {helpPanel.messages.map((msg, idx) => (
              <div
                key={idx}
                className={`chat-bubble ${msg.role === "user" ? "user" : "assistant"}`}
              >
                {msg.isThinking ? (
                  <span style={{ 
                    fontStyle: 'italic', 
                    opacity: 1, 
                    color: '#333',
                    display: 'inline-block',
                    minWidth: '80px'
                  }}>
                    <ThinkingDots />
                  </span>
                ) : (
                  msg.content
                )}
              </div>
            ))}
            <div ref={helpChatEndRef} />
          </div>

          <div className="help-panel-input">
            <textarea
              className="chat-input"
              value={helpPanel.input}
              onChange={e => setHelpPanel(prev => ({ ...prev, input: e.target.value }))}
              placeholder="Ask a follow-up question..."
              rows={1}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendHelpMessage();
                }
              }}
            />
            <button onClick={sendHelpMessage} disabled={helpPanel.isSending}>
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ThinkingDots() {
  const [dots, setDots] = useState(".");

  useEffect(() => {
    const interval = setInterval(() => {
      setDots(prev => {
        if (prev === ".") return "..";
        if (prev === "..") return "...";
        return ".";
      });
    }, 500);

    return () => clearInterval(interval);
  }, []);

  return <span style={{ color: '#333' }}>Thinking{dots}</span>;
}