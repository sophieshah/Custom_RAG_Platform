# TB Guidance Assistant

The project has a React/Vite frontend and an Express backend. Every chat question uses Qdrant retrieval-augmented generation (RAG), the retrieved knowledge sources, and the system instructions. Answers cite source passages when available. The frontend talks to `POST /api/chat`; responses are returned as Markdown-compatible plain text.

> **Clinical safety:** this educational assistant is not a substitute for qualified clinical or public-health judgment. Verify guidance against appropriate authorities before making patient-care decisions.

## Requirements

- Windows, macOS, or Linux
- Node.js 20.16 or newer and npm
- Python 3.10 or newer
- Docker Desktop with Docker Compose, or an available Qdrant Cloud collection
- An OpenAI API key for answer generation
- Python packages from `backend/requirements.txt` for local embeddings and PDF ingestion

Qdrant must contain the guidance documents to be searched. Use the same embedding model and vector dimension for ingestion and query-time retrieval. Defaults: `intfloat/e5-large-v2` and 1024 dimensions. The backend detects a repository `.venv`; otherwise ensure Python is on `PATH` or configure `PYTHON_EXECUTABLE`.

## First-time setup

Run the following from the repository root in PowerShell.

1. Install dependencies:

   ```powershell
   npm install
   python -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
   ```

2. Create the local environment file and edit it:

   ```powershell
   if (-not (Test-Path .env)) { Copy-Item .env.example .env }
   ```

   Set at least `OPENAI_API_KEY`. For local Qdrant, set these values in `.env`:

   ```env
   OPENAI_MODEL=gpt-4o-mini
   EMBEDDING_MODEL=intfloat/e5-large-v2
   EMBEDDING_DIMENSION=1024
   QDRANT_URL=http://127.0.0.1:6333
   QDRANT_COLLECTION=tb_guidance
   NODE_KNOWLEDGE_DIR=knowledge-base
   PORT=3001
   ```

   For Qdrant Cloud, use your cloud URL and set `QDRANT_API_KEY`. Never put API keys in frontend code or commit `.env`.

3. Start local Qdrant in a terminal:

   ```powershell
   docker compose up -d
   ```

   Its data is kept in a named Docker volume.

4. Index documents before asking evidence-based questions. The repository contains PDFs in `documents/`; index those with the Python ingestion pipeline:

   ```powershell
   .\.venv\Scripts\python.exe backend\ingest.py documents
   ```

   Alternatively, put `.pdf`, `.md`, or `.txt` documents under `knowledge-base/` and run:

   ```powershell
   npm run ingest
   ```

   Both ingestion paths must use the same collection, embedding model, and vector dimension as the running backend. The PDF pipeline can call the configured OpenAI vision model when `ENABLE_VISION=true`; check its settings and costs before using it. Changing `EMBEDDING_MODEL` or `EMBEDDING_DIMENSION` requires re-indexing the documents. The backend checks the collection dimension and fails startup if it does not match.

## Run the application

Keep the Qdrant service running, then open two terminals at the repository root:

**Terminal 1 — backend API**

```powershell
npm start
```

The backend listens on `http://localhost:3001`. Startup connects to Qdrant, checks the collection dimension, and starts the local embedding worker. Leave this terminal open.

**Terminal 2 — frontend**

```powershell
npm run dev
```

Open the Vite URL shown in the terminal (usually `http://localhost:5173`) and ask a question in Guidance Chat. To stop the app, press `Ctrl+C` in each terminal; to stop local Qdrant, run `docker compose down` from the repository root.

## Admin: manage documents and system instructions

Admin tools are disabled until credentials are configured. Add both of these values to `.env`, then restart the backend:

```env
ADMIN_USERNAME=your-admin-name
ADMIN_PASSWORD=use-a-long-unique-password-of-at-least-14-characters
ADMIN_DATA_DIR=data
```

Open the app homepage and select **Admin**, then sign in. Login is rate-limited; issued sessions expire after two hours and are kept in server memory, so a backend restart signs admins out. The browser keeps the session token only in memory. Use HTTPS and protect access to the server when deploying beyond local development.

### View and remove indexed documents

The **Indexed Qdrant documents** list is loaded from the configured collection after admin sign-in. It groups indexed chunks by document and shows each source and chunk count. Use **Refresh** to reload the list. **Delete** removes every chunk for the selected source from Qdrant; for files added through the admin upload form, it also removes the stored upload.

### Add documents to Qdrant

In **Upload knowledge documents**, select one or more `.pdf`, `.md`, or `.txt` files (up to 20 MB each) and choose **Upload and index**. The backend processes each selected file, extracts text, chunks it, creates vectors with the configured local embedding model, and adds the chunks to the configured Qdrant collection. Uploaded source files are saved under `ADMIN_DATA_DIR/uploads`; the collection records the source as `admin_uploads/<filename>`. Uploading a file again with the same normalized filename updates its indexed chunks.

### Edit system instructions

Use the **System instructions** editor to replace the public-health system prompt. The updated text is written to `backend/rag/system-instructions.js` and takes effect immediately; keep a backup before editing. All chat responses use these instructions alongside retrieved source passages.

Keep instructions operational and concise; do not put secrets or patient information in this field.

## How chat works

1. The backend embeds the user's question with the configured local sentence-transformer model and retrieves relevant passages from Qdrant.
2. The answer model uses the retrieved passages, conversation history, and system instructions to compose an answer with source citations. It may request one focused follow-up retrieval if the initial passages leave an important gap.
3. If no relevant passages are found, the API returns a no-evidence response rather than inventing guidance.

## Operational notes

- The API streams the user-facing response as plain text.
- Optional patient narrative and structured tab inputs are sent to the LLM as user-provided context with each request; they are not indexed in Qdrant and do not replace retrieved evidence.
- Conversation history is sent for the active request and is not indexed in Qdrant.
- In development, `[tb-rag]` console traces show retrieval and response assembly. Detailed traces are suppressed for `NODE_ENV=production` and `NODE_ENV=test`.
- For Qdrant connection, model, or dimension errors, check `.env`, verify that Qdrant is reachable, and confirm that ingestion and runtime use the same collection and embedding configuration.

## Tests

Run the backend/API tests and build the frontend:

```powershell
npm test
npm run build
```

Before any clinical use, domain experts should validate retrieval quality, citation accuracy, and the content of the system instructions. Review privacy, access control, and logging before sending sensitive information to any model or hosted service.
