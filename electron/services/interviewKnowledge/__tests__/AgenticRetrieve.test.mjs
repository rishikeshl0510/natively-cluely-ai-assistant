// electron/services/interviewKnowledge/__tests__/AgenticRetrieve.test.mjs
//
// Pins the bounded re-query loop's CONTROL FLOW — not computeEvidenceCoverage's
// or rewriteQueryForRetry's own scoring accuracy (those are exercised by their
// own suites elsewhere). coverageFn/rewriteFn are injected so these tests are
// deterministic and don't depend on the real scoring functions' exact numeric
// thresholds.

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadAgenticRetrieve() {
  // Prefer the built bundle (matches how the app ships); fall back to source.
  try {
    const distPath = path.resolve(
      __dirname,
      '../../../../dist-electron/electron/services/interviewKnowledge/agenticRetrieve.js'
    );
    return await import(pathToFileURL(distPath).href);
  } catch {
    const srcPath = path.resolve(__dirname, '../agenticRetrieve.ts');
    return await import(pathToFileURL(srcPath).href);
  }
}

function makeChunk(overrides = {}) {
  return {
    sourceId: 'doc1',
    fileName: 'resume.txt',
    text: 'Some resume text about backend systems.',
    chunkIndex: 0,
    score: 0.5,
    ftsScore: 0.5,
    vectorScore: 0.5,
    trustLevel: 'untrusted_reference',
    ...overrides,
  };
}

function strongCoverage() {
  return { queryShape: 'other', topAnswerability: 0.9, hasExactEntity: true, hasNumericEvidence: false, hasListEvidence: false, hasDefinitionEvidence: false, hasOkfEvidence: false, selectedSectionCount: 0, shouldRefuse: false, reason: 'sufficient_evidence' };
}

function weakCoverage() {
  return { queryShape: 'other', topAnswerability: 0.1, hasExactEntity: false, hasNumericEvidence: false, hasListEvidence: false, hasDefinitionEvidence: false, hasOkfEvidence: false, selectedSectionCount: 0, shouldRefuse: false, reason: 'sufficient_evidence' };
}

describe('retrieveWithAgenticLoop', () => {
  test('high-confidence round 1: no retry fires', async () => {
    const { retrieveWithAgenticLoop } = await loadAgenticRetrieve();
    const retrieve = mock.fn(async () => ({
      chunks: [makeChunk()],
      formattedContext: 'ctx',
      usedFallback: false,
      usedHybrid: true,
    }));
    const result = await retrieveWithAgenticLoop({
      question: 'What backend systems have you worked on?',
      files: [{ id: 'doc1', modeId: 'm', fileName: 'resume.txt', content: 'x', createdAt: 'now' }],
      retriever: { retrieve },
      coverageFn: mock.fn(() => strongCoverage()),
      rewriteFn: mock.fn(() => null),
    });
    assert.equal(retrieve.mock.callCount(), 1);
    assert.equal(result.rounds, 1);
    assert.equal(result.chunks.length, 1);
  });

  test('weak coverage + a rewritable query: retry fires with the rewritten query, chunks union', async () => {
    const { retrieveWithAgenticLoop } = await loadAgenticRetrieve();
    const round1Chunk = makeChunk({ chunkIndex: 0, text: 'chunk A' });
    const round2Chunk = makeChunk({ chunkIndex: 1, text: 'chunk B' });
    const retrieve = mock.fn(async (params) => {
      if (params.query === 'ID-481') return { chunks: [round2Chunk], formattedContext: 'ctx2', usedFallback: false, usedHybrid: true };
      return { chunks: [round1Chunk], formattedContext: 'ctx1', usedFallback: false, usedHybrid: true };
    });
    const coverageFn = mock.fn(() => weakCoverage());
    const rewriteFn = mock.fn(() => ({ query: 'ID-481', reason: 'targeted_exact_lookup' }));

    const result = await retrieveWithAgenticLoop({
      question: 'What is associated with TECH-PDF-START-481?',
      files: [{ id: 'doc1', modeId: 'm', fileName: 'resume.txt', content: 'x', createdAt: 'now' }],
      retriever: { retrieve },
      coverageFn,
      rewriteFn,
    });

    assert.equal(retrieve.mock.callCount(), 2);
    assert.equal(retrieve.mock.calls[1].arguments[0].query, 'ID-481');
    assert.equal(result.rounds, 2);
    assert.equal(result.retryReason, 'targeted_exact_lookup');
    // Union, not replace: both chunks present.
    assert.equal(result.chunks.length, 2);
  });

  test('weak coverage + no rewrite available: falls back to a keyword-only reformulation, never an LLM call', async () => {
    const { retrieveWithAgenticLoop } = await loadAgenticRetrieve();
    const retrieve = mock.fn(async () => ({
      chunks: [makeChunk()],
      formattedContext: 'ctx',
      usedFallback: false,
      usedHybrid: true,
    }));
    const rewriteFn = mock.fn(() => null);

    const result = await retrieveWithAgenticLoop({
      question: 'What programming languages do you know well?',
      files: [{ id: 'doc1', modeId: 'm', fileName: 'resume.txt', content: 'x', createdAt: 'now' }],
      retriever: { retrieve },
      coverageFn: mock.fn(() => weakCoverage()),
      rewriteFn,
    });

    assert.equal(retrieve.mock.callCount(), 2);
    // keywordOnlyQuery joins wordsOf(question) — no LLM call, purely deterministic.
    const secondQuery = retrieve.mock.calls[1].arguments[0].query;
    assert.ok(secondQuery.length > 0);
    assert.notEqual(secondQuery, 'What programming languages do you know well?');
    assert.equal(result.rounds, 2);
    assert.equal(result.retryReason, 'keyword_fallback');
  });

  test('maxRounds=1 suppresses the retry even when coverage is weak', async () => {
    const { retrieveWithAgenticLoop } = await loadAgenticRetrieve();
    const retrieve = mock.fn(async () => ({ chunks: [makeChunk()], formattedContext: 'ctx', usedFallback: false, usedHybrid: true }));
    const result = await retrieveWithAgenticLoop({
      question: 'What programming languages do you know well?',
      files: [{ id: 'doc1', modeId: 'm', fileName: 'resume.txt', content: 'x', createdAt: 'now' }],
      retriever: { retrieve },
      maxRounds: 1,
      coverageFn: mock.fn(() => weakCoverage()),
      rewriteFn: mock.fn(() => ({ query: 'x', reason: 'targeted_exact_lookup' })),
    });
    assert.equal(retrieve.mock.callCount(), 1);
    assert.equal(result.rounds, 1);
  });

  test('an exhausted deadline suppresses the retry even when coverage is weak', async () => {
    const { retrieveWithAgenticLoop } = await loadAgenticRetrieve();
    const retrieve = mock.fn(async () => ({ chunks: [makeChunk()], formattedContext: 'ctx', usedFallback: false, usedHybrid: true }));
    const result = await retrieveWithAgenticLoop({
      question: 'What programming languages do you know well?',
      files: [{ id: 'doc1', modeId: 'm', fileName: 'resume.txt', content: 'x', createdAt: 'now' }],
      retriever: { retrieve },
      deadlineMs: 0, // no budget left at all
      coverageFn: mock.fn(() => weakCoverage()),
      rewriteFn: mock.fn(() => ({ query: 'x', reason: 'targeted_exact_lookup' })),
    });
    assert.equal(retrieve.mock.callCount(), 1);
    assert.equal(result.rounds, 1);
  });

  test('no files: returns empty without calling retrieve at all', async () => {
    const { retrieveWithAgenticLoop } = await loadAgenticRetrieve();
    const retrieve = mock.fn(async () => ({ chunks: [], formattedContext: '', usedFallback: false, usedHybrid: false }));
    const result = await retrieveWithAgenticLoop({
      question: 'anything',
      files: [],
      retriever: { retrieve },
    });
    assert.equal(retrieve.mock.callCount(), 0);
    assert.equal(result.rounds, 0);
    assert.equal(result.chunks.length, 0);
  });

  test('a failing retry keeps round 1 evidence rather than discarding it', async () => {
    const { retrieveWithAgenticLoop } = await loadAgenticRetrieve();
    const round1Chunk = makeChunk();
    const retrieve = mock.fn(async (params) => {
      if (params.query === 'ID-481') throw new Error('boom');
      return { chunks: [round1Chunk], formattedContext: 'ctx1', usedFallback: false, usedHybrid: true };
    });
    const result = await retrieveWithAgenticLoop({
      question: 'What is associated with TECH-PDF-START-481?',
      files: [{ id: 'doc1', modeId: 'm', fileName: 'resume.txt', content: 'x', createdAt: 'now' }],
      retriever: { retrieve },
      coverageFn: mock.fn(() => weakCoverage()),
      rewriteFn: mock.fn(() => ({ query: 'ID-481', reason: 'targeted_exact_lookup' })),
    });
    assert.equal(result.rounds, 1);
    assert.equal(result.chunks.length, 1);
    assert.equal(result.chunks[0], round1Chunk);
  });
});
