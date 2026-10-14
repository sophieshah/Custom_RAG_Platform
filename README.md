# TB Isolation Chatbot

The project has a React/Vite frontend and an Express backend. The backend routes general TB questions through Qdrant retrieval-augmented generation (RAG). Case-specific community-isolation questions go through structured case extraction, Python schema validation, the deterministic Python rule engine, and a separate review of retrieved guidance. The existing frontend talks to `POST /api/chat`; responses remain streamed plain text.

> **Clinical safety:** the rules in `tb_isolation_rules_package/` are draft and not clinically validated. They produce reproducible tool outputs, not clinically certain recommendations. Do not use this application to make patient-care decisions without review and approval by qualified TB clinicians and public-health authorities. The rule engine does not grant healthcare or congregate-facility clearance.

## Requirements

- Windows, macOS, or Linux
- Node.js 20.16 or newer and npm
- Python 3.10 or newer
- Docker Desktop with Docker Compose, or an available Qdrant Cloud collection
- An OpenAI API key for task classification, extraction, and answer/evidence review
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

## How the agent determines its output

The API first classifies each message as either a general guidance request or a case-specific community-isolation decision.

### General guidance question

1. The backend embeds the question with the configured local sentence-transformer model and retrieves relevant passages from Qdrant.
2. The answer model uses those retrieved passages and the shared public-health instructions to compose an educational answer with source citations. It may request one focused follow-up retrieval if the initial passages leave an important gap.
3. If no relevant passages are found, the API returns a no-evidence response rather than inventing guidance. General RAG does not decide whether an individual patient's restrictions should start, continue, change, or end.

### Case-specific isolation question

1. **Extract and retain case facts.** For the first decision turn, the model maps only the user's narrative and form entries to the existing schema in `tb_isolation_rules_package/input_schema.json`. The backend maintains a canonical case object with a schema version, case version, confirmed unknowns, and conflicts. On later turns, a clarification updates only the fields asked about; the earlier narrative is not re-extracted and cannot silently overwrite a correction.
2. **Validate and clarify.** The Python rule package validates and normalizes the case. If required facts are missing or conflicting, the chatbot asks focused follow-up questions and waits for a user reply. Explicitly unknown facts remain unknown; they are not guessed.
3. **Run the deterministic rules.** Once the necessary fields are available, the Python rule engine evaluates the case and returns the deterministic classification, status, duration details, blockers, and rule identifiers. This output is kept distinct from the RAG evidence assessment.
4. **Retrieve and independently assess guidance.** Qdrant retrieves relevant passages. A separate evidence-review step classifies whether those passages `supports`, `contradicts`, or `insufficient_to_assess` the rule-engine result. It must assess the passages independently rather than assume the rule result is correct. If the evidence is insufficient or contradictory, the backend can do one focused follow-up search and then reassess the combined evidence.
5. **Assemble the response.** The answer is formatted into `Recommendation`, `Why this applies`, `What remains uncertain`, and `Guideline basis`, with only material case facts and citations to retrieved sources. If the evidence materially contradicts the rules, the system identifies the discrepancy and calls for clinical review; no validated conflict-resolution policy is configured, so it does not silently pick one source over the other. If evidence is insufficient, it says so.

The ruleset is a decision-support tool, not ground truth or an independently validated clinical policy. Retrieved passages support or challenge that output but do not alter the recorded rule-engine result. Neither should be treated as a substitute for qualified clinical judgment. The model must not invent guideline titles, versions, recommendations, or source approval status that are not present in retrieved passages.

## Operational notes

- The frontend retains the canonical case state returned in the `X-TB-Case-State` response header and sends it on subsequent turns. The API continues to stream the user-facing response as plain text.
- Patient context is sent for the active request and is not indexed in Qdrant.
- In development, `[tb-rag]` console traces show task classification, case extraction/updates, validation, rule output, retrieval, evidence assessment, and response assembly. These may include sensitive health details: use synthetic cases and protect terminal output. Detailed traces are suppressed for `NODE_ENV=production` and `NODE_ENV=test`.
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
