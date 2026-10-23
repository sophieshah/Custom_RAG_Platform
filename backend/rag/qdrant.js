const DEFAULT_LIMIT = 8;

export class QdrantClient {
  constructor({
    url = process.env.QDRANT_URL || "http://127.0.0.1:6333",
    apiKey = process.env.QDRANT_API_KEY,
    collection = process.env.QDRANT_COLLECTION || "tb_guidance",
    dimensions = Number(process.env.EMBEDDING_DIMENSION || 1024),
    fetchImpl = fetch,
  } = {}) {
    this.baseUrl = url.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.collection = collection;
    this.dimensions = dimensions;
    this.fetchImpl = fetchImpl;
  }

  async request(path, options = {}) {
    const headers = { "Content-Type": "application/json", ...options.headers };
    if (this.apiKey) headers["api-key"] = this.apiKey;

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Qdrant request failed (${response.status}): ${detail}`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  
  async ensureKeywordPayloadIndex(fieldName) {
    const collectionPath =
      `/collections/${encodeURIComponent(this.collection)}`;

    const response = await this.fetchImpl(
      `${this.baseUrl}${collectionPath}`,
      {
        headers: this.apiKey
          ? { "api-key": this.apiKey }
          : {},
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `Unable to inspect Qdrant collection (${response.status}): ${detail}`,
      );
    }

    const collection = await response.json();
    const existingIndex =
      collection.result?.payload_schema?.[fieldName];

    if (existingIndex?.data_type === "keyword") {
      return;
    }

    if (existingIndex) {
      throw new Error(
        `Qdrant field "${fieldName}" already has an index of type ` +
        `"${existingIndex.data_type}", expected "keyword".`,
      );
    }

    await this.request(
      `${collectionPath}/index?wait=true`,
      {
        method: "PUT",
        body: JSON.stringify({
          field_name: fieldName,
          field_schema: "keyword",
        }),
      },
    );
  }


  async ensureCollection() {
    const path = `/collections/${encodeURIComponent(this.collection)}`;
    const existing = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: this.apiKey ? { "api-key": this.apiKey } : {},
    });

    if (existing.status === 404) {
      await this.request(path, {
        method: "PUT",
        body: JSON.stringify({
          vectors: { size: this.dimensions, distance: "Cosine" },
        }),
      });

      await this.ensureKeywordPayloadIndex("source_file");
      return;
    }

    if (!existing.ok) {
      const detail = await existing.text();
      throw new Error(`Unable to inspect Qdrant collection (${existing.status}): ${detail}`);
    }

    const collection = await existing.json();
    const vectors = collection.result?.config?.params?.vectors;

    // Qdrant represents the default/unnamed vector as { "": {...} }
    const vectorConfig =
      vectors?.size !== undefined
        ? vectors
        : vectors?.[""];

    if (vectorConfig?.size !== this.dimensions) {
      throw new Error(
        `Qdrant collection "${this.collection}" has vector size ${vectorConfig?.size}; expected ${this.dimensions}.`,
      );
    }

    await this.ensureKeywordPayloadIndex("source_file");
  }

  async upsert(points) {
    if (points.length === 0) return;
    await this.request(
      `/collections/${encodeURIComponent(this.collection)}/points?wait=true`,
      { method: "PUT", body: JSON.stringify({ points }) },
    );
  }

  async search(vector, limit = DEFAULT_LIMIT) {
    const response = await this.request(
      `/collections/${encodeURIComponent(this.collection)}/points/search`,
      {
        method: "POST",
        body: JSON.stringify({
          vector,
          limit,
          with_payload: true,
        }),
      },
    );
    return response.result || [];
  }

  async scrollBySource(sourceFile, offset = null) {
    const response = await this.request(
      `/collections/${encodeURIComponent(this.collection)}/points/scroll`,
      {
        method: "POST",
        body: JSON.stringify({
          filter: {
            must: [{ key: "source_file", match: { value: sourceFile } }],
          },
          limit: 256,
          offset,
          with_payload: false,
          with_vector: false,
        }),
      },
    );
    return response.result;
  }

  async listDocuments() {
    const documents = new Map();
    let offset = null;
    do {
      const response = await this.request(
        `/collections/${encodeURIComponent(this.collection)}/points/scroll`,
        {
          method: "POST",
          body: JSON.stringify({
            limit: 256,
            offset,
            with_payload: ["source_file", "document_name", "document_id", "title"],
            with_vector: false,
          }),
        },
      );
      const result = response.result || {};
      for (const point of result.points || []) {
        const payload = point.payload || {};
        const sourceKey = payload.source_file
          ? "source_file"
          : payload.document_id
            ? "document_id"
            : payload.document_name
              ? "document_name"
              : null;
        const sourceFile = sourceKey ? payload[sourceKey] : null;
        if (typeof sourceFile !== "string" || !sourceFile.trim()) continue;
        const documentName = typeof payload.document_name === "string"
          ? payload.document_name
          : sourceFile;
        const current = documents.get(sourceFile) || {
          sourceFile,
          sourceKey,
          title: typeof payload.title === "string" && payload.title.trim()
            ? payload.title.trim()
            : documentName.split(/[\\/]/).at(-1),
          pointCount: 0,
        };
        current.pointCount += 1;
        documents.set(sourceFile, current);
      }
      offset = result.next_page_offset ?? null;
    } while (offset !== null);

    return [...documents.values()].sort((first, second) => (
      first.sourceFile.localeCompare(second.sourceFile)
    ));
  }

  async deleteBySource(sourceFile, sourceKey = "source_file") {
    if (!["source_file", "document_id", "document_name"].includes(sourceKey)) {
      throw new Error("Unsupported Qdrant document source field.");
    }
    await this.request(
      `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
      {
        method: "POST",
        body: JSON.stringify({
          filter: {
            must: [{ key: sourceKey, match: { value: sourceFile } }],
          },
        }),
      },
    );
  }

  async deletePoints(ids) {
    if (ids.length === 0) return;
    await this.request(
      `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
      { method: "POST", body: JSON.stringify({ points: ids }) },
    );
  }
}
