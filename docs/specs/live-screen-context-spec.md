# Automatic Live Screen Context — Spec

## Status: draft, awaiting sign-off before implementation.

## Why this exists

Screen understanding today only ever runs **on demand, synchronously, inside the
critical path of a single answer**. The manual/hotkey "What to Answer" flow
(`electron/ipcHandlers.ts`, `generate-what-to-say` handler, line 12620) awaits
`ScreenUnderstandingService.understand()` (`electron/services/screen/ScreenUnderstandingService.ts:182`)
— up to `SCREEN_UNDERSTANDING_TOTAL_BUDGET_MS = 6000` (`ScreenUnderstandingService.ts:146`)
— **before** the answer stream even opens. The Auto-Answer suggestion-trigger path
(`ipcHandlers.ts:17109`, `im.runWhatShouldISay(params.question, 0.9, params.imagePaths, {...})`)
doesn't call `understand()` at all today, so automatic answers currently have **no
screen context whatsoever** — only a manual hotkey press gets vision grounding.

The user wants the screen treated as continuously-available background context —
like another RAG document — instead of a per-question, latency-costing round trip.
The splice mechanism for this already exists and does not need to be built:
`PromptAssembler.ts`'s `buildScreenContextBlock()` (line ~595, called at line 298)
already consumes `screenContext.extractedText || screenContext.visibleSummary ||
screenContext.ocrText` and folds it into the prompt. **The actual gap is
triggering — nothing keeps that `screenContext` object fresh and available
automatically, and nothing feeds it to the Auto-Answer path at all.**

Opt-in only: a new settings toggle. Off by default (screen capture is privacy- and
cost-sensitive; this must never activate silently for a user who never asked for it).

## Non-goals

- Does not change `buildScreenContextBlock()`, `PromptAssembler.assemble()`, or the
  prompt-splice mechanism itself — that part already works and is reused as-is.
- Does not add continuous video/ffmpeg streaming (see the earlier discussion this
  session — vision models take discrete images, not streams; a region-picker and a
  streaming-capture pipeline are explicitly separate, un-scoped ideas).
- Does not change the manual hotkey path's *correctness* — only makes it faster
  when a fresh cached description already exists (secondary, see Phase 3).
- Does not weaken or bypass `providerDataScopes.screenshots` or
  `screenUnderstandingMode === 'private_vision'` gating — the automatic trigger
  must no-op exactly where a manual capture would be refused today.
- Does not touch `transcribeScreenForMemory()`'s post-answer conversation-record
  path (`electron/services/screen/screenTranscription.ts`) — separate, already
  working, untouched.

## Architecture

### New setting: `liveScreenContextEnabled`

Following the existing flag pattern exactly (`speakerLabelsV1` is the template):

- `electron/intelligence/intelligenceFlags.ts`:
  - Add `liveScreenContextEnabled` to the `IntelligenceFlagKey` union (near line 61).
  - Add a `FlagSpec` entry (pattern at line 537):
    ```ts
    liveScreenContextEnabled: { env: 'NATIVELY_LIVE_SCREEN_CONTEXT', setting: 'liveScreenContextEnabled', default: false },
    ```
- `electron/services/SettingsManager.ts`: add `liveScreenContextEnabled?: boolean`
  to the `AppSettings` interface (plain field, pattern at lines 277-286) — no
  bespoke getter/setter needed, read via `settings.get('liveScreenContextEnabled')`
  same as any other flag.
- `src/components/settings/IntelligenceSettings.tsx`:
  - Add a `FLAG_META` entry (pattern at line 51):
    ```ts
    liveScreenContextEnabled: {
      label: 'Automatic screen context',
      desc: 'Periodically describes your screen in the background so answers can reference it without waiting on a live capture. Off by default.',
      group: 'Screen & vision',
      tier: 'advanced',
    },
    ```
  - Add `'Screen & vision'` to `ADVANCED_GROUP_ORDER` (line 93) — **required**,
    confirmed this list is a filter, not just display ordering; a group missing
    here is silently dropped even with a `FLAG_META` entry.
  - No bespoke render block needed — advanced-tier groups render generically via
    the existing `advancedByGroup` loop (lines 1074-1081).

### Trigger: two combined signals, not a blind timer

There is currently no periodic/interval-based screen capture anywhere in the
codebase (confirmed — grepped every `setInterval` call site, none are
screen-capture-related). Rather than inventing a blind poll (wasted vision calls
during silence, exactly the cost-without-benefit pattern already rejected earlier
this session for the STT judge), use two purpose-fitted signals together instead
of one:

1. **Initial capture on meeting/session start** — `electron/main.ts`'s
   `startMeeting()` (referenced around lines 1427-1447; exact call graph to
   confirm at implementation time) is where system-audio/STT capture already
   spins up. Fire `refreshLiveScreenContext()` here too, in parallel with the
   transcription pipeline starting — not awaited, not blocking meeting start —
   so a first description is already sitting ready well before the first
   question ever lands, instead of the first question always paying for a
   cold capture.
2. **Ongoing refresh piggybacked on the existing prefetch signal** —
   `electron/main.ts` (~line 3319): `prefetchAnswer: (id, text) =>
   this.intelligenceManager.prefetchAutoAnswer(id, text)` — this is the exact
   moment `SimpleAutoAnswerEngine` decides a candidate is worth a speculative
   answer generation. Add a parallel, fire-and-forget call here:
   `this.intelligenceManager.refreshLiveScreenContext()` — same gating as (1).
   This is what keeps the description current for the rest of the session
   (e.g. the candidate has since scrolled to a different part of the editor)
   without polling on a blind timer while nobody's talking.

Both call sites are gated identically on `liveScreenContextEnabled`,
`providerDataScopes.screenshots !== false`, and `screenUnderstandingMode !==
'private_vision'` (same three checks `ipcHandlers.ts:12690-12714` already
applies to the manual path) and both route through the same
`refreshLiveScreenContext()` method — one trigger surface, two call sites.

- **Staleness window**: do not re-capture if the last successful description is
  younger than ~15s (short enough to track an active coding screen changing
  between questions, long enough that back-to-back candidates in the same
  ~STABILITY_MS window don't double-capture). This is a new, purpose-specific
  threshold — **not** `ScreenUnderstandingService`'s existing
  `STALE_THRESHOLD_MS = 5 * 60 * 1000` (`ScreenUnderstandingService.ts:164`),
  which is tuned for the memory/conversation-record cache, a much longer-lived
  and coarser-grained use.
- Off the critical path by construction: fire-and-forget, exactly the same
  contract `transcribeScreenForMemory()` already documents for itself
  (`screenTranscription.ts:28-31`) — nothing here is ever `await`ed by an
  answer-generation call.

### Freshness resolution policy at answer time (the actual staleness fix)

Background refresh alone leaves one real question unanswered: what does the
Auto-Answer path DO with `liveScreenContext` at the moment it needs it, given
it could be perfectly fresh, mid-refresh, stale, or absent? This needs an
explicit, tiered policy, not "use whatever's cached":

1. **Fresh** (`Date.now() - liveScreenContext.capturedAt < 15_000`, the same
   staleness window above): use it directly. Zero added latency — this is the
   common case the whole feature exists for.
2. **Refresh currently in flight**: the prefetch-signal trigger (2. above)
   fires at roughly the same moment the judge is consulted, so it's possible a
   refresh is running but hasn't resolved yet exactly when the answer needs
   it. Wait for it, but **bounded** — up to ~600-800ms (small relative to the
   ~1.2-1.5s judge+prefetch budget already measured tonight, and nowhere near
   the old 6s synchronous block this feature replaces). If it resolves in
   time, use the fresh result; if the bound expires, fall through to (3).
3. **Stale but present** (older than 15s, up to a longer ceiling — propose
   ~45s): use it anyway, but tag it (e.g. a `stale: true` marker alongside it
   in telemetry/logs) so a wrong-looking answer is diagnosable later as "acted
   on stale screen state" rather than an unexplained miss. A ~30s-old
   description of a code editor is still almost always more useful than none.
4. **Too stale (> ~45s) or absent entirely** (feature just enabled this
   session, or the meeting-start capture hasn't completed yet): **do not**
   fall back to a synchronous capture here — that would silently reintroduce
   the exact blocking latency this feature exists to remove, and do so
   unpredictably on the one path (Auto-Answer) where the user has no "wait for
   it" expectation the way a manual hotkey press has. Instead, proceed with NO
   screen context — identical to today's existing Auto-Answer behavior
   (`ipcHandlers.ts:17109` passes none today), so this tier is a strict
   no-regression floor, never a new failure mode.

Considered and rejected: gating tier 4's fallback on some "does this question
need the screen" signal (e.g. reusing `wtaPromotedScreenCoding`,
`IntelligenceEngine.ts:3542`) — checked its actual definition
(`isPromotedScreenCodingTurn`, `electron/llm/codingPromptSignals.ts`) and it
answers a narrower question (should this turn's *response formatting* follow
the coding-answer contract), not "should we pay a synchronous capture cost for
this turn." Reusing it here would have been citing a signal that doesn't mean
what this decision needs — the tiered time-based policy above is honest about
what it actually knows (age of the cached description), nothing more.

### New state: `IntelligenceEngine.liveScreenContext`

- New private field on `IntelligenceEngine`, typed as
  `ScreenUnderstandingResult | null` (interface at
  `ScreenUnderstandingService.ts:104-134`) — store the object `understand()`
  returns **directly, unmodified**, not a hand-picked subset of its fields.
  `capturedAt: number` is already a field on that interface (line 121); no
  wrapper type needed.
- **Routing confirmed, not assumed**: `ipcHandlers.ts:12716` —
  `screenContext = sur.status === 'available' ? sur : undefined;` — is the
  existing manual path's ENTIRE mapping step from `understand()`'s result to
  the `screenContext` value that reaches `runWhatShouldISay`. No field
  renaming, no transformation. Two different `ScreenContext` TypeScript
  interfaces exist in this codebase (`ScreenContextService.ts:17`, legacy,
  required fields; `PromptAssembler.ts:161`, separate shape) — `WhatToAnswerLLM.ts`
  imports the `ScreenContextService.ts` one for its parameter type, but
  `ScreenUnderstandingResult` already backfills `ocrText`/`imagePath`/`hash`/
  `timestamp` specifically "for PromptAssembler compatibility" (interface
  comment, lines 126-128), which is why passing `sur` straight through
  already works today. Store and forward `liveScreenContext` the exact same
  way — do not re-map it into either `ScreenContext` interface by hand.
- `refreshLiveScreenContext()`: capture via `ScreenshotHelper`'s existing
  `takeScreenshot()` (line 672), call `understand()` with a new `userAction`
  tuned for a no-specific-question description (the existing `'transcribe'`
  action, `ScreenUnderstandingService.ts:59`, is documented as "for MEMORY, not
  to answer this turn" — reuse its prompt shape via `buildVisionPrompts()`,
  line 379, but do not conflate the memory cache entry with this one; store the
  result only in `liveScreenContext`, not through `putScreenshotDescription`).
  Respects the same `providerPolicy` shape (`localOnly`, `allowScreenshots`,
  `visionAvailable`, `localVisionAvailable`) built the same way as
  `ipcHandlers.ts:12690-12714` already builds it.
- Consumed at both `runWhatShouldISay` call sites when the caller did not
  already pass a fresher `screenContext`:
  - Auto-Answer path (`ipcHandlers.ts:17109`) — today passes none at all; this
    is the primary target, since it's the one path with zero vision grounding
    currently.
  - Manual/hotkey path (`ipcHandlers.ts:12690-12714`) — **only as a Phase 3
    latency optimization** (see Sequencing): if `liveScreenContext` is fresh
    enough, skip the blocking `understand()` call entirely and reuse it.

### Prompt position: already correct, no change needed

`PromptAssembler.assemble()` already places the SCREEN CONTEXT block (#3,
lines 292-299) **above** the TRANSCRIPT block (#5, lines 306-309) in assembly
order — confirmed by reading the method directly, not assumed. The ask to
"attach the description above the transcript so the model can easily
associate the two" is already satisfied by existing block ordering; this
spec's job is only getting a description into `params.screenContext` for the
Auto-Answer path in the first place, not reordering anything.

### Provider: pin to Gemini for this call specifically

`refreshLiveScreenContext()`'s `understand()` call should be pinned to Gemini,
not routed through the full provider fallback chain's default order (which
tries Natively API → OpenAI → **Gemini Flash** → Claude → Gemini Pro → ...,
per `VisionProviderFallbackChain.ts:10-19` — Gemini is not first by default).
Rationale: the answering call this feeds is itself a Gemini call
(`WhatToAnswerLLM.ts`, `gemini-3.1-flash-lite`/`gemini-3.8-flash`) — keeping
the description generator on the same model family keeps the two calls
consistent (same visual vocabulary/description style) and is the natural fit
for `GeminiPromptCache` (`electron/llm/...`, seen in tonight's earlier latency
traces) if a caching opportunity is added later.

Mechanically this is a small, existing-shape change: `runVisionFallback()`'s
`providers: VisionProviderConfig[]` parameter is explicitly **caller-ordered**
("order matters — callers preorder", `VisionProviderFallbackChain.ts:152`) —
the fallback chain module itself needs no change. `ScreenUnderstandingService.understand()`
needs a way to build a Gemini-only (or Gemini-first, local fallback allowed)
`providers` list for this specific call — likely a new `userAction` value
(e.g. `'live_screen_context'`) or an explicit `preferredProvider: 'gemini'`
param threaded into whatever assembles the `providers` array today. **Exact
construction site to confirm at implementation time** — not traced in this
research pass; flagged rather than guessed.

## Sequencing

1. **Phase 1 — setting + plumbing, no behavior change.** Add the flag (default
   off), the field, the trigger call sites (meeting-start + prefetch-signal)
   wired but gated off by default, and the Gemini-pinned provider list for
   this call. Verify the toggle appears under Settings → Advanced → "Screen &
   vision" and persists, and that a manual test capture with the flag
   force-enabled actually used Gemini (check `providerUsed`/`modelUsed` on the
   result, or the attempts log).
2. **Phase 2 — Auto-Answer gets screen context for the first time.** Wire
   `liveScreenContext` into the `ipcHandlers.ts:17109` call site, including
   the full tiered freshness-resolution policy (fresh / bounded-wait-on-in-flight
   / stale-but-usable / too-stale-or-absent) — not just the happy path. Manual
   QA: with the flag on, ask an Auto-Answer question referencing on-screen
   code; confirm the answer reflects it without the answer's start being
   delayed by a live capture (check `[LLMHelper.stream]`/`[AutoAnswer:trace]`
   timing logs — screen-context should never appear as a blocking stage
   beyond the ~600-800ms bounded wait, and that only when a refresh was
   already in flight). Separately confirm tier 4 (too-stale-or-absent)
   degrades to today's exact no-screen-context behavior, not a hang or an
   error.
3. **Phase 3 — manual/hotkey path latency optimization.** Only after Phase 2 is
   confirmed stable: let the manual path check `liveScreenContext` freshness
   before paying for its own synchronous `understand()` call. This is the one
   part of this spec that changes existing (not just new) behavior, so it ships
   isolated and reviewed separately.

## Risks

- **Privacy**: the entire point of `screenUnderstandingMode`/
  `providerDataScopes.screenshots` is user consent over screen leaving the
  device. An automatic, backgrounded trigger is a strictly *easier* way to
  violate that by accident than a manual button press — Phase 1's gating checks
  are not optional and must be tested with each mode explicitly (`vision_first`,
  `vision_only`, `private_vision`, and `screenshots: false`) before Phase 2 ships.
- **Cost**: bounded by the prefetch-signal trigger (only fires when a candidate
  is already judged worth a speculative answer) and the ~15s staleness window,
  not by conversation duration — should not meaningfully change vision-API spend
  versus today's manual-only usage for a session with normal question cadence.
- **Staleness**: addressed by the tiered freshness-resolution policy above,
  not left open — fresh/in-flight/stale-but-usable/too-stale-or-absent, with
  tier 4 degrading to today's exact behavior (no screen context) rather than
  a new failure mode. The specific numbers (15s fresh window, ~600-800ms
  bounded wait, ~45s stale ceiling) are starting estimates, not measured
  against real usage yet — flag as needing live tuning the same way
  `STABILITY_MS`/`EARLY_JUDGE_MS` needed tuning this session, not constants to
  treat as final on first landing.
- **Conflation risk**: `liveScreenContext` and the memory-transcription cache
  (`ScreenshotDescriptionStore`, keyed by `hashImageSet`) must stay separate
  stores — they serve different consumers (forward-looking live context vs.
  backward-looking conversation record) with different freshness contracts;
  merging them risks a stale live answer or a mis-recorded conversation memory.

## Critical files

- `electron/intelligence/intelligenceFlags.ts` — flag definition.
- `electron/services/SettingsManager.ts` — `AppSettings` field.
- `src/components/settings/IntelligenceSettings.tsx` — `FLAG_META` entry,
  `ADVANCED_GROUP_ORDER` addition.
- `electron/main.ts` — `startMeeting()` (meeting-start trigger) and ~line 3319
  (prefetch-signal trigger, alongside `prefetchAnswer`).
- `electron/IntelligenceEngine.ts` — new `liveScreenContext` field and
  `refreshLiveScreenContext()` method.
- `electron/services/screen/ScreenUnderstandingService.ts` — reused `understand()`
  call, existing gating/policy shape; needs the Gemini-pinned provider path
  for this call type.
- `electron/services/screen/VisionProviderFallbackChain.ts` — read-only
  reference; `providers` is caller-ordered (line 152), no change needed here
  itself, only in what `ScreenUnderstandingService` passes it.
- `electron/ScreenshotHelper.ts` — reused `takeScreenshot()` capture.
- `electron/ipcHandlers.ts` — both `runWhatShouldISay` call sites (line 17109
  primary target, line 12690-12714 secondary/Phase 3).
- `electron/services/context/PromptAssembler.ts` — read-only reference, already
  does what's needed (`buildScreenContextBlock()`), not modified by this spec.

## Verification

- Settings toggle persists across app restart; default is off for a fresh install.
- With the flag off: zero behavior change anywhere (no new capture calls fire —
  confirm via log, no `[ScreenUnderstanding]`-tagged activity absent a manual
  hotkey press).
- With the flag on and each `screenUnderstandingMode`/`providerDataScopes.screenshots`
  combination: confirm the automatic trigger is refused exactly where a manual
  capture would be refused today, not more permissive and not more restrictive.
- With the flag on: an Auto-Answer question about visible on-screen content is
  answered correctly, and the answer's first-token latency is not measurably
  worse than an equivalent non-screen question (confirms the capture is truly
  off the critical path).
- Phase 3 only: a manual hotkey press within the staleness window of a fresh
  `liveScreenContext` measurably skips its own `understand()` call (log-confirm
  the blocking call did not fire) and still produces a correct answer.
