# Free-tier Interview Knowledge RAG — Spec

## Status: draft, complete, awaiting sign-off before implementation.

## Why this exists

The obvious way to ground interview answers in a resume/JD — Modes' reference-file
system — is Pro/trial-gated end to end: `modes:create` (`ipcHandlers.ts:14861`),
`modes:update` (`:14945`, covers `customContext` edits), the source-contract handler
for any non-general mode (`:15012`), `modes:upload-reference-file` (`:15323`), and
`modes:delete-reference-file` (`:15356`) all call `isProOrTrialActive()` and refuse
without it. There is no free door into that system beyond using the pre-seeded
"General" mode completely unmodified.

Instead: a new, standalone feature — **Interview Knowledge** — that lives entirely
outside the Modes system. It reuses the free, non-gated retrieval *library* code
already in this repo (`VectorStore`, `EmbeddingPipeline`, `ModeHybridRetriever`'s
query pattern, `rewriteQueryForRetry`, `computeEvidenceCoverage`) but owns its own
storage, its own IPC namespace, and its own UI. It answers questions using text the
user pastes, opens via a file dialog, or points at a folder — never through any
`modes:*` or `profile:*` channel.

Built for **real, live interview use** — latency is a hard constraint everywhere
below, target sub-500ms for round-1 retrieval.

## Non-goals

- Does not create, edit, or attach anything to a Mode; does not call
  `modes:create`, `modes:update`, `modes:upload-reference-file`,
  `modes:delete-reference-file`, or any `profile:*` handler.
- Does not touch `isProOrTrialActive()` or `featureGate.ts` in any way.
- Not a Modes reference-file clone under a new name.
- Does not attempt to hide the app's window from remote-desktop/screen-share
  viewers (Parsec, Chrome Remote Desktop, Meet, etc.) — out of scope, declined
  separately from this spec.

## Architecture

```
New IPC namespace: knowledge-doc:*
  knowledge-doc:add-text        { title, text }        -> { id, chunkCount }
  knowledge-doc:add-file        { }  (plain dialog.showOpenDialog + SafeDocumentTextExtractor)
  knowledge-doc:add-folder      { folderPath }          -> { added: number, skipped: number }
  knowledge-doc:list            ()                      -> KnowledgeDoc[]
  knowledge-doc:delete          { id }
  knowledge-doc:get-status      { id }                  -> index status
  knowledge-doc:set-round-type  { roundType }            -> persisted per session

New storage: SQLite table `knowledge_docs` (own table, not `mode_reference_files`)
  id, title, content, content_sha256, chunk_count, source ('paste'|'file'|'folder'),
  created_at

New retrieval module: electron/services/knowledgeDoc/KnowledgeDocRetriever.ts
  - Chunking: reuse DocumentMap's sentence/section-aware chunker
    (electron/services/modes/DocumentMap.ts: buildDocumentMap, sentenceAwareWindows)
  - Embedding: reuse EmbeddingPipeline / VectorStore as-is (electron/rag/)
  - Lexical fallback: reuse wordsOf (electron/services/modes/lexicalTokens.ts)

New agentic loop: electron/services/knowledgeDoc/agenticRetrieve.ts
  retrieveWithAgenticLoop({ question, maxRounds, deadlineMs }):
    1. round 1: hybrid retrieve (vector + lexical), default topK, no rerank
    2. score with computeEvidenceCoverage (documentGroundedPrompt.ts:769)
    3. if coverage.shouldRefuse or topAnswerability < 0.35, AND rounds left,
       AND time remains under deadlineMs:
         a. try rewriteQueryForRetry(question, block) — reuses the exact
            identifier/positional-rewrite precedent already in production
            (context-intelligence/retrieval/query-rewrite.ts)
         b. if that returns null, fall back to a keyword-only reformulation:
            wordsOf(question), joined as a lexical-only query (new, ~20 lines,
            no LLM call, no re-embedding — keeps this fast)
         c. re-retrieve, UNION with round-1 snippets (never replace)
         d. recompute coverage; stop if adequate
    4. return { block, snippets, coverage, rounds }

  Bound: maxRounds=2 total (1 extra retry) on the live path — matches the
  ONE-extra-retrieval precedent already shipped in production
  (IntelligenceEngine.ts's T4 doc-grounded retry). Manual/typed-chat path may
  allow maxRounds=3 since it isn't racing a live-answer deadline.

New chat integration point: additive, NOT inside Modes' document-grounded path.
  buildKnowledgeDocContextBlock(question, deadlineMs), called from the SAME
  place LLMHelper already assembles `context` before the prompt
  (electron/LLMHelper.ts, near the existing docGroundedEnforcementActive branch
  at :3480) — gated on "does the user have any knowledge_docs rows", not on
  mode/template type. Runs in any mode, including default General.

Citations in chat: snippet provenance carried through (`sourceId`, matching
  ModeRetrievedSnippet's existing shape at ModeContextRetriever.ts:36-42). The
  chat message renderer gets a new "Sources" affordance — collapsed by
  default, expandable — listing document title + exact snippet text used.
```

## Settings + in-chat quick switch

- **Settings tab**: new panel `src/components/settings/KnowledgeDocsPanel.tsx`
  (its own file — not `ModesSettings.tsx` or `ProfileIntelligenceSettings.tsx`,
  both untouched). Paste-text box, "Add file" button, "Add folder" + "Rescan"
  button, doc list with index-status badges + delete, round-type selector,
  cloud-embedding opt-in toggle (off by default, tradeoff noted inline).
- **In-chat quick switch**: a small control in the live/launcher view next to
  wherever mode-switching already lives, so round type and active knowledge
  set can be changed without leaving the live view mid-interview. Exact
  placement to be confirmed against the current launcher UI once
  implementation starts (needs a short look at `Launcher.tsx`'s existing
  mode-switcher component to match its interaction pattern, not invent a new
  one).

## Embedding model choice

Default: the already-bundled local model, `Xenova/all-MiniLM-L6-v2`
(`electron/rag/embeddingCatalog.ts:106`, 384-dim, on-device via the existing
`EmbeddingPipeline`/ONNX runtime). No network call, no API key, no new
dependency. This is the only choice that keeps a network round-trip out of the
latency budget — a cloud embedding call (OpenAI/Gemini/Voyage) typically costs
100-300ms+ in RTT alone. Its "weaker on large projects" caveat is about
multi-thousand-chunk codebases, not a personal resume/JD/notes corpus.

Opt-in, NOT the default: the user's own configured cloud embedding provider,
for higher retrieval quality, with the <500ms guarantee explicitly waived when
chosen. Never silently switched.

## Folder ingestion

`knowledge-doc:add-folder` — a one-shot recursive scan (`fs.promises.readdir`
+ `SafeDocumentTextExtractor`, same extension allowlist Modes already uses).
Deliberately a "Rescan folder" button, not a live filesystem watcher —
`fs.watch`/FSEvents/ReadDirectoryChangesW behave too differently across
macOS/Windows to take on safely in this pass. Manual rescan costs seconds for
a personal folder and needs zero platform-specific code.

## Prompt caching

Reuse `electron/llm/GeminiPromptCache.ts` as-is when the active provider is
Gemini and the prompt clears its `MIN_PROMPT_CHARS` floor — just keep the new
knowledge-context block in a STABLE position/order across turns so the cached
prefix actually matches. No equivalent hook exists for other providers in this
codebase today; not promising caching benefits outside Gemini here.

## Interview round type → answer shape

Own code, inside this feature, not a Modes change. A round-type selector
(Behavioral / Technical / System Design / Screening) picks which answer-shape
instructions get appended to the prompt:
- **Technical**: reuse `electron/llm/codingContract.ts`'s six-section contract
  as-is — already applied to any coding question regardless of mode.
- **Behavioral**: new STAR-format instruction block (Situation/Task/Action/
  Result), first-person voice.
- **System Design**: new instruction block (constraints -> high-level design
  -> deep dive -> tradeoffs).
- **Screening**: shorter, conversational instruction block.

This is a prompt-composition detail sitting next to the knowledge-context
block in the same assembly step — not a retrieval change.

## Chat memory

Already free, already exists — verification, not new build:
- `chatHistoryMultiTurn` (on by default — session-scoped multi-turn history)
- `ConversationMemoryService` (same-session follow-up resolution)
- `conversationMemoryV2` (opt-in same-session follow-up handling)
- `hindsightMemory`/`hindsightLiveRecall` (optional CROSS-session long-term
  memory via the Hindsight companion server — gated only by a plain flag)

Action: confirm `chatHistoryMultiTurn`/`conversationMemoryV2` are actually on
and working. If cross-session persistence (surviving a restart) is wanted,
that's the Hindsight setup path, not new code.

## Automatic skill picker (follow-on phase, not blocking the above)

`SkillsManager` is not wired into `IntelligenceEngine`'s live-answer path
today — only manual/chat writing tasks use it. Skill *matching* against a live
question can be near-instant (same ONNX zero-shot classifier Auto-Answer
already uses, or a keyword match) and can run in parallel with knowledge-doc
retrieval. Skill *answering* still requires a normal LLM generation call,
which cannot be made sub-500ms with any current provider — so this phase
speeds up routing, not generation. Ships after the RAG loop, not with it.

## Phased implementation

1. `knowledge_docs` table + migration.
2. `KnowledgeDocRetriever` (chunk + embed + hybrid retrieve).
3. `agenticRetrieve.ts` + unit tests (high-confidence no-retry; low-confidence
   with rewrite; low-confidence with keyword fallback).
4. IPC handlers (`knowledge-doc:*`) — a grep-test asserts none of them contain
   `isProOrTrialActive`, mirroring `ProfileIntelligenceGate.test.mjs`'s
   pattern but asserting the opposite, so this stays honestly free on every
   future edit.
5. `KnowledgeDocsPanel.tsx` (Settings) + launcher quick-switch control.
6. LLMHelper integration point + citation rendering in chat.
7. Round-type answer-shape instructions.
8. Skill-picker wiring (follow-on).

## Verification

- Unit tests for `agenticRetrieve.ts`'s three branches.
- Grep-test: no `knowledge-doc:*` handler calls `isProOrTrialActive`.
- Manual test: paste a short resume + JD, ask 3-4 realistic interview
  questions, confirm citations match source text, time round-1 retrieval
  (target: comfortably under 500ms with local embeddings).
- Cross-platform: no OS-specific code in this feature (SQLite, embeddings,
  file dialog are already cross-platform here) — still run the manual test on
  both macOS and Windows before calling it done, per this project's CLAUDE.md.
