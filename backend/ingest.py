import os
import sys
import json
import re
import hashlib
import uuid
from pathlib import Path
from typing import List, Dict, Any, Optional

import fitz  # PyMuPDF
import pdfplumber
import pytesseract
from PIL import Image

import spacy
import tiktoken

from openai import OpenAI

from sentence_transformers import SentenceTransformer

from qdrant_client import QdrantClient
from qdrant_client.models import (
    VectorParams,
    Distance,
    PointStruct,
    Filter,
    FieldCondition,
    MatchValue,
)

from dotenv import load_dotenv


# ============================================================
# CONFIGURATION
# ============================================================

load_dotenv()

QDRANT_URL = os.getenv(
    "QDRANT_URL",
    "http://localhost:6333"
)

QDRANT_API_KEY = os.getenv("QDRANT_API_KEY")

COLLECTION_NAME = os.getenv(
    "QDRANT_COLLECTION",
    "documents"
)

EMBEDDING_MODEL_NAME = os.getenv(
    "EMBEDDING_MODEL",
    "intfloat/e5-large-v2"
)

OPENAI_MODEL = os.getenv(
    "OPENAI_VISION_MODEL",
    "gpt-5"
)

ENABLE_VISION = (
    os.getenv("ENABLE_VISION", "true").lower() == "true"
)

CHUNK_SIZE = 450
CHUNK_OVERLAP = 75

PARENT_CHUNK_SIZE = 1000
PARENT_CHUNK_OVERLAP = 100

IMAGE_DPI = 180

EMBEDDING_DIMENSION = 1024

BATCH_SIZE = 32

pytesseract.pytesseract.tesseract_cmd = (
    r"C:\Program Files\Tesseract-OCR\tesseract.exe"
)


# ============================================================
# MODELS / CLIENTS
# ============================================================

print("Loading NLP models...", file=sys.stderr)

nlp = spacy.load("en_core_web_sm")

tokenizer = tiktoken.get_encoding("cl100k_base")

embedding_model = SentenceTransformer(
    EMBEDDING_MODEL_NAME
)

qdrant = QdrantClient(
    url=QDRANT_URL,
    api_key=QDRANT_API_KEY,
    check_compatibility=False
)

openai_client = None

if ENABLE_VISION:
    openai_client = OpenAI(
        api_key=os.getenv("OPENAI_API_KEY")
    )


# ============================================================
# QDRANT
# ============================================================

def ensure_collection():

    collections = qdrant.get_collections()

    exists = any(
        collection.name == COLLECTION_NAME
        for collection in collections.collections
    )

    if not exists:

        qdrant.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=VectorParams(
                size=EMBEDDING_DIMENSION,
                distance=Distance.COSINE
            )
        )

        print(
            f"Created Qdrant collection: {COLLECTION_NAME}",
            file=sys.stderr
        )
    # Create payload index for document_id
    try:
        qdrant.create_payload_index(
            collection_name=COLLECTION_NAME,
            field_name="document_id",
            field_schema="keyword",
        )

        print(
            "Ensured Qdrant index for document_id",
            file=sys.stderr
        )

    except Exception as error:

        print(
            f"Could not create document_id index: {error}",
            file=sys.stderr
        )


# ============================================================
# TEXT UTILITIES
# ============================================================

def normalize_text(text: str) -> str:

    if not text:
        return ""

    text = text.replace("\x00", " ")

    text = re.sub(
        r"[ \t]+",
        " ",
        text
    )

    text = re.sub(
        r"\n{3,}",
        "\n\n",
        text
    )

    return text.strip()


def token_count(text: str) -> int:

    return len(
        tokenizer.encode(text)
    )


def generate_uuid(value: str) -> str:

    return str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            value
        )
    )


def document_id_from_path(path: Path) -> str:

    raw = str(path.resolve())

    return hashlib.sha256(
        raw.encode("utf-8")
    ).hexdigest()[:16]


# ============================================================
# SECTION DETECTION
# ============================================================

def looks_like_heading(text: str) -> bool:

    text = text.strip()

    if not text:
        return False

    if len(text) > 180:
        return False

    patterns = [
        r"^\d+(\.\d+)*\s+.+",
        r"^[A-Z][A-Z\s\-:]{5,}$",
        r"^(Introduction|Background|Methods|Results|Discussion|"
        r"Conclusion|Recommendations|References)$",
        r"^(Table|Figure)\s+\d+",
    ]

    return any(
        re.match(pattern, text)
        for pattern in patterns
    )


def detect_sections(page_text: str):

    lines = page_text.splitlines()

    current_section = "Unknown"

    sections = []

    for line in lines:

        line = normalize_text(line)

        if not line:
            continue

        if looks_like_heading(line):

            current_section = line

        sections.append(
            (
                line,
                current_section
            )
        )

    return sections


# ============================================================
# SENTENCE CHUNKING
# ============================================================

def split_sentences(text: str):

    doc = nlp(text)

    return [
        sentence.text.strip()
        for sentence in doc.sents
        if sentence.text.strip()
    ]


def chunk_text(
    text: str,
    max_tokens: int = CHUNK_SIZE,
    overlap_tokens: int = CHUNK_OVERLAP,
):

    sentences = split_sentences(text)

    chunks = []

    current = []
    current_tokens = 0

    for sentence in sentences:

        sentence_tokens = token_count(sentence)

        if (
            current
            and
            current_tokens + sentence_tokens > max_tokens
        ):

            chunks.append(
                " ".join(current)
            )

            overlap = []

            overlap_count = 0

            for previous in reversed(current):

                previous_tokens = token_count(
                    previous
                )

                if (
                    overlap_count + previous_tokens
                    > overlap_tokens
                ):
                    break

                overlap.insert(
                    0,
                    previous
                )

                overlap_count += previous_tokens

            current = overlap

            current_tokens = overlap_count

        current.append(sentence)

        current_tokens += sentence_tokens

    if current:

        chunks.append(
            " ".join(current)
        )

    return chunks


# ============================================================
# PARENT / CHILD CHUNKING
# ============================================================

def create_parent_child_chunks(
    text: str,
    document_id: str,
    page_number: int,
    section: str,
):

    parent_chunks = chunk_text(
        text,
        max_tokens=PARENT_CHUNK_SIZE,
        overlap_tokens=PARENT_CHUNK_OVERLAP
    )

    results = []

    for parent_index, parent_text in enumerate(
        parent_chunks
    ):

        parent_id = generate_uuid(
            f"{document_id}:parent:{page_number}:{parent_index}"
        )

        children = chunk_text(
            parent_text,
            max_tokens=CHUNK_SIZE,
            overlap_tokens=CHUNK_OVERLAP
        )

        parent = {
            "id": parent_id,
            "type": "parent",
            "document_id": document_id,
            "page": page_number,
            "section": section,
            "parent_id": None,
            "parent_index": parent_index,
            "content": parent_text,
        }

        results.append(parent)

        for child_index, child_text in enumerate(
            children
        ):

            child_id = generate_uuid(
                f"{parent_id}:child:{child_index}"
            )

            results.append({
                "id": child_id,
                "type": "child",
                "document_id": document_id,
                "page": page_number,
                "section": section,
                "parent_id": parent_id,
                "parent_index": parent_index,
                "child_index": child_index,
                "content": child_text,
            })

    return results


# ============================================================
# TABLE EXTRACTION
# ============================================================

def clean_table(table):

    cleaned = []

    for row in table:

        if not row:
            continue

        row = [
            normalize_text(cell or "")
            for cell in row
        ]

        # Skip completely empty rows
        if not any(row):
            continue

        cleaned.append(row)

    return cleaned


def table_to_markdown(table):

    table = clean_table(table)

    if not table:
        return ""

    width = max(
        len(row)
        for row in table
    )

    normalized = []

    for row in table:

        row = row + [""] * (
            width - len(row)
        )

        normalized.append(row)

    header = normalized[0]

    markdown = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join(
            ["---"] * width
        ) + " |"
    ]

    for row in normalized[1:]:

        markdown.append(
            "| "
            + " | ".join(row)
            + " |"
        )

    return "\n".join(markdown)


def table_is_valid(table_text: str) -> bool:

    if not table_text:
        return False

    lines = table_text.splitlines()

    # A valid table should have multiple rows
    if len(lines) < 3:
        return False

    # It should contain table separators
    if "|" not in table_text:
        return False

    # Reject extremely sparse extraction
    if len(table_text.strip()) < 80:
        return False

    return True


# ============================================================
# TABLE FALLBACK
# ============================================================

def render_page_for_table(
    pdf_page,
    dpi=IMAGE_DPI
):

    matrix = fitz.Matrix(
        dpi / 72,
        dpi / 72
    )

    pixmap = pdf_page.get_pixmap(
        matrix=matrix,
        alpha=False
    )

    return Image.frombytes(
        "RGB",
        [
            pixmap.width,
            pixmap.height
        ],
        pixmap.samples
    )


def extract_table_with_ocr(
    pdf_page,
    page_number: int,
):

    image = render_page_for_table(
        pdf_page
    )

    text = pytesseract.image_to_string(
        image
    )

    text = normalize_text(text)

    if not text:
        return None

    return {
        "table_text": text,
        "extraction_method": "ocr",
        "page": page_number,
    }


def extract_tables(
    pdf_path: Path,
    pdf_document,
):

    tables = []

    with pdfplumber.open(
        pdf_path
    ) as plumber_pdf:

        for page_index, plumber_page in enumerate(
            plumber_pdf.pages
        ):

            page_number = page_index + 1

            extracted = plumber_page.extract_tables()

            valid_tables = []

            for table_index, table in enumerate(
                extracted or []
            ):

                markdown = table_to_markdown(
                    table
                )

                if table_is_valid(markdown):

                    valid_tables.append({
                        "table_index": table_index,
                        "content": markdown,
                        "method": "pdfplumber",
                        "page": page_number,
                    })

            if valid_tables:

                tables.extend(
                    valid_tables
                )

            else:

                # ------------------------------------------------
                # FALLBACK
                # ------------------------------------------------

                fallback = extract_table_with_ocr(
                    pdf_document[page_index],
                    page_number
                )

                if fallback:

                    tables.append({
                        "table_index": 0,
                        "content": fallback["table_text"],
                        "method": "ocr",
                        "page": page_number,
                    })

    return tables


# ============================================================
# FIGURE / IMAGE DETECTION
# ============================================================

def find_figure_blocks(page):

    blocks = page.get_text(
        "blocks"
    )

    figures = []

    for block in blocks:

        if len(block) < 5:
            continue

        x0, y0, x1, y1, text = block[:5]

        text = normalize_text(text)

        if re.match(
            r"^(Figure|Fig\.?)\s+\d+",
            text,
            re.IGNORECASE
        ):

            figures.append({
                "bbox": (
                    x0,
                    y0,
                    x1,
                    y1
                ),
                "caption": text
            })

    return figures


def render_figure_crop(
    page,
    bbox,
    padding=100,
):

    x0, y0, x1, y1 = bbox

    rect = fitz.Rect(
        max(0, x0 - padding),
        max(0, y0 - padding),
        min(page.rect.width, x1 + padding),
        min(page.rect.height, y1 + padding)
    )

    matrix = fitz.Matrix(
        IMAGE_DPI / 72,
        IMAGE_DPI / 72
    )

    pixmap = page.get_pixmap(
        matrix=matrix,
        clip=rect,
        alpha=False
    )

    return Image.frombytes(
        "RGB",
        [
            pixmap.width,
            pixmap.height
        ],
        pixmap.samples
    )


# ============================================================
# IMAGE → LLM DESCRIPTION
# ============================================================

def image_to_base64(image: Image.Image):

    import base64
    import io

    buffer = io.BytesIO()

    image.save(
        buffer,
        format="PNG"
    )

    return base64.b64encode(
        buffer.getvalue()
    ).decode("utf-8")


def describe_figure(
    image: Image.Image,
    caption: str,
):

    if not openai_client:
        return None

    image_base64 = image_to_base64(
        image
    )

    prompt = f"""
You are creating a detailed textual representation of a
figure from a technical research document for a RAG system.

Figure caption:
{caption}

Describe this figure in detail so that a text-based retrieval
system can answer questions about information contained in the
figure even though the original image will not be stored.

Include:

1. What the figure represents
2. The purpose of the figure
3. All major visual elements
4. Labels and terminology visible in the figure
5. Relationships between elements
6. Directional relationships, arrows, flows, or hierarchies
7. Categories, groups, axes, scales, or levels
8. Important numbers or values
9. Trends or comparisons
10. Any decision logic represented
11. How the different components relate to one another
12. Any important information that would be easy to miss

Do not speculate about information that is not visible.

Write a detailed, factual description suitable for embedding
in a retrieval-augmented generation system.
"""

    response = openai_client.responses.create(
        model=OPENAI_MODEL,
        input=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": prompt,
                    },
                    {
                        "type": "input_image",
                        "image_url":
                            f"data:image/png;base64,{image_base64}",
                    },
                ],
            }
        ],
    )

    return response.output_text.strip()


# ============================================================
# PDF TEXT EXTRACTION
# ============================================================

def extract_page_text(
    page
):

    text = page.get_text(
        "text"
    )

    return normalize_text(
        text
    )


# ============================================================
# FIGURE EXTRACTION
# ============================================================

def extract_figures(
    pdf_document
):

    figures = []

    for page_index, page in enumerate(
        pdf_document
    ):

        page_number = page_index + 1

        figure_blocks = find_figure_blocks(
            page
        )

        for figure_index, figure in enumerate(
            figure_blocks
        ):

            try:

                image = render_figure_crop(
                    page,
                    figure["bbox"]
                )

                description = describe_figure(
                    image,
                    figure["caption"]
                )

                if description:

                    figures.append({
                        "page": page_number,
                        "figure_index": figure_index,
                        "caption": figure["caption"],
                        "description": description,
                    })

            except Exception as error:

                print(
                    f"Figure processing failed "
                    f"on page {page_number}: {error}",
                    file=sys.stderr
                )

    return figures


# ============================================================
# BUILD DOCUMENT CHUNKS
# ============================================================

def build_chunks(
    pdf_path: Path
):

    document_id = document_id_from_path(
        pdf_path
    )

    document_name = pdf_path.name

    pdf_document = fitz.open(
        pdf_path
    )

    chunks = []

    # --------------------------------------------------------
    # NORMAL TEXT
    # --------------------------------------------------------

    for page_index, page in enumerate(
        pdf_document
    ):

        page_number = page_index + 1

        page_text = extract_page_text(
            page
        )

        if not page_text:
            continue

        section = "Unknown"

        detected = detect_sections(
            page_text
        )

        if detected:

            # Use the final detected section
            section = detected[-1][1]

        parent_children = create_parent_child_chunks(
            page_text,
            document_id,
            page_number,
            section,
        )

        for chunk in parent_children:

            chunk.update({
                "document_name": document_name,
                "source_type": "pdf",
            })

            chunks.append(
                chunk
            )

    # --------------------------------------------------------
    # TABLES
    # --------------------------------------------------------

    tables = extract_tables(
        pdf_path,
        pdf_document
    )

    for table in tables:

        page = table["page"]

        table_content = table["content"]

        table_id = generate_uuid(
            f"{document_id}:table:{page}:{table['table_index']}"
        )

        chunks.append({
            "id": table_id,
            "type": "table",
            "document_id": document_id,
            "document_name": document_name,
            "page": page,
            "section": f"Table on page {page}",
            "parent_id": None,
            "table_index": table["table_index"],
            "extraction_method": table["method"],
            "source_type": "table",
            "content": table_content,
        })

    # --------------------------------------------------------
    # FIGURES
    # --------------------------------------------------------

    figures = extract_figures(
        pdf_document
    )

    for figure in figures:

        page = figure["page"]

        figure_index = figure["figure_index"]

        figure_id = generate_uuid(
            f"{document_id}:figure:{page}:{figure_index}"
        )

        content = (
            f"{figure['caption']}\n\n"
            f"Detailed figure description:\n"
            f"{figure['description']}"
        )

        chunks.append({
            "id": figure_id,
            "type": "figure",
            "document_id": document_id,
            "document_name": document_name,
            "page": page,
            "section": figure["caption"],
            "parent_id": None,
            "figure_index": figure_index,
            "source_type": "figure_description",
            "content": content,
        })

    pdf_document.close()

    return chunks


# ============================================================
# RETRIEVAL TEXT
# ============================================================

def create_retrieval_text(
    chunk: Dict[str, Any]
):

    parts = []

    if chunk.get("document_name"):
        parts.append(
            f"Document: {chunk['document_name']}"
        )

    if chunk.get("section"):
        parts.append(
            f"Section: {chunk['section']}"
        )

    if chunk.get("page"):
        parts.append(
            f"Page: {chunk['page']}"
        )

    if chunk.get("type"):
        parts.append(
            f"Content type: {chunk['type']}"
        )

    parts.append(
        chunk["content"]
    )

    return "\n".join(parts)


# ============================================================
# EMBEDDINGS
# ============================================================

def embed_chunks(
    chunks
):

    texts = [
        "passage: " +
        create_retrieval_text(chunk)
        for chunk in chunks
    ]

    embeddings = embedding_model.encode(
        texts,
        batch_size=BATCH_SIZE,
        normalize_embeddings=True,
        show_progress_bar=True,
    )

    for chunk, embedding in zip(
        chunks,
        embeddings
    ):

        chunk["embedding"] = embedding.tolist()

    return chunks


# ============================================================
# DELETE EXISTING DOCUMENT
# ============================================================

def delete_existing_document(
    document_id: str
):

    try:

        qdrant.delete(
            collection_name=COLLECTION_NAME,
            points_selector=Filter(
                must=[
                    FieldCondition(
                        key="document_id",
                        match=MatchValue(
                            value=document_id
                        )
                    )
                ]
            )
        )

    except Exception as error:

        print(
            f"Could not delete existing document: {error}",
            file=sys.stderr
        )


# ============================================================
# QDRANT UPLOAD
# ============================================================

def upload_to_qdrant(
    chunks
):

    points = []

    for chunk in chunks:

        payload = {
            key: value
            for key, value in chunk.items()
            if key != "embedding"
        }

        points.append(
            PointStruct(
                id=chunk["id"],
                vector=chunk["embedding"],
                payload=payload,
            )
        )

    for start in range(
        0,
        len(points),
        BATCH_SIZE
    ):

        batch = points[
            start:start + BATCH_SIZE
        ]

        qdrant.upsert(
            collection_name=COLLECTION_NAME,
            points=batch,
        )

        print(
            f"Uploaded {len(batch)} points",
            file=sys.stderr
        )


# ============================================================
# INGEST ONE DOCUMENT
# ============================================================

def ingest_document(
    pdf_path: Path
):

    print(
        f"Processing {pdf_path.name}",
        file=sys.stderr
    )

    document_id = document_id_from_path(
        pdf_path
    )

    delete_existing_document(
        document_id
    )

    chunks = build_chunks(
        pdf_path
    )

    print(
        f"Created {len(chunks)} chunks",
        file=sys.stderr
    )

    chunks = embed_chunks(
        chunks
    )

    upload_to_qdrant(
        chunks
    )

    return {
        "document_id": document_id,
        "document_name": pdf_path.name,
        "chunks": len(chunks),
    }


# ============================================================
# MAIN
# ============================================================

def main():

    if len(sys.argv) < 2:

        print(
            "Usage: python ingest.py <pdf_or_directory>",
            file=sys.stderr
        )

        sys.exit(1)

    input_path = Path(
        sys.argv[1]
    )

    ensure_collection()

    if input_path.is_file():

        documents = [
            input_path
        ]

    else:

        documents = sorted(
            input_path.glob("*.pdf")
        )

    if not documents:

        raise RuntimeError(
            "No PDF documents found."
        )

    results = []
    failures = []

    for pdf_path in documents:

        try:

            result = ingest_document(
                pdf_path
            )

            results.append(
                result
            )

        except Exception as error:

            print(
                f"FAILED: {pdf_path.name}: {error}",
                file=sys.stderr
            )

            failures.append({
                "document_name": pdf_path.name,
                "error": str(error),
            })

    print(
        json.dumps(
            {
                "success": len(failures) == 0,
                "documents": results,
                "failures": failures,
            }
        )
    )


if __name__ == "__main__":
    main()