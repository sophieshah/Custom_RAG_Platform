"""Persistent local embedding worker compatible with backend/ingest.py."""

from __future__ import annotations

import json
import os
import sys

from sentence_transformers import SentenceTransformer


def main() -> int:
    model_name = os.getenv("EMBEDDING_MODEL", "intfloat/e5-large-v2")
    model = SentenceTransformer(model_name)
    dimension = model.get_sentence_embedding_dimension()
    if not dimension:
        raise RuntimeError(f"Embedding model {model_name!r} did not report its vector size.")

    print(json.dumps({"ready": True, "dimension": dimension}), flush=True)
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            texts = request.get("texts")
            if not isinstance(texts, list) or not all(isinstance(text, str) for text in texts):
                raise ValueError("texts must be an array of strings")
            if not texts:
                raise ValueError("texts must not be empty")

            vectors = model.encode(
                texts,
                normalize_embeddings=True,
                show_progress_bar=False,
            )
            print(json.dumps({
                "id": request_id,
                "vectors": vectors.tolist(),
            }), flush=True)
        except Exception as error:
            print(json.dumps({
                "id": request.get("id") if isinstance(request, dict) else None,
                "error": str(error),
            }), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Embedding worker failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
