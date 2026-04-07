import { VectorClient } from "@0-ai/s3lite/vectors";
import type { QueryResult, SparseVector } from "@0-ai/s3lite/vectors";
import { embedMany } from "ai";
import { getEmbeddingModel } from "@/lib/providers/index.ts";
import { getSetting } from "@/lib/settings.ts";
import { log } from "@/lib/logger.ts";
const vecLog = log.child({ module: "vectors" });

const DIMENSION = 1536;
const MAX_CHUNK_CHARS = 2000;
const CHUNK_OVERLAP = 400;

// Simple hash to map tokens to sparse vector dimensions deterministically.
// Uses a fixed vocabulary size to keep the sparse index compact.
const SPARSE_DIM_SIZE = 50_000;

function hashToken(token: string): number {
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = ((h << 5) - h + token.charCodeAt(i)) | 0;
  }
  return ((h % SPARSE_DIM_SIZE) + SPARSE_DIM_SIZE) % SPARSE_DIM_SIZE;
}

/** Tokenize text into lowercase terms, filtering short/stop words. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/** Build a BM25-like sparse vector from text using hashed term frequencies. */
export function textToSparseVector(text: string): SparseVector {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { indices: [], values: [] };

  // Term frequency map
  const tf = new Map<number, number>();
  for (const token of tokens) {
    const dim = hashToken(token);
    tf.set(dim, (tf.get(dim) ?? 0) + 1);
  }

  // Log-normalize TF values: 1 + log(tf)
  const indices: number[] = [];
  const values: number[] = [];
  for (const [dim, count] of tf) {
    indices.push(dim);
    values.push(1 + Math.log(count));
  }

  return { indices, values };
}

// Singleton vector client
let _client: VectorClient | null = null;

function getClient(): VectorClient {
  if (!_client) {
    _client = new VectorClient({
      path: process.env.VECTOR_DB_PATH ?? "./data/vectors.db",
    });
  }
  return _client;
}

export function closeVectorClient(): void {
  _client?.close();
  _client = null;
}

export function isEmbeddingConfigured(): boolean {
  // Embeddings are served by the active inference provider. We treat the
  // OpenRouter API key as the canonical signal for now since it is the only
  // provider that ships embedding support; future providers can extend this.
  return !!getSetting("OPENROUTER_API_KEY");
}

async function embedValues(values: string[]): Promise<number[][]> {
  const { embeddings } = await embedMany({
    model: getEmbeddingModel(),
    values,
    abortSignal: AbortSignal.timeout(30_000),
  });
  return embeddings;
}

export async function embedValue(value: string): Promise<number[]> {
  const [embedding] = await embedValues([value]);
  return embedding!;
}

/** Ensure a per-project HNSW index exists with sparse support for hybrid search. */
export function ensureIndex(projectId: string): void {
  const client = getClient();
  const name = `project:${projectId}`;
  const existing = client.getIndex(name);
  if (!existing) {
    client.createIndex({
      name,
      dimension: DIMENSION,
      distanceMetric: "cosine",
      sparse: true,
    });
    vecLog.info("created vector index", { projectId });
  } else if (!existing.sparse) {
    // Recreate index with sparse support if it was created without it
    client.deleteIndex(name);
    client.createIndex({
      name,
      dimension: DIMENSION,
      distanceMetric: "cosine",
      sparse: true,
    });
    vecLog.info("recreated vector index with sparse support", { projectId });
  }
}

/** Split text into overlapping chunks on paragraph/sentence boundaries. */
export function chunkText(
  text: string,
  maxChars = MAX_CHUNK_CHARS,
  overlap = CHUNK_OVERLAP,
): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    // Try to break at paragraph, then sentence, then hard cut
    if (end < text.length) {
      const slice = text.slice(start, end);
      const parBreak = slice.lastIndexOf("\n\n");
      if (parBreak > maxChars * 0.3) {
        end = start + parBreak + 2;
      } else {
        const sentBreak = slice.lastIndexOf(". ");
        if (sentBreak > maxChars * 0.3) {
          end = start + sentBreak + 2;
        }
      }
    }

    chunks.push(text.slice(start, end));
    start = end - overlap;
    if (start >= text.length) break;
  }

  return chunks;
}

/**
 * Chunk text, embed, and store vectors for a source.
 * Replaces any existing vectors for the same sourceId.
 */
export async function embedAndStore(
  projectId: string,
  collection: string,
  sourceId: string,
  text: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (!isEmbeddingConfigured() || !text.trim()) return;

  const chunks = chunkText(text);
  vecLog.debug("embedding", { collection, sourceId, chunks: chunks.length });

  const embeddings = await embedValues(chunks);

  const client = getClient();
  const indexName = `project:${projectId}`;
  ensureIndex(projectId);

  // Delete old vectors for this source
  deleteVectorsBySource(projectId, collection, sourceId);

  // Insert new vectors with both dense and sparse components
  client.putVectors(
    indexName,
    embeddings.map((vector, i) => ({
      key: `${collection}:${sourceId}:${i}`,
      vector,
      sparseVector: textToSparseVector(chunks[i]!),
      metadata: {
        collection,
        sourceId,
        chunkIndex: i,
        content: chunks[i],
        ...metadata,
      },
    })),
  );

  vecLog.debug("embedded", { collection, sourceId, vectors: embeddings.length });
}

/**
 * Embed individual entries (one embedding per entry).
 * Used for memory bullets and short messages.
 */
const EMBED_BATCH_SIZE = 100;

export async function embedEntries(
  projectId: string,
  collection: string,
  entries: { id: string; text: string }[],
  metadata?: Record<string, unknown>,
): Promise<void> {
  if (!isEmbeddingConfigured() || entries.length === 0) return;

  vecLog.debug("embedding entries", { collection, count: entries.length });

  const client = getClient();
  const indexName = `project:${projectId}`;
  ensureIndex(projectId);

  // Delete old vectors for this collection+source pattern
  const sourceIds = new Set(entries.map((e) => e.id.split(":")[0] ?? e.id));
  for (const sid of sourceIds) {
    deleteVectorsBySource(projectId, collection, sid);
  }

  // Process in batches to avoid oversized API calls
  for (let i = 0; i < entries.length; i += EMBED_BATCH_SIZE) {
    const batch = entries.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map((e) => e.text);

    const embeddings = await embedValues(texts);

    client.putVectors(
      indexName,
      embeddings.map((vector, j) => ({
        key: `${collection}:${batch[j]!.id}`,
        vector,
        sparseVector: textToSparseVector(batch[j]!.text),
        metadata: {
          collection,
          sourceId: batch[j]!.id,
          content: batch[j]!.text,
          ...metadata,
        },
      })),
    );
  }

  vecLog.debug("embedded entries", { collection, vectors: entries.length });
}

export interface SemanticResult {
  key: string;
  content: string;
  metadata: Record<string, unknown>;
  score: number;
}

/**
 * Hybrid search within a project and collection.
 * Uses both dense (semantic) and sparse (keyword) vectors with RRF fusion.
 */
export async function semanticSearch(
  projectId: string,
  collection: string,
  query: string,
  topK = 10,
  precomputedEmbedding?: number[],
): Promise<SemanticResult[]> {
  if (!isEmbeddingConfigured() || !query.trim()) return [];

  const client = getClient();
  const indexName = `project:${projectId}`;
  const indexConfig = client.getIndex(indexName);
  if (!indexConfig) return [];

  const embedding = precomputedEmbedding ?? await embedValue(query);

  const sparseQuery = textToSparseVector(query);
  const useSparse = indexConfig.sparse && sparseQuery.indices.length > 0;

  const { results } = client.query(indexName, {
    vector: embedding,
    ...(useSparse ? { sparseVector: sparseQuery } : {}),
    topK,
    filter: { collection: { $eq: collection } },
    includeMetadata: true,
  });

  return results.map((r: QueryResult) => ({
    key: r.key,
    content: (r.metadata?.content as string) ?? "",
    metadata: r.metadata ?? {},
    score: r.score,
  }));
}

/**
 * Fast keyword-only search using sparse vectors. No embedding API call needed.
 */
export function keywordSearch(
  projectId: string,
  collection: string,
  query: string,
  topK = 10,
): SemanticResult[] {
  if (!query.trim()) return [];

  const client = getClient();
  const indexName = `project:${projectId}`;
  const indexConfig = client.getIndex(indexName);
  if (!indexConfig) return [];

  const sparseQuery = textToSparseVector(query);
  if (sparseQuery.indices.length === 0) return [];

  const { results } = client.query(indexName, {
    sparseVector: sparseQuery,
    topK,
    filter: { collection: { $eq: collection } },
    includeMetadata: true,
  });

  return results.map((r: QueryResult) => ({
    key: r.key,
    content: (r.metadata?.content as string) ?? "",
    metadata: r.metadata ?? {},
    score: r.score,
  }));
}

/** Delete all vectors for a specific source within a collection. */
export function deleteVectorsBySource(
  projectId: string,
  collection: string,
  sourceId: string,
): void {
  const client = getClient();
  const indexName = `project:${projectId}`;
  if (!client.getIndex(indexName)) return;

  const prefix = `${collection}:${sourceId}:`;
  const { keys } = client.listVectors(indexName, { prefix, maxKeys: 10000 });
  if (keys.length > 0) {
    client.deleteVectors(indexName, keys);
    vecLog.debug("deleted vectors", { projectId, collection, sourceId, count: keys.length });
  }
}

/** Delete the entire project index. */
export function deleteProjectIndex(projectId: string): void {
  const client = getClient();
  const indexName = `project:${projectId}`;
  if (client.getIndex(indexName)) {
    client.deleteIndex(indexName);
    vecLog.info("deleted project index", { projectId });
  }
}

/** Append pre-computed vectors to a project's index (index must already exist). */
export function putProjectVectors(
  projectId: string,
  vectors: { key: string; vector: number[]; sparseVector: SparseVector; metadata: Record<string, unknown> }[],
): void {
  if (vectors.length === 0) return;
  const client = getClient();
  const indexName = `project:${projectId}`;
  client.putVectors(indexName, vectors);
}
