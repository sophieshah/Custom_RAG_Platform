import React, { useRef, useState } from "react";
import "./admin.css";

const API_URL = "http://localhost:3001/api/admin";
const FIELD_TYPES = ["text", "textarea", "number", "select", "checkbox"];

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

function nextId(prefix, usedIds) {
  let suffix = usedIds.size + 1;
  let id = `${prefix}-${suffix}`;
  while (usedIds.has(id)) {
    suffix += 1;
    id = `${prefix}-${suffix}`;
  }
  return id;
}

function ConfigPreview({ config }) {
  const [activeTabId, setActiveTabId] = useState(config.tabs[0]?.id || "");
  const activeTab = config.tabs.find((tab) => tab.id === activeTabId);

  React.useEffect(() => {
    if (!config.tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId(config.tabs[0]?.id || "");
    }
  }, [config, activeTabId]);

  return (
    <div className="input-preview">
      <p className="admin-preview-note">Preview only — these changes are not live until saved.</p>
      <div className="admin-preview-tabs" role="tablist" aria-label="Preview input tabs">
        {config.tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTabId === tab.id ? "active" : ""}
            onClick={() => setActiveTabId(tab.id)}
          >
            {tab.title || "Untitled tab"}
          </button>
        ))}
      </div>
      {config.tabs.length === 0 && <p>No frontend input tabs are configured.</p>}
      {activeTab && (
        <section className="context-tab admin-preview-panel">
          <h3>{activeTab.title || "Untitled tab"}</h3>
          {activeTab.description && <p>{activeTab.description}</p>}
          {activeTab.fields.map((field) => (
            <label key={field.id} className={`context-field ${field.type === "checkbox" ? "context-checkbox" : ""}`}>
              {field.label || "Untitled field"}{field.required ? " *" : ""}
              {field.type === "textarea" ? (
                <textarea placeholder={field.placeholder || ""} disabled />
              ) : field.type === "select" ? (
                <select disabled defaultValue="">
                  <option value="">Not provided</option>
                  {(field.options || []).map((option, index) => (
                    <option key={`${option}-${index}`}>{option}</option>
                  ))}
                </select>
              ) : field.type === "checkbox" ? (
                <input type="checkbox" disabled />
              ) : (
                <input type={field.type || "text"} placeholder={field.placeholder || ""} disabled />
              )}
            </label>
          ))}
          {activeTab.fields.length === 0 && <p>This tab has no input fields.</p>}
        </section>
      )}
    </div>
  );
}

async function readResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload;
}

export default function AdminPanel({ onBack }) {
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [instructions, setInstructions] = useState("");
  const [files, setFiles] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [adminTab, setAdminTab] = useState("frontend");
  const [inputConfig, setInputConfig] = useState(null);
  const [draftConfig, setDraftConfig] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const fileInputRef = useRef(null);

  const authorizedFetch = (url, options = {}) => fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });

  const fetchDocuments = async (authToken = token) => {
    const response = await fetch(`${API_URL}/documents`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const result = await readResponse(response);
    setDocuments(result.documents);
    return result.documents;
  };

  const fetchInputConfig = async (authToken = token) => {
    const response = await fetch(`${API_URL}/input-config`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const result = await readResponse(response);
    setInputConfig(result);
    setDraftConfig(cloneConfig(result));
    return result;
  };

  const handleLogin = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const result = await readResponse(response);
      const instructionResponse = await fetch(`${API_URL}/instructions`, {
        headers: { Authorization: `Bearer ${result.token}` },
      });
      const stored = await readResponse(instructionResponse);
      const configResponse = await fetch(`${API_URL}/input-config`, {
        headers: { Authorization: `Bearer ${result.token}` },
      });
      const loadedConfig = await readResponse(configResponse);
      const documentResponse = await fetch(`${API_URL}/documents`, {
        headers: { Authorization: `Bearer ${result.token}` },
      });
      const loadedDocuments = await readResponse(documentResponse);
      setToken(result.token);
      setPassword("");
      setInstructions(stored.systemInstructions);
      setInputConfig(loadedConfig);
      setDraftConfig(cloneConfig(loadedConfig));
      setDocuments(loadedDocuments.documents);
      setStatus(`Signed in. Loaded ${loadedDocuments.documents.length} indexed document(s) and input configuration.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const saveInputConfig = async () => {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await authorizedFetch(`${API_URL}/input-config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftConfig),
      });
      const result = await readResponse(response);
      setInputConfig(result.inputConfig);
      setDraftConfig(cloneConfig(result.inputConfig));
      setShowPreview(false);
      setStatus("Frontend input configuration saved.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const updateTab = (tabIndex, updates) => {
    setDraftConfig((current) => ({
      ...current,
      tabs: current.tabs.map((tab, index) => (
        index === tabIndex ? { ...tab, ...updates } : tab
      )),
    }));
  };

  const updateField = (tabIndex, fieldIndex, updates) => {
    setDraftConfig((current) => ({
      ...current,
      tabs: current.tabs.map((tab, index) => (
        index !== tabIndex
          ? tab
          : {
            ...tab,
            fields: tab.fields.map((field, itemIndex) => (
              itemIndex === fieldIndex ? { ...field, ...updates } : field
            )),
          }
      )),
    }));
  };

  const addTab = () => {
    setDraftConfig((current) => {
      const tabId = nextId("tab", new Set(current.tabs.map((tab) => tab.id)));
      return {
        ...current,
        tabs: [...current.tabs, { id: tabId, title: "New tab", description: "", fields: [] }],
      };
    });
  };

  const removeTab = (tabIndex) => {
    setDraftConfig((current) => ({
      ...current,
      tabs: current.tabs.filter((_, index) => index !== tabIndex),
    }));
  };

  const addField = (tabIndex) => {
    setDraftConfig((current) => {
      const usedIds = new Set(current.tabs.flatMap((tab) => tab.fields.map((field) => field.id)));
      const fieldId = nextId("field", usedIds);
      return {
        ...current,
        tabs: current.tabs.map((tab, index) => (
          index === tabIndex
            ? {
              ...tab,
              fields: [...tab.fields, {
                id: fieldId,
                label: "New input",
                type: "text",
                placeholder: "",
              }],
            }
            : tab
        )),
      };
    });
  };

  const removeField = (tabIndex, fieldIndex) => {
    setDraftConfig((current) => ({
      ...current,
      tabs: current.tabs.map((tab, index) => (
        index === tabIndex
          ? { ...tab, fields: tab.fields.filter((_, itemIndex) => itemIndex !== fieldIndex) }
          : tab
      )),
    }));
  };

  const saveInstructions = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await authorizedFetch(`${API_URL}/instructions`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemInstructions: instructions }),
      });
      const result = await readResponse(response);
      setInstructions(result.systemInstructions);
      setStatus("Full system instructions saved to system-instructions.js.");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const uploadFiles = async (event) => {
    event.preventDefault();
    if (files.length === 0) {
      setError("Choose at least one supported document file.");
      return;
    }
    setBusy(true);
    setError("");
    setStatus("");
    const outcomes = [];
    try {
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);
        const response = await authorizedFetch(`${API_URL}/documents`, {
          method: "POST",
          body: formData,
        });
        const result = await readResponse(response);
        outcomes.push(result.message);
      }
      setStatus(outcomes.join(" "));
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await fetchDocuments();
    } catch (requestError) {
      setError(`${requestError.message}${outcomes.length ? ` Already indexed: ${outcomes.join(" ")}` : ""}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteDocument = async (document) => {
    if (!window.confirm(`Delete "${document.title}" and all of its indexed chunks from Qdrant?`)) {
      return;
    }
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const response = await authorizedFetch(`${API_URL}/documents`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceFile: document.sourceFile }),
      });
      const result = await readResponse(response);
      setDocuments((current) => current.filter((item) => item.sourceFile !== document.sourceFile));
      setStatus(result.message);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    let logoutError = "";
    try {
      await authorizedFetch(`${API_URL}/logout`, { method: "POST" });
    } catch (requestError) {
      logoutError = requestError.message;
    } finally {
      setToken("");
      setInstructions("");
      setDocuments([]);
      setInputConfig(null);
      setDraftConfig(null);
      setShowPreview(false);
      setBusy(false);
      setStatus("");
      setError(logoutError);
    }
  };

  return (
    <main className="admin-page">
      <section className="admin-card">
        <button className="admin-back" onClick={onBack}>← Back</button>
        <h1>Administration</h1>
        {!token ? (
          <form className="admin-form" onSubmit={handleLogin}>
            <h2>Admin sign in</h2>
            <label>
              Username
              <input
                autoComplete="username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            <button className="admin-primary" disabled={busy}>
              {busy ? "Signing in..." : "Sign in"}
            </button>
          </form>
        ) : (
          <>
            <div className="admin-toolbar">
              <p>Administrative tools</p>
              <button onClick={logout} disabled={busy}>Sign out</button>
            </div>

            <nav className="admin-tabs" aria-label="Administration sections">
              <button
                type="button"
                className={adminTab === "frontend" ? "active" : ""}
                onClick={() => setAdminTab("frontend")}
              >
                Frontend
              </button>
              <button
                type="button"
                className={adminTab === "backend" ? "active" : ""}
                onClick={() => setAdminTab("backend")}
              >
                Backend
              </button>
            </nav>

            {adminTab === "frontend" && draftConfig && (
              <section className="admin-section">
                <div className="admin-section-heading">
                  <div>
                    <h2>Frontend input tabs</h2>
                    <p>
                      Add and configure tabs and fields. The saved JSON schema is loaded by the chat
                      and parsed into the matching controls.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      setBusy(true);
                      setError("");
                      try {
                        await fetchInputConfig();
                        setShowPreview(false);
                        setStatus("Loaded the saved frontend input configuration.");
                      } catch (requestError) {
                        setError(requestError.message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                    disabled={busy}
                  >
                    Reload saved
                  </button>
                </div>

                <div className="admin-builder-actions">
                  <button type="button" className="admin-primary" onClick={addTab} disabled={busy}>
                    Add tab
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowPreview((visible) => !visible)}
                    disabled={busy}
                  >
                    {showPreview ? "Hide preview" : "Preview changes"}
                  </button>
                  <button
                    type="button"
                    className="admin-primary"
                    onClick={saveInputConfig}
                    disabled={busy || JSON.stringify(inputConfig) === JSON.stringify(draftConfig)}
                  >
                    {busy ? "Saving..." : "Save frontend configuration"}
                  </button>
                </div>

                <details className="admin-schema-details">
                  <summary>View JSON configuration</summary>
                  <pre>{JSON.stringify(draftConfig, null, 2)}</pre>
                </details>

                {showPreview && <ConfigPreview config={draftConfig} />}

                {draftConfig.tabs.map((tab, tabIndex) => (
                  <section key={`${tab.id}-${tabIndex}`} className="admin-builder-card">
                    <div className="admin-builder-card-heading">
                      <h3>Tab {tabIndex + 1}</h3>
                      <button
                        type="button"
                        className="admin-delete"
                        onClick={() => removeTab(tabIndex)}
                        disabled={busy}
                      >
                        Remove tab
                      </button>
                    </div>
                    <div className="admin-builder-grid">
                      <label>
                        Tab ID
                        <input
                          value={tab.id}
                          onChange={(event) => updateTab(tabIndex, { id: event.target.value })}
                        />
                      </label>
                      <label>
                        Tab title
                        <input
                          value={tab.title}
                          onChange={(event) => updateTab(tabIndex, { title: event.target.value })}
                        />
                      </label>
                      <label className="admin-builder-wide">
                        Tab description
                        <textarea
                          rows={2}
                          value={tab.description || ""}
                          onChange={(event) => updateTab(tabIndex, { description: event.target.value })}
                        />
                      </label>
                    </div>

                    <div className="admin-fields-heading">
                      <h4>Input fields</h4>
                      <button type="button" onClick={() => addField(tabIndex)} disabled={busy}>
                        Add field
                      </button>
                    </div>
                    {tab.fields.map((field, fieldIndex) => (
                      <div key={`${field.id}-${fieldIndex}`} className="admin-field-editor">
                        <div className="admin-builder-grid">
                          <label>
                            Field ID
                            <input
                              value={field.id}
                              onChange={(event) => updateField(tabIndex, fieldIndex, { id: event.target.value })}
                            />
                          </label>
                          <label>
                            Label
                            <input
                              value={field.label}
                              onChange={(event) => updateField(tabIndex, fieldIndex, { label: event.target.value })}
                            />
                          </label>
                          <label>
                            Control type
                            <select
                              value={field.type}
                              onChange={(event) => {
                                const type = event.target.value;
                                updateField(tabIndex, fieldIndex, {
                                  type,
                                  ...(type === "select" ? { options: field.options || ["Option 1"] } : { options: undefined }),
                                });
                              }}
                            >
                              {FIELD_TYPES.map((type) => (
                                <option key={type} value={type}>{type}</option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Placeholder
                            <input
                              value={field.placeholder || ""}
                              onChange={(event) => updateField(tabIndex, fieldIndex, { placeholder: event.target.value })}
                            />
                          </label>
                          {field.type === "select" && (
                            <label className="admin-builder-wide">
                              Options (one per line)
                              <textarea
                                rows={3}
                                value={(field.options || []).join("\n")}
                                onChange={(event) => updateField(tabIndex, fieldIndex, {
                                  options: event.target.value.split(/\r?\n/).filter((option) => option.trim()),
                                })}
                              />
                            </label>
                          )}
                          <label className="admin-required-option">
                            <input
                              type="checkbox"
                              checked={Boolean(field.required)}
                              onChange={(event) => updateField(tabIndex, fieldIndex, { required: event.target.checked })}
                            />
                            Required input
                          </label>
                        </div>
                        <button
                          type="button"
                          className="admin-delete"
                          onClick={() => removeField(tabIndex, fieldIndex)}
                          disabled={busy}
                        >
                          Remove field
                        </button>
                      </div>
                    ))}
                    {tab.fields.length === 0 && <p className="admin-empty">No fields added to this tab.</p>}
                  </section>
                ))}
              </section>
            )}

            {adminTab === "backend" && (
              <>
            <section className="admin-section">
              <div className="admin-section-heading">
                <div>
                  <h2>Indexed Qdrant documents</h2>
                  <p>Documents available to RAG. Deleting a document removes all its indexed chunks from Qdrant.</p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      const currentDocuments = await fetchDocuments();
                      setStatus(`Loaded ${currentDocuments.length} indexed document(s) from Qdrant.`);
                    } catch (requestError) {
                      setError(requestError.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  disabled={busy}
                >
                  Refresh
                </button>
              </div>
              {documents.length === 0 ? (
                <p className="admin-empty">No documents are currently indexed in Qdrant.</p>
              ) : (
                <ul className="admin-indexed-list">
                  {documents.map((document) => (
                    <li key={document.sourceFile} className="admin-indexed-item">
                      <div>
                        <strong>{document.title}</strong>
                        <span>{document.sourceFile}</span>
                        <span>{document.pointCount} indexed chunk{document.pointCount === 1 ? "" : "s"}</span>
                      </div>
                      <button
                        type="button"
                        className="admin-delete"
                        onClick={() => deleteDocument(document)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="admin-section">
              <h2>Upload knowledge documents</h2>
              <p>Upload PDF, Markdown, or text files. Files are chunked, embedded, and indexed in the configured Qdrant collection. Files up to 20 MB are accepted.</p>
              <form className="admin-form" onSubmit={uploadFiles}>
                <label>
                  Select documents
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.md,.txt"
                    multiple
                    onChange={(event) => setFiles(Array.from(event.target.files || []))}
                  />
                </label>
                {files.length > 0 && (
                  <ul className="admin-file-list">
                    {files.map((file) => <li key={`${file.name}-${file.lastModified}`}>{file.name}</li>)}
                  </ul>
                )}
                <button className="admin-primary" disabled={busy || files.length === 0}>
                  {busy ? "Uploading and indexing..." : "Upload and index"}
                </button>
              </form>
            </section>

            <section className="admin-section">
              <h2>Full system instructions</h2>
              <p>
                Edit the complete system prompt used by the RAG assistant.
                Changes are written to systemoinstructions.js. Review changes
                carefully before saving because this includes the public-health
                safety and evidence-grounding instructions.
              </p>
              <form className="admin-form" onSubmit={saveInstructions}>
                <label>
                  Full system instructions
                  <textarea
                    rows={12}
                    maxLength={100000}
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    placeholder="Edit the complete system prompt..."
                  />
                </label>
                <span className="admin-character-count">{instructions.length}/100,000</span>
                <button className="admin-primary" disabled={busy}>
                  {busy ? "Saving..." : "Save instructions"}
                </button>
              </form>
            </section>
              </>
            )}
          </>
        )}
        {status && <p className="admin-status" role="status">{status}</p>}
        {error && <p className="admin-error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
