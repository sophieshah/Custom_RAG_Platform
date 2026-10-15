"""Persistent local embedding worker compatible with backend/ingest.py."""

from __future__ import annotations

import json
import os
import sys

from sentence_transformers import SentenceTransformer


def sanitize_text(text: str) -> str:
    # Replace unpaired Unicode surrogates and remove replacement characters.
    text = text.encode("utf-8", errors="replace").decode("utf-8")
    return text.replace("\uFFFD", " ").strip()



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
            texts = [sanitize_text(text) for text in texts]
            print(
                f"Request ID: {request.get('id')}, "
                f"texts type: {type(texts).__name__}, "
                f"count: {len(texts) if isinstance(texts, list) else 'N/A'}, "
                f"first item type: "
                f"{type(texts[0]).__name__ if isinstance(texts, list) and texts else 'N/A'}",
                file=sys.stderr,
                flush=True,
            )
            if not isinstance(texts, list) or not all(isinstance(text, str) for text in texts):
                raise ValueError("texts must be an array of strings")
            if not texts:
                raise ValueError("texts must not be empty")

            
            try:
                vectors = model.encode(
                    sentences=texts,
                    normalize_embeddings=True,
                    show_progress_bar=False,
                    convert_to_numpy=True,
                )
            except Exception as batch_error:
                print(
                    f"Batch encoding failed: {batch_error}",
                    file=sys.stderr,
                    flush=True,
                )

                for i, text in enumerate(texts):
                    try:
                        model.encode(
                            sentences=[text],
                            normalize_embeddings=True,
                            show_progress_bar=False,
                        )
                    except Exception as item_error:
                        print(
                            f"Failed item {i}: "
                            f"type={type(text).__name__}, "
                            f"repr={text[:300]!r}, "
                            f"error={item_error}",
                            file=sys.stderr,
                            flush=True,
                        )

                raise batch_error

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
    # print(f"Python executable: {sys.executable}", file=sys.stderr, flush=True)
    # print(f"Python version: {sys.version}", file=sys.stderr, flush=True)
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Embedding worker failed: {error}", file=sys.stderr, flush=True)
        raise SystemExit(1)
