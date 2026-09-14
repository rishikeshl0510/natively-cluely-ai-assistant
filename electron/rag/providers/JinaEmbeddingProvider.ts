import { IEmbeddingProvider } from './IEmbeddingProvider';
import { embeddingSpaceKey } from '../embeddingSpace';

/**
 * Jina AI embeddings.
 *
 *   POST https://api.jina.ai/v1/embeddings
 *     {model, task?: 'retrieval.query'|'retrieval.passage'|'text-matching'|
 *      'classification'|'separation', dimensions?, input: string[]}
 *     -> {model, object:'list', usage:{...}, data:[{object:'embedding', index, embedding}]}
 *
 * NOT verified live against the API the way VoyageEmbeddingProvider's header
 * comment is (this file was written without network access to confirm the
 * exact current request/response shape) — modeled on Jina's publicly
 * documented embeddings endpoint and mirrored structurally on this codebase's
 * Voyage provider (closest existing analog: also a REST embeddings API with
 * an explicit query/document task parameter). Treat the shape here as a
 * best-effort starting point and confirm against a real call + response
 * before trusting it in production — the failure mode if the shape is wrong
 * is the same "silent, no error, just worse retrieval" class Voyage's own
 * header comment warns about for its `input_type` parameter, or in the worst
 * case an outright request failure that `post()` below will at least surface
 * as a thrown, loggable error rather than silently returning garbage.
 *
 * WHAT MAKES JINA DIFFERENT FROM VOYAGE: `task` instead of `input_type`, and
 * native Matryoshka dimension truncation via `dimensions` (Voyage calls the
 * equivalent `output_dimension` and only some models accept it — Jina v3/v4
 * models are documented as supporting arbitrary truncation more broadly, but
 * that breadth claim is also unverified here). Both land query and document
 * vectors in ONE shared space — the asymmetry is in how each is produced,
 * not where it lands.
 */

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_BASE_URL = 'https://api.jina.ai/v1';

/** Not confirmed against Jina's current documented cap — kept conservative and in line with Voyage's documented limit until verified. Lower this if a real call reports a smaller server-side cap. */
export const JINA_MAX_BATCH = 1000;

export interface JinaEmbeddingOptions {
  apiKey: string;
  model: string;
  /** Output width via Matryoshka truncation, e.g. 1024 | 768 | 512 | 256 | 128 | 64 for jina-embeddings-v3/v4. */
  dimensions: number;
  baseUrl?: string;
}

export class JinaEmbeddingProvider implements IEmbeddingProvider {
  readonly name = 'jina';
  readonly model: string;
  readonly dimensions: number;
  readonly space: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: JinaEmbeddingOptions) {
    this.apiKey = (opts.apiKey || '').trim();
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.space = embeddingSpaceKey({ name: this.name, model: this.model, dimensions: this.dimensions });
  }

  private async post(input: string[], task: 'retrieval.query' | 'retrieval.passage'): Promise<any> {
    if (!this.apiKey) {
      const err: any = new Error('No Jina API key configured');
      err.retryable = false;
      throw err;
    }
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          task,
          dimensions: this.dimensions,
          input,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e: any) {
      // Never interpolate the key or raw cause — these strings reach logs.
      const err: any = new Error(e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? 'Jina embedding request timed out'
        : 'Could not reach Jina');
      err.retryable = true;
      throw err;
    }

    if (!res.ok) {
      const err: any = new Error(`Jina embedding failed: ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.provider = this.name;
      err.permanentAuthFailure = res.status === 401 || res.status === 403;
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter != null) err.retryAfter = retryAfter;
      err.retryable = !err.permanentAuthFailure;
      throw err;
    }
    return res.json();
  }

  private validate(values: unknown): number[] {
    if (!Array.isArray(values) || values.length !== this.dimensions) {
      const err: any = new Error(
        `Jina embedding dimension mismatch: expected ${this.dimensions}, got `
        + `${Array.isArray(values) ? values.length : typeof values}. `
        + 'Re-select the model so its size is measured again.'
      );
      err.retryable = true;
      throw err;
    }
    return values as number[];
  }

  /** One request's worth, ordered by the response's own index. */
  private order(rows: any, expected: number): number[][] {
    if (!Array.isArray(rows) || rows.length !== expected) {
      const err: any = new Error(
        `Jina returned ${Array.isArray(rows) ? rows.length : typeof rows} vectors `
        + `for ${expected} inputs — refusing a partial batch.`
      );
      err.retryable = true;
      throw err;
    }
    const out = new Array<number[]>(expected);
    rows.forEach((row: any, i: number) => {
      const at = Number.isInteger(row?.index) ? row.index : i;
      if (at < 0 || at >= expected) {
        const err: any = new Error(`Jina returned an out-of-range index (${at})`);
        err.retryable = true;
        throw err;
      }
      out[at] = this.validate(row?.embedding);
    });
    for (let i = 0; i < expected; i++) {
      if (!out[i]) {
        const err: any = new Error(`Jina did not return a vector for input ${i}`);
        err.retryable = true;
        throw err;
      }
    }
    return out;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey || !this.model) return false;
    try {
      await this.embed('natively embedding availability probe');
      return true;
    } catch (error: any) {
      if (error?.permanentAuthFailure) throw error;
      return false;
    }
  }

  async embed(text: string): Promise<number[]> {
    const data = await this.post([text], 'retrieval.passage');
    return this.validate(data?.data?.[0]?.embedding);
  }

  /** A QUERY, not a document — task: 'retrieval.query' is what makes this asymmetric. */
  async embedQuery(text: string): Promise<number[]> {
    const data = await this.post([text], 'retrieval.query');
    return this.validate(data?.data?.[0]?.embedding);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) return [];

    // Split at the (unverified, conservative) cap. Each response restarts its
    // index at 0, so the slices are ordered INDEPENDENTLY and then
    // concatenated in caller order — merging them by a global index would
    // pair chunks with the wrong vectors, which surfaces as poor retrieval
    // rather than as an error. (Same reasoning as VoyageEmbeddingProvider.)
    const out: number[][] = [];
    for (let start = 0; start < texts.length; start += JINA_MAX_BATCH) {
      const slice = texts.slice(start, start + JINA_MAX_BATCH);
      const data = await this.post(slice, 'retrieval.passage');
      out.push(...this.order(data?.data, slice.length));
    }
    return out;
  }
}
