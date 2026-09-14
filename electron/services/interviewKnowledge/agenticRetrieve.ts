// electron/services/interviewKnowledge/agenticRetrieve.ts
//
// Bounded, deterministic "agentic" re-query loop for the free-tier Interview
// Knowledge feature (docs/specs/oss-knowledge-rag-spec.md). Deliberately NOT
// LLM-driven: an LLM call inside a retrieval loop costs 300ms-2s+ on its own,
// which alone blows the <500ms live-answer target. Every decision here is
// plain arithmetic over an existing, already-computed confidence signal
// (computeEvidenceCoverage) plus two existing, already-production-proven
// reformulation strategies (rewriteQueryForRetry, and a keyword-only fallback
// built from wordsOf) — no new NLP, no model call.
//
// Bound: ONE extra retrieval round on the live path. This mirrors, on
// purpose, the ONE-extra-rewritten-retry precedent already shipped in
// production (IntelligenceEngine.ts's T4 doc-grounded retry) — that code's
// own comment explains why more than one rewritten retry stops paying for
// itself, and this loop makes the same call rather than inventing a new
// tuning from nothing.

import { rewriteQueryForRetry } from '../../context-intelligence/retrieval/query-rewrite';
import { computeEvidenceCoverage, type EvidenceCoverage } from '../../llm/documentGroundedPrompt';
import { wordsOf } from '../modes/lexicalTokens';
import type { ModeHybridRetriever, ModeRetrievedChunk } from '../modes/ModeHybridRetriever';
import type { ModeReferenceFile } from '../ModesManager';
import { inferDocTypeAffinity, type KnowledgeDocType } from './docTypeAffinity';

/** Coverage is "weak enough to justify one more retrieval" below this answerability score, OR whenever computeEvidenceCoverage itself says shouldRefuse. */
const WEAK_COVERAGE_ANSWERABILITY_FLOOR = 0.35;

/** Below this much remaining budget, a second round-trip isn't worth starting even if one would otherwise fire — mirrors rerankBudgetFitsDeadline's reasoning for the same class of decision. */
const MIN_MS_TO_ATTEMPT_RETRY = 60;

export interface AgenticRetrieveParams {
    question: string;
    files: ModeReferenceFile[];
    retriever: ModeHybridRetriever;
    /** 2 on the live path (one extra retry); manual/typed chat may pass 3. Default 2. */
    maxRounds?: number;
    /** Caller's own deadline for the WHOLE call, ms. Absent = no deadline check (manual path). */
    deadlineMs?: number;
    tokenBudget?: number;
    topK?: number;
    /**
     * doc id -> docType (InterviewKnowledgeRetriever.getDocTypeMap()). When
     * provided AND the question shows a clear affinity (docTypeAffinity.ts) AND
     * at least one file matches, a FREE fast path runs first: search only the
     * matching files (fewer candidates -> a real accuracy/latency win when the
     * guess is right, not just a cosmetic reorder of an already-truncated
     * result), and return immediately if that's already confident. This never
     * consumes a maxRounds slot — if it doesn't resolve the question, the
     * normal full-corpus round 1/round 2 below runs exactly as if this path
     * didn't exist.
     */
    docTypeById?: Map<string, KnowledgeDocType>;
    /** Test-only injection points — production callers should never set these; both default to the real, imported implementations. */
    coverageFn?: typeof computeEvidenceCoverage;
    rewriteFn?: typeof rewriteQueryForRetry;
}

export interface AgenticRetrieveResult {
    formattedContext: string;
    chunks: ModeRetrievedChunk[];
    coverage: EvidenceCoverage | null;
    /** How many retrieval rounds actually ran (1 = no retry fired). 0 = the docType affinity fast path resolved it before the normal round-counted path ever ran. */
    rounds: number;
    /** Present only when round 2 ran, for diagnostics. */
    retryReason?: 'targeted_exact_lookup' | 'targeted_positional' | 'keyword_fallback';
    /** Set when the docType affinity fast path is what actually answered the question. */
    resolvedByDocTypeAffinity?: KnowledgeDocType[];
}

/** Plain string content of a chunk's evidence block, in the same shape computeEvidenceCoverage expects to score against. */
function chunksToRetrievedBlock(chunks: ModeRetrievedChunk[]): string {
    return chunks
        .map((c) => `[Source: ${c.fileName}]\n${c.text}`)
        .join('\n\n');
}

function dedupeChunks(a: ModeRetrievedChunk[], b: ModeRetrievedChunk[]): ModeRetrievedChunk[] {
    const seen = new Set<string>();
    const out: ModeRetrievedChunk[] = [];
    for (const c of [...a, ...b]) {
        const key = `${c.sourceId}:${c.chunkIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
    }
    return out;
}

/** wordsOf already strips punctuation/possessives and filters trivially short tokens — this just joins what's left into a lexical-only query, deliberately no LLM call so the retry stays cheap. */
function keywordOnlyQuery(question: string): string | null {
    const words = wordsOf(question);
    if (words.length === 0) return null;
    const joined = words.join(' ');
    return joined.trim() || null;
}

export async function retrieveWithAgenticLoop(params: AgenticRetrieveParams): Promise<AgenticRetrieveResult> {
    const {
        question, files, retriever, maxRounds = 2, deadlineMs, tokenBudget, topK,
        docTypeById,
        coverageFn = computeEvidenceCoverage,
        rewriteFn = rewriteQueryForRetry,
    } = params;
    const startedAt = Date.now();
    const remainingMs = (): number | null => (deadlineMs == null ? null : deadlineMs - (Date.now() - startedAt));
    const _measure = (() => { try { return process.env.MEASURE_LATENCY === 'true' || process.env.PI_LATENCY_TRACE === 'true'; } catch { return false; } })();
    const _stage = (label: string) => { if (_measure) console.log(`[agenticRetrieve] +${Date.now() - startedAt}ms  ${label}`); };

    if (files.length === 0) {
        return { formattedContext: '', chunks: [], coverage: null, rounds: 0 };
    }

    // FREE fast path (never counts toward maxRounds): if the question shows a
    // clear docType affinity and at least one attached file matches it, search
    // ONLY that narrower set first. Fewer candidate chunks for the same topK
    // is a genuine precision/latency win here — not a cosmetic reorder of an
    // already-truncated result, since it changes what the underlying
    // retriever's OWN ranking competes over. Falls through to the normal
    // full-corpus path below untouched if this doesn't resolve it, so a wrong
    // affinity guess costs nothing beyond one extra (smaller, cheaper) search.
    if (docTypeById && docTypeById.size > 0) {
        const affinity = inferDocTypeAffinity(question);
        if (affinity.size > 0) {
            const matching = files.filter((f) => {
                const dt = docTypeById.get(f.id);
                return dt ? affinity.has(dt) : false;
            });
            if (matching.length > 0 && matching.length < files.length) {
                _stage(`docType-affinity fast path START (files=${matching.length}/${files.length})`);
                const fastResult = await retriever.retrieve({
                    query: question,
                    modeId: '__interview_knowledge__',
                    files: matching,
                    tokenBudget,
                    topK,
                    allowRerank: false,
                });
                _stage(`docType-affinity fast path DONE (chunks=${fastResult.chunks.length})`);
                if (fastResult.chunks.length > 0) {
                    const fastCoverage = coverageFn({ question, retrievedBlock: chunksToRetrievedBlock(fastResult.chunks) });
                    if (!fastCoverage.shouldRefuse && fastCoverage.topAnswerability >= WEAK_COVERAGE_ANSWERABILITY_FLOOR) {
                        return {
                            formattedContext: chunksToRetrievedBlock(fastResult.chunks),
                            chunks: fastResult.chunks,
                            coverage: fastCoverage,
                            rounds: 0,
                            resolvedByDocTypeAffinity: Array.from(affinity),
                        };
                    }
                }
            }
        }
    }

    // Round 1: plain hybrid retrieve, no rerank (spec: round 1 stays cheap by
    // construction — reranking is a separate, opt-in cost this loop never pays).
    _stage(`round 1 retrieve START (files=${files.length})`);
    const round1 = await retriever.retrieve({
        query: question,
        modeId: '__interview_knowledge__',
        files,
        tokenBudget,
        topK,
        allowRerank: false,
    });
    _stage(`round 1 retrieve DONE (chunks=${round1.chunks.length})`);

    let chunks = round1.chunks;
    let coverage: EvidenceCoverage | null = chunks.length > 0
        ? coverageFn({ question, retrievedBlock: chunksToRetrievedBlock(chunks) })
        : null;

    const coverageIsWeak = !coverage || coverage.shouldRefuse || coverage.topAnswerability < WEAK_COVERAGE_ANSWERABILITY_FLOOR;
    const remaining = remainingMs();
    const hasBudgetForRetry = remaining == null || remaining >= MIN_MS_TO_ATTEMPT_RETRY;

    if (!coverageIsWeak || maxRounds < 2 || !hasBudgetForRetry) {
        return { formattedContext: chunksToRetrievedBlock(chunks), chunks, coverage, rounds: 1 };
    }

    // Round 2: exactly one bounded retry. Prefer the structural rewrite
    // (exact-identifier / positional) already proven in production; fall back
    // to a keyword-only reformulation — never an LLM call — when the question
    // offers no structural handle to rewrite from.
    const alreadyCovered = chunksToRetrievedBlock(chunks);
    const rewrite = rewriteFn(question, alreadyCovered);
    const retryQuery = rewrite?.query ?? keywordOnlyQuery(question);
    if (!retryQuery) {
        return { formattedContext: chunksToRetrievedBlock(chunks), chunks, coverage, rounds: 1 };
    }

    try {
        _stage(`round 2 retrieve START (reason=${rewrite?.reason ?? 'keyword_fallback'})`);
        const round2 = await retriever.retrieve({
            query: retryQuery,
            modeId: '__interview_knowledge__',
            files,
            tokenBudget,
            topK,
            allowRerank: false,
        });
        _stage(`round 2 retrieve DONE (chunks=${round2.chunks.length})`);
        // UNION, never replace — the reformulated query is narrower by
        // construction (an exact identifier, a keyword list), so replacing
        // round 1's chunks could lose evidence it legitimately found. Same
        // reasoning as the existing T4 retry in IntelligenceEngine.ts.
        chunks = dedupeChunks(chunks, round2.chunks);
        coverage = chunks.length > 0
            ? coverageFn({ question, retrievedBlock: chunksToRetrievedBlock(chunks) })
            : coverage;
        return {
            formattedContext: chunksToRetrievedBlock(chunks),
            chunks,
            coverage,
            rounds: 2,
            retryReason: rewrite?.reason ?? 'keyword_fallback',
        };
    } catch (e) {
        // A failed retry must not discard round 1's evidence.
        console.warn('[agenticRetrieve] round 2 retrieval failed, keeping round 1 evidence:', e instanceof Error ? e.message : e);
        return { formattedContext: chunksToRetrievedBlock(chunks), chunks, coverage, rounds: 1 };
    }
}
