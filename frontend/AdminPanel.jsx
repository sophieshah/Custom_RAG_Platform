import React, { useRef, useState } from "react";
import "./admin.css";

const API_URL = "http://localhost:3001/api/admin";

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
      setToken(result.token);
      setPassword("");
      setInstructions(stored.systemInstructions);
      const indexedDocuments = await fetchDocuments(result.token);
      setStatus(`Signed in. Loaded ${indexedDocuments.length} indexed document(s) from Qdrant.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
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
      setError("Choose at least one PDF file.");
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
              <p>Upload PDF files ONLY. Files are chunked, embedded, and indexed in the configured Qdrant collection. Files up to 20 MB are accepted. Note that the name of the new file must be different from existing filenames.</p>
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
        {status && <p className="admin-status" role="status">{status}</p>}
        {error && <p className="admin-error" role="alert">{error}</p>}
      </section>
    </main>
  );
}
