# Live Overlay UI Rework, Speaker Separation, and Continuous Vision — Spec

## Status: Phase 1 (teleprompter rework + citations) implemented and typechecked (2026-09). Sections 2-5 below still pending — see "Implementation log" for exactly what shipped, what was corrected from this draft, and what changed by explicit direction during implementation.

## Implementation log (2026-09) — read this before the sections below

The sections below are the ORIGINAL draft analysis and are kept for their
research value, but several were superseded by explicit, more aggressive
direction given directly during implementation, and a few factual claims in
the draft turned out to be stale once the code was actually read. This log is
the authoritative record of what actually shipped; where it conflicts with a
section below, this log wins.

**Final direction (supersedes Section 1's "keep Clarify/manual-mic as
fallback" recommendation):** remove every on-screen button from the overlay
body except the top-pill Stop. No manual override, no DynamicActionBar
suggestion cards. The overlay shows exactly two things: a live transcript
feed (top) and the single current answer, replaced wholesale as new
questions land (bottom) — not a scrollback. Model/provider selection moves
entirely into the separate Settings window ("lock in the settings"); the
Settings "Active Model" dropdown was made deliberately compact
(`AIProvidersSettings.tsx`'s `ModelSelect`, `widthClassName="w-24"`) per
explicit request.

**Direct Assist is explicitly OUT OF SCOPE.** It is a separate, opt-in
(default off) answer engine with its own provider-ladder fallback, reachable
today only via the manual button that was removed. `SimpleAutoAnswerEngine`
was confirmed to have ZERO references to Direct Assist anywhere in
`IntelligenceEngine.ts` — the two systems don't talk to each other. After
explicit clarification ("my goal is to use the auto-answer feature only"),
no integration between the two was built. Direct Assist's code and its
manual-only trigger stay exactly as they were.

**Global keyboard shortcuts were explicitly KEPT**, after surfacing the
question directly: the quick-action handlers (`handleWhatToSay`,
`handleClarify`, `handleRecap`, `handleBrainstorm`, `handleFollowUpQuestions`,
`handleAnswerNow`) and their `handlersRef`-based hotkey dispatch
(`NativelyInterface.tsx` ~8453) are UNTOUCHED — only their on-screen button
JSX was deleted. This means a configured hotkey still reaches these handlers
as a hidden manual-override path; this was a deliberate lower-risk choice,
not an oversight, and should be revisited if it turns out to conflict with
"auto-answer only" in practice.

**Critical correctness fix not in the original draft:** `autoAnswerEnabled`
defaulted to `false` (`electron/services/SettingsManager.ts`,
`electron/main.ts`). With every manual button deleted, a default-off
Auto-Answer meant the rebuilt overlay produced nothing at all out of the box
— confirmed as the actual root cause of an early "nothing shows in the
teleprompter, but it's still recording" report during testing. Fixed by
flipping the default to `true` in both `electron/main.ts` (`_autoAnswerEnabled`
field + constructor fallback) and `SettingsManager.ts`'s field comment;
`SettingsOverlay.tsx`'s initial React state was matched to avoid a
false→true flash. An explicit persisted `false` (a user who deliberately
disabled it) is still honored — only an *unset* value gets the new default.

**Second bug found during the same report:** `RollingTranscript`'s mount
condition in `NativelyInterface.tsx` only checked the interviewer-channel
text (`showTranscript && rollingTranscript`), so when only the user's own mic
picked up speech, the entire transcript bar — including the new user-channel
line — stayed unmounted. Fixed to `showTranscript && (rollingTranscript ||
rollingTranscriptUser)`.

**Citations fix, done exactly as this draft's Section 2/"Citations fix"
analysis prescribed, with one correction found during implementation:**
citations were wired into `main.ts`'s `intelligence-suggested-answer` emission
(the 'answer' kind only) and the corresponding `NativelyInterface.tsx`
handler, mirroring the existing manual-chat `gemini-stream-done` pattern
exactly. Citations were deliberately NOT added to the `recap`/`clarify`/
`follow_up_questions_update` emissions after reading `IntelligenceEngine.ts`
and confirming `runRecap`/`runClarify`/`runFollowUpQuestions` each use their
own dedicated LLM class (`recapLLM`/`clarifyLLM`/`followUpQuestionsLLM`) with
no Interview Knowledge retrieval step at all — attaching
`getLastInterviewKnowledgeCitations()` there would have shown a STALE
citation set left over from an unrelated prior 'answer' turn, a real bug
caught before it shipped rather than one to fix later.

**Section 1.6 (dual-channel transcript) implemented**, but simpler than this
draft's original description: `NativelyInterface.tsx`'s `onNativeAudioTranscript`
handler now routes `speaker === 'user'` transcripts (when not manually
recording) into a parallel `rollingTranscriptUser` state using the same
`mergeRollingTranscriptPartial`/`mergeRollingTranscriptFinal` helpers as the
interviewer channel, and `RollingTranscript.tsx` renders both lines. The
manual-mic-recording branch (`isRecordingRef.current && speaker === 'user'`)
was left untouched since the keyboard shortcut for it was kept (see above).

**STABILITY_MS raised 900ms → 2000ms** per explicit "~2 seconds of quiet"
direction. `EARLY_JUDGE_MS` (120ms) was confirmed NOT to need a matching
change — it fires on an absolute "any pause at all" threshold to start the
judge call early, not `STABILITY_MS`-relative, so a longer commit window only
gives the ~1.3s judge call more headroom to finish first.

**State-model simplification vs. the original plan:** rather than inventing a
new `currentAnswer` state object and rewiring all 4 completion-event
families' handlers, the simpler fix was to keep `messages`/`setMessages`
completely unchanged (all existing finalize/streaming logic, generation-id
staleness guards, etc. untouched) and only change what's RENDERED: a
`currentAnswerMessage` `useMemo` finds the last `role === 'system'` message in
`displayMessages` and renders it alone via the existing `MessageRow`
component, instead of `.map()`-ing the full scrollback. This reused 100% of
the existing streaming/markdown/citations rendering machinery with far less
code churn and risk than the original plan's approach.

**Not yet done (pending, tracked as the next chunk of work):**
- Section 2 speaker-role fix — now expanded per direct request: meeting
  notes should structure content as explicit Q&A ("what this candidate
  answered") with proper speaker labels, ElevenLabs Scribe realtime data
  should carry that label through, and Settings should gain a per-voice
  display-name option. The original draft's cited fix target,
  `electron/llm/IntentClassifier.ts`, was confirmed DELETED (commit
  `af6ff112`) — the real current list of label-producing call sites is
  `transcriptCleaner.ts`, `SessionTracker.ts` (three separate inline
  duplicates), `MeetingPersistence.ts`, `longRangeTranscriptRecall.ts`,
  `transcriptQuestionExtractor.ts`, and `TemporalContextBuilder.ts`.
- Section 3 vision capture-on-completion.
- Section 5 (this log's numbering) — two real ElevenLabs STT bugs reported
  directly: language selected as English not being retained/enforced, and
  live transcript text getting overwritten/re-transcribed rather than
  appended (most likely a reconnect-replay of already-committed audio). Both
  need a diagnostic logging pass before a fix, not a blind patch.

## Why this exists

The live/floating overlay shown during an active call (`src/components/NativelyInterface.tsx`,
loaded by the `overlayWindow` BrowserWindow — `electron/WindowHelper.ts:842-873`) currently asks
the user to manually drive several controls that this codebase already has the machinery to infer:
which quick action to run, whether a stray utterance is a question worth answering, and when to
label a piece of transcript as coming from the interviewer vs. the user. Separately, live speaker
labeling is asked for as new work, and it turns out to be a mix of "data already exists, just not
surfaced" and one confirmed, real bug. Finally, this spec answers whether continuous vision-model
screen monitoring is worth building, given what already exists (`screenshot_descriptions` cache,
`adaptiveImageQuality`) and what a stream-completion-triggered capture would cost compared to
fixed-interval polling.

## Non-goals

- Does not touch `isProOrTrialActive()` (`electron/ipcHandlers.ts`) or route around it. Nothing
  proposed here needs a Pro-gated IPC call — Modes creation/editing, reference-file upload, and
  Profile Intelligence are untouched. Where a natural extension of this work *would* eventually
  brush against a gated surface, that is called out explicitly below as a constraint, not designed
  around.
- Does not attempt to hide the app's window from remote-desktop/screen-share viewers (Parsec,
  Chrome Remote Desktop, Meet, Zoom capture, etc.) — out of scope, declined separately.
- Does not recommend defeating proctoring/monitoring software. Section 4 is about the app's own
  screen-reading capability for answering questions — its existing, stated purpose — not evasion.
- Does not redesign Modes, Profile Intelligence, or the Interview Knowledge RAG feature
  (`docs/specs/oss-knowledge-rag-spec.md`).

---

## Section 0 — Locating the real live overlay component

`src/components/Launcher.tsx` is the dashboard/meeting-history screen (confirmed wrong for this
task per the prompt). The actual in-call overlay is a **separate BrowserWindow with its own React
mount**, found by tracing window creation, not by searching `Launcher.tsx`:

1. `electron/WindowHelper.ts:842-873` builds `overlaySettings` and constructs
   `this.overlayWindow = new BrowserWindow(overlaySettings)`. Concretely: `frame: false` (:856),
   `transparent: true` (:857), `alwaysOnTop: true` (:859), `skipTaskbar: true` (:863),
   `hasShadow: false` (:864), plus macOS `type: 'panel'` (:870) and, on Windows,
   `setAlwaysOnTop(true, 'screen-saver')` (:961) so it renders above fullscreen apps.
2. `electron/WindowHelper.ts:964` loads `${startUrl}?window=overlay`.
3. `src/App.tsx:114` reads that query param: `isOverlayWindow = ... .get('window') === 'overlay'`.
4. `src/App.tsx:1053-1077` is the overlay's render branch. It mounts
   `<NativelyInterface onEndMeeting={handleEndMeeting} overlayOpacity=... interfaceTheme=... />`
   (`:1066-1070`) — **`src/components/NativelyInterface.tsx` is the actual live overlay
   component**, a 10,756-line file.
5. Two more BrowserWindows ride alongside it as separate OS windows so the main overlay window can
   hug its content exactly: `OverlayPillWindow` and `OverlayToggleWindow`
   (`src/components/OverlayAuxWindows.tsx:191-278`), created via
   `WindowHelper.createOverlayAuxWindows` (pill/toggle window creation at `WindowHelper.ts:1595+`
   and `:1664+`). State flows to them over `'overlay-ui-state'`; their clicks flow back over
   `'overlay-ui-action'` (`OverlayAuxWindows.tsx:61-63`) to handlers inside `NativelyInterface.tsx`.

### Current control inventory (verified by reading the code, not assumed)

**Top pill** (`src/components/ui/TopPill.tsx`, its own always-visible OS window):
| Control | Code | Action |
|---|---|---|
| Logo button | `TopPill.tsx:37-57` | `onLogoClick` → `setWindowMode('launcher')` (opens the dashboard) |
| Hide/Show chip | `TopPill.tsx:61-86` | `onToggle` → `sendAction('toggle-expand')` — collapses/expands the overlay body |
| Stop/Quit button | `TopPill.tsx:89-103` | `onQuit` → `sendAction('end-meeting')` → `handleEndMeeting` (`src/App.tsx:957`) — **ends the entire meeting/recording session** |

**Overlay body** (`NativelyInterface.tsx`), quick-action row (`:10228-10283`):
| Button | Handler | What it actually does |
|---|---|---|
| "What to answer?" | `handleWhatToSay` (`:6544`) | Builds a question from the rolling live transcript (or an attached screenshot) and runs it through the live-answer pipeline with `source: 'what_to_answer'` |
| "Clarify" | `handleClarify` (`:6901`) | Calls `generate-clarify` IPC (`ipcHandlers.ts:12887`) — asks the model to produce a clarifying question, not an answer |
| "Recap" / "Brainstorm" (one button, toggled by a separate manual mode switch) | `handleRecap` (`:6845`) / `handleBrainstorm` (`:6993`), switched by `actionButtonMode` state (`:1978`, persisted via `set-action-button-mode`, `ipcHandlers.ts:13073`) | `generate-recap` (`:13115`) summarizes recent discussion; `generate-brainstorm` (`:13008`) produces ideas — two distinct, unrelated tools sharing one button slot |
| "Follow Up Question" | `handleFollowUpQuestions` (`:6873`) | `generate-follow-up-questions` (`:13137`) — suggests questions the user could ask |
| "Answer" / "Stop" | `handleAnswerNow` (`:7501`) | Manual push-to-talk: starts/stops a **separate** manual mic recording, distinct from the passive rolling transcript, then submits it as a question |

Bottom control row (`:10546-10704`): model selector (`:10548-10609`, opens `toggleModelSelector`),
settings gear (`:10624-10661`, opens `toggleSettingsWindow`), mouse-passthrough toggle
(`:10664-10685`, `setOverlayMousePassthrough`), and the chat-input send button
(`:10688-10703`, `handleManualSubmit`). Plus a free-text chat input with a `/`-style skill picker
(`:10436-10540`).

This is the concrete surface the rest of this spec proposes changes against.

---

## Section 1 (revised) — Teleprompter redesign: explicit user decision overrides the "keep as fallback" recommendation below

The original analysis below (kept for its research value) recommended keeping
"Clarify," the manual mic Answer/Stop, and treating Auto-Answer as an
addition alongside the existing buttons. The user has since made an explicit,
informed call that overrides that recommendation: **remove all of it except
the top-pill Stop (end meeting) button.**

Confirmed consequence, stated plainly before this was accepted: there will be
no manual override if Auto-Answer's judge misses a question or the passive
transcript drops audio — "Clarify," "What to answer?," "Recap," "Brainstorm,"
"Follow Up," and the manual mic push-to-talk all go away. Only Stop remains
as a manual control (plus window chrome: hide/show, settings, model
selector, mouse-passthrough — untouched, not "answer stuff").

### Target design

- **Top**: a streaming live-transcript strip — what's being said, rendered
  as it arrives (replaces `RollingTranscript.tsx`'s current single flat
  interviewer-only string with a genuinely live, teleprompter-style feed).
- **Main area**: the answer renders as a clean streaming teleprompter view —
  not chat bubbles, not a scrollback list. One current answer, replacing the
  previous one as new questions land.
- **Trigger**: `SimpleAutoAnswerEngine` becomes the ONLY trigger. No manual
  question submission path in the overlay body.
- **Pause-to-answer timing**: the user asked for "~2 seconds" of interviewer
  silence before answering. The current constant,
  `STABILITY_MS = 900` (`SimpleAutoAnswer.ts:49`, explicitly commented
  `"Unfitted placeholder"`), is the quiet-before-commit window — today it
  fires FASTER than requested (0.9s vs. ~2s), not slower. Raising it to
  ~2000ms is a one-line change, but it is a real behavior tradeoff already
  reasoned about elsewhere in that same file: `EARLY_JUDGE_MS` exists
  specifically to start the (slow, ~1.3s) judge call before the full
  stability window elapses so the answer is ready close to the moment the
  window closes, and `:541`'s comment shows the engine already holds an
  early verdict rather than firing into a mid-sentence breath. Bumping
  `STABILITY_MS` to ~2000 is straightforward; it should be tuned against
  real sessions (too short answers into pauses that weren't really the end
  of a question; too long feels sluggish for a "teleprompter" framing)
  rather than hardcoded from this conversation alone.
- Removed entirely: the quick-action row (`NativelyInterface.tsx:10228-10283`
  — What to answer?/Clarify/Recap-Brainstorm/Follow-up/manual Answer-Stop)
  and the `actionButtonMode` toggle (`:1978`).
- Kept: top-pill Stop/end-meeting (`TopPill.tsx:89-103` → `handleEndMeeting`,
  `App.tsx:957`) — the only manual control that remains, per explicit
  instruction that a destructive, irreversible action must not be silently
  inferred.

This is a substantial rewrite of a 10,756-line component
(`NativelyInterface.tsx`) plus `RollingTranscript.tsx`'s rendering model —
sequenced as its own implementation pass, not a drive-by edit alongside
other work.

---

## Section 1 (original analysis) — remove buttons, infer intent from the question

### The existing inference layer (why this isn't a new problem)

This codebase already infers turn-level intent from question text alone, in three independent,
already-shipped places:

1. **`electron/llm/AnswerPlanner.ts`** — `planAnswer()` (`:1490`) classifies free-text into one of
   ~30 `AnswerType`s (`:47-103`: behavioral, coding, system-design, negotiation, jd-fit, etc.),
   plus `voicePerspective` and `profileContextPolicy`, from the question text and its `source`
   (`'manual_input' | 'what_to_answer' | 'transcript' | 'system'`, `:105`) — with **no LLM call**,
   using regex pattern tables (`electron/llm/answerPlannerPatterns.ts`, imported `:12-45`).
2. **`electron/llm/ProfileIntelligenceRouter.ts`** is a documented "thin, PURE facade"
   (`:1-13`) that composes `planAnswer` into one `ProfileIntelligenceDecision`
   (`shouldUseProfile`, `answerPerspective`, allowed/forbidden context layers) for
   "the three live entry points (manual chat, what-to-answer, knowledge intercept)" — i.e. this is
   already the single place turn-shape decisions are made, regardless of which UI path triggered
   the turn.
3. **`electron/intelligence/autoAnswer/SimpleAutoAnswer.ts`** (`SimpleAutoAnswerEngine`) already
   decides, **with no button press at all**, whether a stoppage in interviewer speech is an
   answerable question: a stability window (`STABILITY_MS`, `:49`), a cheap prefilter (backchannel
   regex `:47`, short-utterance guard `:71`), then one LLM "judge" call
   (`consult()`, `:426`) that returns an answerability score, dispatched via
   `this.host.dispatch(question, ...)` (`main.ts:3247-3251`) straight into
   `IntelligenceManager.runAutoAnswer(...)`. This is wired up in `main.ts:3232-3280` and toggled by
   a **Settings-only** switch (`autoAnswerEnabled`, `SettingsOverlay.tsx:589,2141-2159`,
   `getAutoAnswerEnabled`/`setAutoAnswerEnabled` IPC, `ipcHandlers.ts:6386`), **default OFF**, not
   gated by `isProOrTrialActive`.
4. **`electron/services/dynamic-actions/DynamicActionEngine.ts`** (`detectActions()`, `:18-60`)
   regex-classifies live transcript text into contextual suggestion cards — e.g. a
   `general_summarize` trigger (`DynamicActionDetector.ts:26-34`, patterns like "recap this",
   "quick summary") is functionally the same job as the "Recap" button, and
   `general_assistance_request` (`:14-25`, "what should I say", "how should I respond") is the
   same job as "What to answer?". These cards render in `DynamicActionBar`
   (`src/components/dynamic-actions/DynamicActionBar.tsx`), already mounted in the overlay directly
   above the quick-action row (`NativelyInterface.tsx:9874-9878`), and accepting one calls
   `handleWhatToSay(action.promptInstruction)` (`:9876`) — i.e. the plumbing to turn an inferred
   suggestion into the same answer pipeline a button uses **already exists and is already wired
   into this exact button row**.

None of these four are Pro/trial-gated (`set-auto-answer-enabled`, `acceptDynamicAction`,
`dismissDynamicAction` handlers have no `isProOrTrialActive` call — `ipcHandlers.ts:6386, 13213,
13246`).

### What can genuinely be inferred vs. what cannot

| Control | Verdict | Reasoning |
|---|---|---|
| "What to answer?" | **Infer** | This is precisely `SimpleAutoAnswerEngine`'s job when Auto-Answer is ON. Recommendation: promote Auto-Answer toward being the default live-answer trigger (keep the Settings toggle, but default it ON, or surface it as an overlay-level toggle rather than a per-question button) and keep the manual button only as an explicit override/retry for when the judge is wrong or Auto-Answer is off — `SimpleAutoAnswer.ts:633-643` (`onManualAnswerStarted`) already models a manual press *during* an automatic answer's feedback window as "the automatic answer missed," so the fallback path is a first-class, already-instrumented case, not an afterthought. |
| "Clarify" | **Partially infer, keep as override** | `ipcHandlers.ts` already has an autonomous "should this turn be a clarifying question instead of an answer" short-circuit inside the manual/live-answer kernel (`sourceOwner === 'clarify'` branches at `:2785, 2852`, and the trace comment at `:2449-2462` describing exactly this decision). The button should stay as a manual escape hatch (some users want to force clarification), but does not need to be a permanently-visible quick-action chip if the kernel already offers it automatically when ambiguity is detected. |
| "Recap" / "Brainstorm" | **Cannot be silently inferred; can be collapsed into DynamicActionBar's existing suggestion-card pattern** | These are not "answer this question differently" — they operate over ambient context with no question at all, and are two unrelated tools sharing one button today by manual toggle (`actionButtonMode`, `:1978`). `DynamicActionDetector.ts:26-34`'s `general_summarize` trigger already fires on transcript phrases like "recap this" / "what did they say" — wiring that trigger's card into `handleRecap`/`handleBrainstorm` (the same way `DynamicActionBar`'s `onAcceptAction` already calls `handleWhatToSay`, `:9876`) removes the permanent button and the manual toggle, replacing both with a contextual card that only appears when the transcript actually suggests recap/brainstorm intent — while keeping a discoverable manual path (e.g. typing "recap" or "brainstorm ideas" into the free-text input, which the kernel can route the same way). |
| "Follow Up Question" | **Same pattern as Recap/Brainstorm** | No existing DynamicActionEngine trigger for this today, but it is the same shape of change: add a `follow_up_suggestion` trigger pattern (mirroring `general_summarize`), surface as a card, drop the permanent chip. |
| Manual mic "Answer"/"Stop" push-to-talk | **Cannot be inferred — keep** | This exists because the passive rolling transcript can miss content (STT dropouts, the user wants to ask something the interviewer-channel capture didn't pick up, or the user needs to speak *as themselves* rather than have the ambient transcript be parsed). Starting/stopping a manual recording is a deliberate user action with no "question" to infer from beforehand. |
| Top-pill "Stop" (end meeting) | **Cannot be inferred — keep, explicitly** | `handleEndMeeting` (`App.tsx:957`) tears down the entire recording/meeting session. Silently inferring "the meeting is over" from transcript content is exactly the kind of high-consequence, hard-to-undo action this spec should NOT propose automating — flagged per the task's own instruction to call this out rather than silently design around it. |
| Top-pill Hide/Show, mouse-passthrough toggle, model selector, settings gear | **Keep as-is** | These are window-chrome/preference controls, not answer-intent controls — nothing about "inferring from the question" applies to them. |
| Chat input + skill picker | **Keep as-is** | Already the free-form fallback; nothing to infer away. |

### Concrete design

1. Make Auto-Answer (`SimpleAutoAnswerEngine`) the primary trigger for live answers; keep "What to
   answer?" as a manual override, always available but visually secondary once Auto-Answer is on.
2. Extend `DynamicActionDetector.ts`'s trigger tables with `follow_up_suggestion` and reuse
   `general_summarize`/a new `brainstorm_suggestion` pattern set so Recap/Brainstorm/Follow-up
   surface as `DynamicActionBar` cards instead of permanent chips, using the exact
   `onAcceptAction` wiring that already exists (`NativelyInterface.tsx:9874-9878`).
3. Remove the `actionButtonMode` manual Recap/Brainstorm toggle (`:1978`) entirely once both are
   card-driven — there is no longer a fixed slot to switch between.
4. Keep "Clarify" as a low-priority manual chip or fold it into the free-text input's implicit
   handling (typing an ambiguous or meta request), since the kernel already has an automatic
   clarify short-circuit for the live path.
5. Do not touch the manual mic Answer/Stop control or the top-pill Stop (end meeting) control.
6. **Constraint carried forward explicitly**: nothing above requires a Pro-gated IPC call. If a
   future iteration wanted per-user-customizable trigger phrases (i.e., editing
   `DynamicActionDetector`'s trigger table from Settings), that would start to resemble Modes'
   reference-file customization surface — call that out as needing its own gating decision if it
   is ever proposed, rather than silently reusing a free code path for a Pro-shaped feature.

---

## Section 2 — Speaker separation: what exists vs. what's real new work

### What already exists

- `TranscriptTurn.role: 'interviewer' | 'user' | 'assistant'` (`electron/llm/transcriptCleaner.ts:6`)
  is the canonical per-turn speaker tag, already used throughout retrieval/prompting
  (`formatTranscriptForLLM`, `:204-215`, labels turns `INTERVIEWER`/`ME`/`ASSISTANT` for the model).
- Role assignment today is **channel-based, not voice-diarized**:
  `SessionTracker.ts:815-819` — `mapSpeakerToRole()`: `speaker === 'user'` → `'user'`,
  `speaker === 'assistant'` → `'assistant'`, otherwise → `'interviewer'` (comment: "system audio =
  interviewer"). I.e. mic input is always "user," system-audio loopback is always "interviewer."
  This is a reasonable heuristic for the default candidate-in-a-call setup and requires no per-voice
  ML, but it cannot separate two people sharing one audio channel (e.g. an in-person interview
  captured on one mic) — that gap is exactly what `speakerDiarizationV1` exists for.
- `speakerDiarizationV1` (`electron/intelligence/intelligenceFlags.ts:63` type,
  `:543` registry entry: `env: 'NATIVELY_SPEAKER_DIARIZATION_V1', default: false`) is a real,
  already-built provider-diarization (Deepgram) path — **opt-in, default OFF** ("touches the
  realtime STT path so default OFF" per its own comment).
- `speakerLabelsV1` (`intelligenceFlags.ts:61,537`; Settings entry
  `src/components/settings/IntelligenceSettings.tsx:51`: "Lets you rename speakers (e.g. 'John from
  Client') and uses those names in notes and action items") is scoped to **post-meeting notes**
  (`group: 'Meeting notes'`) — it is a Meeting-Notes-V3 feature for the dashboard/history screen,
  **not** anything rendered in the live overlay. It does not apply to this spec's UI surface as-is.
- The overlay's chat message list **already** visually distinguishes `role === 'interviewer'`
  turns: `NativelyInterface.tsx:1052` applies muted/italic styling, and `:1056-1062` renders an
  explicit `"Interviewer"` label above the bubble. There is **no equivalent explicit label for
  `role === 'user'`** — user turns are only distinguished by right-alignment and blue bubble color
  (`:1018, 1041-1045`), an implicit "this is you" convention borrowed from chat-app norms, not an
  explicit "You"/speaker-1 label.
- The **live rolling transcript bar** (`src/components/ui/RollingTranscript.tsx`) is a single flat
  auto-scrolling text string (`NativelyInterface.tsx:1660` comment: "For interviewer rolling text
  bar") — it renders only interviewer-channel speech, with no per-speaker color/label, and does not
  display the user's own mic speech content at all (only a connection-status indicator per channel,
  `interviewerChannel`/`microphoneChannel` props, `RollingTranscript.tsx:13-14, 23-27`).

### The confirmed bug

`docs/natively-current-modes.md`'s "recruiting" section (lines ~74-88) documents a real,
already-identified defect: in Recruiting mode the **user is the interviewer**, and the candidate is
on the system-audio channel — but `mapSpeakerToRole`'s hardcoded "system audio = interviewer"
mapping and `formatTranscriptForLLM`'s hardcoded `INTERVIEWER`/`ME` labels
(`transcriptCleaner.ts:204-215`) have no mode parameter in scope. The doc's own conclusion: "the
transcript handed to the model labels the candidate `[INTERVIEWER]` and labels the actual
interviewer `[ME]`" — an inversion that also breaks `IntentClassifier.ts:634`'s tier-3 heuristic,
which filters on the literal string `'[INTERVIEWER'`. The doc explicitly states there is no
`user_channel` concept anywhere in the codebase, and that fixing this requires changing the
three-value role union and its two hardcoded labels, not just adding a mode flag.

### Verdict: honest and specific

This is **not** purely a "data already exists, just needs UI surfacing" problem, and it is **not**
purely "real new work" either — it's genuinely split:

1. **Data-exists / needs-surfacing** (for the default candidate-in-a-call setup, i.e. every mode
   except Recruiting): the `role` field is already correct, already flows through the whole
   pipeline, and the chat-bubble rendering already proves the pattern (interviewer label exists;
   user label doesn't). Adding a live "You" / "Interviewer" (or user-renamed, "Speaker 1" /
   "Speaker 2") distinction to the rolling transcript bar and to the user's own chat turns is
   UI work only — no new backend inference needed.
2. **Real new work, confirmed**: making that live labeling *correct in every mode*, specifically
   Recruiting, requires exactly what the docs file concludes — introducing a channel-identity
   concept independent of the semantic "who is asking questions" concept, and updating the two
   hardcoded label strings plus every consumer that pattern-matches on them
   (`IntentClassifier.ts:634` at minimum). Shipping a "Speaker 1 / Speaker 2, relabel as you like"
   UI on top of the CURRENT role vocabulary without fixing this would just make the existing bug
   more visible and more embarrassing (a live, real-time-visible "You said X" / "Interviewer said
   Y" caption that is provably backwards in one shipped mode is worse than the current
   silently-wrong prompt).
3. **True per-voice diarization** (distinguishing two people sharing one physical mic) is
   real, already-built, opt-in, unshipped-by-default work (`speakerDiarizationV1`) — turning it on
   by default is a separate cost/accuracy tradeoff decision, not blocked on anything above.

### Proposed design

- Add a live speaker indicator to `RollingTranscript.tsx` and the chat-bubble row, driven by the
  existing `role` field, generic ("Speaker 1"/"Speaker 2" or channel-based "You"/"Them") by default,
  user-renameable — but gate the *semantic* mapping (which channel is "the interviewer" for
  prompting purposes) behind a fix to `mapSpeakerToRole`/`formatTranscriptForLLM` that is
  mode-aware, not just a cosmetic relabel layered over the current inverted-in-Recruiting mapping.
- Do not reuse `speakerLabelsV1` for this — it is a different feature (post-meeting notes) with its
  own flag and its own UI (`IntelligenceSettings.tsx:51`); a live-overlay speaker label is a new,
  small, additive flag/UI element, not an extension of that one.
- Treat the Recruiting-mode fix as a prerequisite bug fix, sequenced before shipping any live label
  UI that claims to say "Interviewer" vs. "You" — otherwise ship the label as channel-neutral
  ("Speaker 1"/"Speaker 2" with no semantic claim) until the fix lands.

---

## Section 3 — Continuous live vision-model monitoring: feasibility

### What already exists

- **No polling exists today.** A repo-wide search for interval/polling-based screenshot capture
  (`setInterval`/`pollScreen`/`continuousCapture`/`periodicScreenshot` and variants) returns zero
  matches anywhere in `electron/`. Every vision call today is triggered explicitly — a keyboard
  shortcut (`selectiveScreenshot`, referenced in the overlay's placeholder text,
  `NativelyInterface.tsx:10516`) or an explicit quick-action/chat submission.
- **`screenshot_descriptions` cache** (`electron/db/DatabaseManager.ts:1774-1784`, migration
  v30→v31): `image_sha256 TEXT PRIMARY KEY, description, provider, model, created_at`, keyed by an
  **exact** sha256 of the image bytes (deliberately not the perceptual `ImageHashService` hash,
  per the migration's own comment, `:1767-1773`, to avoid serving one screen's transcription for a
  merely-similar one). This is consumed by
  `electron/services/screen/screenTranscription.ts`'s `transcribeScreenForMemory()` (`:33-85`),
  which is explicitly **off the critical path** ("every caller invokes this AFTER its answer has
  been delivered," `:29`) — it re-describes a screenshot for the conversation *record* (so a later
  follow-up question can recall it), not for the turn currently answering. `:42-43` shows the cache
  check: an identical re-capture (a static screen, the same slide, the same error dialog) costs
  **zero** additional vision calls.
- **`adaptiveImageQuality`** (`intelligenceFlags.ts:448,767`: `default: false`) trades image
  resolution for latency per-turn via preset selection (`electron/llm/performance/wiring.ts:436-469`):
  four presets — `fast` (1024px @ q78), `balanced` (1280px @ q85), `technical` (1536px, never
  downgraded — code screenshots must stay legible), `best`. It only ever *downgrades*, and only
  when a slow-provider heuristic predicts the turn will blow its latency budget; it does not touch
  frequency of capture at all.
- Screenshot handling already respects two existing privacy gates that any polling design MUST
  keep respecting: `screenUnderstandingMode` (`vision_first | vision_only | private_vision`,
  `SettingsManager.ts:231,288`) and `providerDataScopes.screenshots`
  (`SettingsManager.ts:211`, checked in `screenTranscription.ts:67`: `allowScreenshots:
  providerScopes.screenshots !== false`). A continuous-monitoring feature that silently increased
  screenshot frequency by 10-100x while a user believes they've limited screenshot use, or while
  `private_vision` is set (local-only vision), would be a real privacy regression if it didn't route
  through these same checks.

### Honest cost/latency answer for periodic polling

True "always watching" polling (fire a vision call on a fixed timer regardless of activity) has
three real costs that make it a poor default, independent of provider:

- **API call volume**: at even a conservative 1 call/10s, that's 6/minute, ~360/hour of live call
  time — for a typical 45-60 minute interview, 270-360 vision calls whether or not the screen ever
  changed. Compare to today's actual usage: a handful of explicit screenshots per session.
- **Provider vision pricing**: vision-capable models generally price image input as a resolution-
  dependent token count layered on top of the text prompt (exact figures are provider- and
  model-specific and change over time — this is a directional, not a hardcoded, claim). At
  `balanced` preset (1280px), each call is a non-trivial fixed image-token cost even before any
  text; multiplying that by 300+ calls/session is a materially different cost profile than the
  current pay-per-explicit-screenshot model, especially for users on pay-as-you-go API keys.
- **Latency**: a vision call is not free-riding on the existing answer latency budget the way
  `transcribeScreenForMemory` is (which runs after the answer already streamed) — a *dedicated*
  polling loop either runs fully in the background (adding no user-facing latency, but adding
  steady-state cost per above) or, if used to gate/enrich the next answer, adds its own multi-
  second vision-call latency into the critical path, which directly fights the sub-second
  responsiveness this app is built around elsewhere (e.g. the RAG spec's explicit sub-500ms target).

**Minimum viable interval, if built**: given the cache already deduplicates identical frames for
free, a naive interval design does not need to fear cost from a *static* screen — the real cost
driver is genuinely *changing* content. A defensible design is change-triggered, not purely
time-triggered: hash the current frame cheaply (reusing `ImageHashService`'s existing perceptual
hash, built for change detection per the migration comment above — not the exact-sha256 key the
description cache uses) on a short local timer (e.g. every 2-3 seconds, all in-process, zero API
cost), and only fire an actual vision call when that perceptual hash changes AND some minimum
quiet-since-last-call interval has elapsed (mirroring `SimpleAutoAnswerEngine`'s stability-window
pattern, `SimpleAutoAnswer.ts:49`, adapted from "speech stopped" to "screen stopped changing").
Even so, a genuinely fast-changing screen (e.g. someone scrolling code) could still trigger calls
every few seconds — a floor around 5-8 seconds between actual vision calls, even on a changing
screen, is a reasonable starting point to keep cost bounded, tunable like every other threshold in
this codebase's adaptive/auto-answer subsystems (all "unfitted placeholder" per their own comments).

### Trigger strategy: capture-on-answer-completion (the requested addition)

A second, additive trigger model — capture fresh screen context right after each answer finishes
streaming, so the next question already has it ready — is cheaper and lower-latency than polling,
and this codebase already has the exact hook needed:

- **The hook**: `window.electronAPI.onGeminiStreamDone(...)` in the renderer
  (`NativelyInterface.tsx:7077-7109`) fires on completion of **every** answer/clarify/recap/
  follow-up stream, regardless of which quick action or Auto-Answer path produced it — it is the
  one place `setIsProcessing(false)` gets called (`:7109`) for the whole live-answer surface. On the
  main-process side this is backed by `event.sender.send('gemini-stream-done', ...)`, emitted from
  eight independent call sites across `electron/ipcHandlers.ts` (`:1882, 2086, 2750, 2835, 3071,
  5757, 6032`) plus `electron/IntelligenceEngine.ts` paths — there is **no single centralized
  main-process "stream finished" function** to hook (each call site sends independently), so the
  renderer-side `onGeminiStreamDone` callback is the more centralized, and therefore more
  maintainable, attachment point: one edit there covers every stream-completion path, rather than
  eight edits scattered across `ipcHandlers.ts`.
- **What to do there**: after `setIsProcessing(false)` (`:7109`), fire a low-priority, fire-and-
  forget capture-and-describe call that mirrors `transcribeScreenForMemory()`'s existing shape
  (`screenTranscription.ts:33-85`) — capture, hash, check `screenshot_descriptions` first
  (`getScreenshotDescription`, `:42-43`), and only spend a vision call if the frame's sha256 isn't
  already cached. This reuses 100% of the existing cache/dedup infrastructure and privacy gating
  (`screenUnderstandingMode`, `providerDataScopes.screenshots`) with zero new storage.
- **Cost/latency vs. polling**: this trigger fires roughly once per answer (a handful to a few
  dozen times per session, bounded by how many questions get answered) rather than on a fixed
  clock — it cannot run up cost during long stretches where nobody is asking anything, which a
  naive timer-based poll would. It is also inherently off the critical path, exactly like
  `transcribeScreenForMemory` today (`:29`: "off the critical path by contract... invoked AFTER its
  answer has been delivered") — the user is already reading/acting on the just-delivered answer
  while this runs, so its latency is invisible rather than something the user waits through, unlike
  a mid-turn polling call inserted into the answer path.
- **Recommendation**: ship capture-on-answer-completion first — it is strictly cheaper, lower-risk,
  and reuses more existing code than fixed-interval polling, and it directly serves the stated goal
  (fresh screen context ready for the *next* question) without inventing a new background loop.
  Fixed-interval/change-triggered polling (previous subsection) is a reasonable Phase 2 if
  on-completion capture proves insufficient (e.g. long silent stretches where the screen changes
  materially between questions) — not a Phase 1 requirement.

---

## Phased implementation

1. **UI rework (Section 1)**
   1. Default `autoAnswerEnabled` ON (or add an overlay-visible toggle) so Auto-Answer becomes the
      primary live-answer trigger; keep "What to answer?" as manual override.
   2. Add `follow_up_suggestion` (and a brainstorm-intent) trigger set to
      `DynamicActionDetector.ts`, mirroring `general_summarize`'s pattern shape.
   3. Wire the new triggers' cards through `DynamicActionBar`'s existing `onAcceptAction` →
      `handleRecap`/`handleBrainstorm`/`handleFollowUpQuestions`, same pattern as `handleWhatToSay`
      today (`NativelyInterface.tsx:9876`).
   4. Remove the permanent Recap/Brainstorm chip and the `actionButtonMode` toggle
      (`NativelyInterface.tsx:1978, 10242-10256`) once cards cover both.
   5. Leave "Clarify," the manual mic Answer/Stop, and the top-pill Stop control untouched per the
      "cannot be inferred" analysis above.
2. **Speaker separation (Section 2)**
   1. Fix the Recruiting-mode role inversion first: make `mapSpeakerToRole`
      (`SessionTracker.ts:815-819`) and `formatTranscriptForLLM`'s labels
      (`transcriptCleaner.ts:204-215`) mode-aware (or introduce the `user_channel` concept the docs
      file identifies as missing), and update `IntentClassifier.ts:634`'s literal-string match.
   2. Add a channel-neutral live speaker indicator to `RollingTranscript.tsx` and an explicit "You"
      label to `role === 'user'` chat bubbles (mirroring the existing `role === 'interviewer'`
      label at `NativelyInterface.tsx:1056-1062`), rename-able, independent of `speakerLabelsV1`.
   3. Only bind that live label to semantic "Interviewer"/"Candidate" text after step 2.1 ships.
3. **Continuous vision monitoring (Section 4)**
   1. Ship capture-on-`onGeminiStreamDone` first, reusing `transcribeScreenForMemory`'s cache path.
   2. Evaluate real usage (how often the next question needs screen context the completion-trigger
      missed) before considering change-triggered polling as a Phase 2.

## Verification

- Manual test: with Auto-Answer defaulted on, confirm the permanent Recap/Brainstorm chip is gone
  and equivalent `DynamicActionBar` cards appear when the transcript says "recap this" /
  "brainstorm ideas for..." / an explicit follow-up request, and that accepting a card produces the
  same result the old button did.
- Regression test: verify the manual "What to answer?" override still works with Auto-Answer on,
  and that `SimpleAutoAnswer.ts:633`'s `onManualAnswerStarted` feedback-window telemetry still
  fires correctly when a manual press follows an automatic answer.
- Recruiting-mode test: after the role-mapping fix, verify a Recruiting-mode session's transcript
  sent to the model labels the actual interviewer (user, on mic) as such and the candidate (system
  audio) as such — the inverse of today's behavior — and that `IntentClassifier.ts`'s tier-3
  heuristic measures the correct party's turn length.
- Live-label test: confirm the rolling transcript bar and chat bubbles show a "You" vs. speaker
  label distinction in every mode, and that in non-Recruiting modes this matches today's already-
  correct `role` assignment (no regression for the common case).
- Vision-monitoring test: confirm a repeated identical screenshot after an answer produces a cache
  hit (`getScreenshotDescription`) with zero additional vision-provider calls, and that the
  capture-on-completion path is skipped entirely when `screenUnderstandingMode === 'private_vision'`
  and local vision is unavailable, or when `providerDataScopes.screenshots === false`.
- Cross-platform: no OS-specific code is introduced by any of the above (window/IPC/DB/regex
  changes are already cross-platform in this codebase) — still verify on both macOS and Windows.
