# TB Isolation Chatbot

The project has a React/Vite frontend and an Express backend. General TB questions use Qdrant retrieval-augmented generation (RAG). Case-specific community-isolation questions use structured case extraction, Python schema validation, and the deterministic Python rule engine, followed by one LLM narrative interpreter. The decision-support path currently does not retrieve or independently compare guideline evidence; the engine output is preserved and explained rather than replaced. The existing frontend talks to `POST /api/chat`; responses are returned as Markdown-compatible plain text.

> **Clinical safety:** the rules in `tb_isolation_rules_package/` are draft and not clinically validated. They produce reproducible tool outputs, not clinically certain recommendations. Do not use this application to make patient-care decisions without review and approval by qualified TB clinicians and public-health authorities. The rule engine does not grant healthcare or congregate-facility clearance.

## Requirements

- Windows, macOS, or Linux
- Node.js 20.16 or newer and npm
- Python 3.10 or newer
- Docker Desktop with Docker Compose, or an available Qdrant Cloud collection
- An OpenAI API key for task classification, case extraction, and narrative generation
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

Open the Vite URL shown in the terminal (usually `http://localhost:5173`). Enter patient details in the form tabs and ask a question in the Decision-Support Agent tab. To stop the app, press `Ctrl+C` in each terminal; to stop local Qdrant, run `docker compose down` from the repository root.

## Admin: upload documents and manage supplemental instructions

Admin tools are disabled until credentials are configured. Add both of these values to `.env`, then restart the backend:

```env
ADMIN_USERNAME=your-admin-name
ADMIN_PASSWORD=use-a-long-unique-password-of-at-least-14-characters
ADMIN_DATA_DIR=data
```

Open the app homepage and select **Admin**, then sign in. Login is rate-limited; issued sessions expire after two hours and are kept in server memory, so a backend restart signs admins out. The browser keeps the session token only in memory. Use HTTPS and protect access to the server when deploying beyond local development.

### Add documents to Qdrant

In **Upload knowledge documents**, select one or more `.pdf`, `.md`, or `.txt` files (up to 20 MB each) and choose **Upload and index**. The backend processes each selected file, extracts text, chunks it, creates vectors with the configured local embedding model, and adds the chunks to the configured Qdrant collection. Uploaded source files are saved under `ADMIN_DATA_DIR/uploads`; the collection records the source as `admin_uploads/<filename>`. Uploading a file again with the same normalized filename updates its indexed chunks.

### Add supplemental system instructions

Use the **System instructions** editor to replace the general-guidance prompt. The updated text is written to `backend/rag/system-instructions.js` and takes effect immediately; keep a backup before editing. It applies to general guidance responses. Case-specific decisions use the separate rules-narrative instructions documented below.

Do not use this editor to change the deterministic rules or the case-specific narrative requirements. Keep instructions operational and concise; do not put secrets or patient information in this field.

## How the agent determines its output

The API classifies each current message as a case-specific decision, a patient-fact update, a general guidance question, or a combined fact-update-and-question turn. Existing case state or conversation history alone does not force a rules-engine evaluation; the latest user message determines the task.

### General guidance question

1. The backend embeds the question with the configured local sentence-transformer model and retrieves relevant passages from Qdrant.
2. The answer model uses those retrieved passages and the shared public-health instructions to compose an educational answer with source citations. It may request one focused follow-up retrieval if the initial passages leave an important gap.
3. If no relevant passages are found, the API returns a no-evidence response rather than inventing guidance. General RAG does not decide whether an individual patient's restrictions should start, continue, change, or end. A general question remains conversational even when a case is active or a clarification is pending, unless the user is answering that clarification or asking for an individual decision.

### Case-specific isolation question

1. **Extract and retain case facts.** For the first decision turn, the model maps user-provided narrative and form entries to canonical fields from `tb_isolation_rules_package/input_schema.json`. The backend maintains a versioned case object. Later clarifications update only the engine-asked fields from the current user message; the earlier narrative is not re-extracted and cannot silently overwrite a correction.
2. **Validate and run the rules.** A small Python adapter validates the case using the updated package and invokes the unchanged deterministic rule logic. Its result includes the restriction level, total planning target, conditional remaining days, assumptions, clarification questions, explanation, blockers, and any expert-consultation flag.
3. **Clarify when needed.** When `decision_status` is `needs_input`, the response keeps the restriction level and duration unresolved and asks the engine's required questions. Optional confirmations are grouped separately. No missing value is converted to an extensive restriction by the chatbot.
4. **Generate the narrative.** One LLM call receives the canonical case, the user's question, and the exact rules-engine result. It must preserve the engine's level and duration, distinguish total target from remaining days, disclose assumptions versus reported facts, explain the five decision dimensions, and describe blockers or expert review without inventing a release date. The response uses `Recommendation`, `Why this recommendation`, `Assumptions and uncertainty`, and `Reassessment`.
5. **Keep evidence attribution honest.** This rules-only decision path does not retrieve guideline excerpts, so the narrative attributes duration choices and defaults to the supplied rules-engine policy and says exact guideline attribution has not been verified. General TB questions continue to use Qdrant RAG as described above.

### Patient-fact updates and combined turns

- A case-fact update is interpreted as a patch from the current message and applied to the canonical case; previous conversation text is not re-extracted as new patient evidence. The updated case is validated and the deterministic engine is rerun.
- If a message both adds/corrects a patient fact and asks a general information question, the backend updates the case and runs the engine first, then answers through the conversational RAG path with the new case and exact engine output included as context. The answer addresses the user's question while preserving the engine's restriction level, conditions, and clearance status.
- Clarification prompts are field-scoped. An unrelated question during a pending clarification follows the general guidance path; a reply to the requested field updates the canonical case and triggers reevaluation.

The ruleset is a decision-support tool, not ground truth or an independently validated clinical policy. The rule engine remains the source of the case-specific restriction determination in this current rules-only workflow. The LLM explains that output; it does not recalculate it. Neither should be treated as a substitute for qualified clinical judgment.

## Operational notes

- The frontend retains the canonical case state returned in the `X-TB-Case-State` response header and sends it on subsequent turns. The API continues to stream the user-facing response as plain text.
- Patient context is sent for the active request and is not indexed in Qdrant.
- In development, `[tb-rag]` console traces show task classification, case extraction/updates, validation, rule output, narrative generation, and final response assembly. These may include sensitive health details: use synthetic cases and protect terminal output. Detailed traces are suppressed for `NODE_ENV=production` and `NODE_ENV=test`.
- For Qdrant connection, model, or dimension errors, check `.env`, verify that Qdrant is reachable, and confirm that ingestion and runtime use the same collection and embedding configuration.

## Tests

Run the backend/API and Python rule-engine tests, and build the frontend:

```powershell
npm test
npm run build
```

To run only the Python rule-engine tests:

```powershell
python -m unittest discover -s tb_isolation_rules_package -p test_tb_isolation_rules.py
```

Before any clinical use, domain experts must validate the rule policy, extraction behavior, retrieval quality, citation accuracy, and evidence-conflict handling. Review privacy, access control, and logging before sending real patient information to any model or hosted service.
