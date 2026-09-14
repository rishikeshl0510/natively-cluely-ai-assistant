/**
 * SIMPLE Auto Answer engine (user decision 2026-08-25) — "legacy trigger,
 * judge brain".
 *
 * Six live rounds showed the V3 candidate machinery (quiet windows, revision
 * re-judging, act heuristics, channel state machine) eating real questions
 * before the judge — which was never wrong — could rule. This engine is the
 * requested middle ground:
 *
 *   interviewer speech STOPS (stability window, endpoint-shortened)
 *     → cheap local prefilter (dup / backchannel / too short — zero cost)
 *       → ONE judge call ("autoanswer yes/no" + the extracted question)
 *         → dispatch | offer | silent.
 *
 * Cost/latency discipline:
 *  - one call per STOPPAGE, never per final (V3 judged one utterance 6×);
 *  - interims and finals both restart the stability window, so the call fires
 *    only when the interviewer has actually stopped — and the window overlaps
 *    the LLM latency the user must wait through anyway;
 *  - a call is superseded (never applied) when new interviewer speech arrives
 *    while it is in flight — the next stoppage re-judges with more context;
 *  - the judge prompt's static prefix enables implicit provider caching.
 *
 * The user channel is INERT (user decision 2026-09-03). The user answers the
 * moment a question lands — nobody sits in silence waiting for the overlay —
 * so their own speech never cancels a streaming answer, never clears a
 * candidate and never drops a parked or deferred verdict. The mic is still
 * transcribed (the judge sees both sides), it just has no vote here. This
 * retired the 2026-08-24 "lenient mic" policy and its echo latch with it.
 * Judge unavailable → almost-legacy fallback: dispatch only when the stopped
 * speech ends with '?'.
 */

import type { TranscriptSegment } from '../../SessionTracker';
import type { TranscriptTurn } from '../../llm/transcriptCleaner';
import type { Clock, ClockTimer } from './AutoAnswerClock';
import { systemClock } from './AutoAnswerClock';
import {
    JUDGE_DEADLINE_MS, JUDGE_CONTEXT_TURNS, parseJudgeVerdict, routeForVerdict, type JudgeRequest,
} from './AutoAnswerJudge';
import { isMidWordCut, joinTranscriptParts, normalizeForCompare } from './AutoAnswerText';
import type { AutoAnswerThresholds } from './AutoAnswerPolicy';
import { DEFAULT_THRESHOLDS } from './AutoAnswerPolicy';
import type { AutoAnswerQuestion, AutoAnswerTelemetryEvent } from './AutoAnswerTypes';

/** Interviewer-side prefilter: a candidate that is nothing but acknowledgements never costs a judge call. */
export const USER_BACKCHANNEL = /^(?:(?:yeah|yes|yep|yup|ya|mm-?hm+|mhm+|uh-?huh|ok(?:ay)?|right|sure|cool|got it|i see|nice|great|perfect|exactly|interesting|makes sense|sounds good|true|correct|wow|oh|ah|hm+|haha+|alright|of course|fair enough|no problem|totally|absolutely|definitely|indeed|good|fine)[\s,.!?-]*){1,4}$/i;
/**
 * The interviewer must be quiet this long before the judge is consulted.
 *
 * History: 900ms (original) -> 2000ms (2026-09, teleprompter rework, "~2s of
 * quiet" direction) -> 1200ms (2026-09, same week, after live latency testing
 * showed the full response chain — this wait + retrieval/generation + reveal
 * — felt too slow end-to-end with no manual override left as a fallback).
 * 1200ms is a middle ground: still meaningfully calmer than the original
 * 900ms default, but a real ~800ms cut off the 2000ms value once it was
 * actually felt live. Tune against real sessions rather than assuming this
 * exact value is final — this is a deliberate behavior tradeoff (speed vs.
 * risk of firing on a mid-sentence breath), not a fixed constant.
 */
export const STABILITY_MS = 1200;
/**
 * Quiet needed before the judge is ASKED, as opposed to before the answer is
 * COMMITTED (that stays STABILITY_MS).
 *
 * The judge costs ~1.3 s and, until now, that whole cost sat after the 900 ms
 * window — so an answer landed ~2.2 s after the interviewer stopped, where the
 * legacy trigger fired at 900 ms flat. Asking earlier overlaps the judge with
 * the rest of the window instead of queueing behind it.
 *
 * It is deliberately a QUIET window rather than "on every final": interims
 * keep pushing it out, so during continuous speech the early judge never
 * fires. That is the whole ration — no counter, no cooldown, just the fact
 * that a talking interviewer never leaves a 120 ms gap. It also multiplies
 * only the CHEAP call: the judge is ~2.2k tokens on flash-lite and never
 * touches the answer engine, whereas prefetching the ANSWER early would take
 * activeMode out of idle and park the real dispatch behind a junk generation.
 *
 * Unchanged by the STABILITY_MS bump above: this is an ABSOLUTE "has the
 * interviewer paused at all" threshold, not STABILITY_MS-relative — it fires
 * at the same 120ms regardless of how long the full commit wait is. A longer
 * STABILITY_MS only gives the ~1.3s judge call MORE headroom to finish before
 * the (now 2000ms) commit point, so this stays correct without adjustment.
 */
export const EARLY_JUDGE_MS = 120;
/** A provider endpoint (speech_final / <end>) confirms the stop: shorten the wait. */
export const ENDPOINT_CONFIRM_MS = 350;
/** Below this many NEW words (and no '?') we wait for more speech instead of calling. */
export const MIN_NEW_WORDS = 4;
/**
 * Fire at anything above this. The offer card is gone, so this is the only
 * line left in the dispatch decision — above it the answer is drafted, below
 * it nothing happens.
 *
 * 0.20 (user, 2026-08-25) → 0.30 (user, 2026-08-26).
 *
 * Worth knowing before tuning it again: the judge's output is effectively
 * QUANTIZED. Across every session captured so far it has returned only
 * 0 (×132), 0.1 (×69), 0.4 (×5), 0.8 (×2), 0.9 (×19) and 1.0 (×13) — nothing
 * has ever landed between 0.2 and 0.3, so this move changes no dispatch that
 * has actually occurred. The weak band that produced the one questionable
 * answer of the 2026-08-26 session ("I recommend maybe sharing your screen.")
 * is 0.4, and only a floor above 0.4 removes it.
 */
export const ANSWER_FLOOR = 0.30;
/** Judge-unavailable fallback on punctuation-less providers: interrogative-led utterances. */
export const FALLBACK_INTERROGATIVE = /^(?:(?:ok(?:ay)?|so|and|now|alright|well)[,.!\s]+)*(?:how|what|why|when|where|which|who|whose|can|could|would|should|do|does|did|are|is|will|have you|tell me|tell us|walk me|walk us|explain|describe)\b/i;
/**
 * Prefetch pacing. Starting the answer alongside the judge removes ~830 ms
 * (measured) from the critical path, but a prefetch the verdict rejects is a
 * wasted generation, so it has to be rationed.
 *
 * The first cut rationed it with the OLD heuristic scorer — which is exactly
 * the thing the judge replaced because it cannot see declarative tasks. So
 * "why did you choose Postgres?" got the speedup and "your task is to
 * recreate this game in React" did not: the case the feature exists for was
 * the one case that never benefited. Now the ration is TIME, not shape.
 *
 * Cut from 25_000 to 3_000 (2026-09, latency-focused rework), then to 500
 * (same night, explicit "3 seconds is too much" direction): with no manual
 * buttons left, EVERY question the user hears goes through this path. The
 * engine's own idle-only/no-overlapping-speculation guards (see
 * maybePrefetch and consult() above) are what actually prevent wasted/
 * stacked generations, not this interval — this interval only bounds
 * worst-case COST, not correctness, so lowering it further is a pure
 * cost-for-latency trade, not a stability risk. 500ms still exists (rather
 * than 0) purely to stop a true same-tick double-fire on a single stoppage
 * event from paying for two prefetches of the literal same candidate; it is
 * far too short to meaningfully throttle distinct questions in any normal
 * back-and-forth pace.
 */
export const PREFETCH_MIN_INTERVAL_MS = 500;
/**
 * How long after an automatic answer a manual press still counts as "that
 * answer was not good enough". Long enough for the user to read it and
 * decide, short enough that an unrelated later press is not blamed on it.
 * Unfitted placeholder — this signal exists precisely so it can be fitted.
 */
export const FEEDBACK_WINDOW_MS = 20_000;
/**
 * A verdict discarded as stale is KEPT this long, and re-applied at the next
 * stoppage, when it was positive and the candidate has only grown since.
 *
 * Live run 2026-08-25: 25 of 28 verdicts were thrown away. The engine bumps
 * `judgeSeq` on every interviewer text event, the judge takes ~950 ms, and the
 * stability window measures the gap between transcript ARRIVALS rather than
 * speech — on the relay path finals land in bursts 1-2 s apart, so a stoppage
 * fires mid-sentence and the next arriving segment kills the verdict it paid
 * for. Arrival is not resumption: the text that "superseded" the verdict was
 * usually already spoken when the judge was asked.
 *
 * Deferring instead of discarding keeps the invariant the guard existed for —
 * the held verdict is only ever applied from `onStoppage`, i.e. at a quiet
 * point, never mid-sentence.
 */
export const HELD_MAX_AGE_MS = 15_000;
/**
 * A held verdict is applied ONLY to the byte-identical candidate. Growth may
 * never be held across, in either direction, and this was proved by a test
 * before it could ship:
 *   - the growth COMPLETES the utterance ("tell me about the hardest bug you
 *     ever" + "debugged in production and how you found it?") — applying the
 *     held verdict answers a truncated question;
 *   - the growth is a NEW sentence — applying the held verdict answers Q1
 *     after Q2 arrived, which spec V2 §34 pins as an invariant.
 * So growth always re-judges, exactly as before. What this recovers is the
 * INTERIM supersede: an interim cannot change the candidate (`pending` is
 * finals-only), so a verdict it invalidated is still precisely about the text
 * on the table.
 */
/** Busy-engine retry cadence and give-up. */
export const RETRY_MS = 500;
export const RETRY_TTL_MS = 8000;
/**
 * Pending interviewer finals older than this no longer belong to the current
 * thought. Raised 30s -> 90s on 2026-08-25: a coding-interview problem
 * statement runs 45-60 s ("design a class that supports these three
 * operations…"), and a 30 s cap silently dropped its opening, so the answer
 * was drafted against two thirds of the spec. Unfitted placeholder.
 */
export const PENDING_MAX_AGE_MS = 90_000;
/**
 * Circuit breaker (2026-09, "nothing should crash the app — cut a runaway
 * loop off properly" — explicit disaster-recovery request). See the
 * `dispatchTimestamps`/`circuitBreakerUntil` fields below for the full
 * rationale: this is a pure safety net for a bug class that has never been
 * observed, not a tuning knob for normal operation. 5 dispatches within 10s
 * is already far beyond anything a real conversation could produce (each
 * one requires real speech plus a stability wait), so this window is
 * deliberately generous — it only exists to catch a genuine runaway, not to
 * throttle legitimate back-to-back questions.
 */
export const CIRCUIT_BREAKER_WINDOW_MS = 10_000;
export const CIRCUIT_BREAKER_MAX_DISPATCHES = 5;
/** How long the breaker stays open once tripped — long enough that a transient bug's storm has certainly ended, short enough that a real false trip self-heals inside one meeting. */
export const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

export interface SimpleAutoAnswerHost {
    isEnabled(): boolean;
    isMeetingActive(): boolean;
    meetingGeneration(): number;
    engineAccepting(): boolean;
    /**
     * RETIRED 2026-09-03 with the user channel: the engine no longer calls
     * either of these (nothing here cancels a stream any more — see the header)
     * and `main.ts` still supplies both. Left on the interface so reviving the
     * policy is a one-site change rather than a re-wiring; a reader must not
     * take their presence for "the engine can barge in".
     */
    answerStreamActive?(): boolean;
    /** Hot window for judge context (finalized turns, both speakers). */
    recentTurns(): TranscriptTurn[];
    dispatch(question: AutoAnswerQuestion, options: { reuseSpeculative: boolean }): void | Promise<unknown>;
    offer?(question: AutoAnswerQuestion): void;
    retractOffer?(questionId: string, reason: string): void;
    /** See answerStreamActive: retired 2026-09-03, supplied but never called. */
    cancelAutomaticAnswer?(reason: 'user_barge_in'): boolean;
    /** The judge call (same hook as V3): raw model reply, parsed here. */
    judgeCandidate?(req: JudgeRequest): Promise<string | null>;
    /** Key the engine's speculative cache to this candidate. */
    noteCandidate?(questionId: string, candidateGeneration: number): void;
    /** What the engine currently holds speculatively, for keyed reuse. */
    speculativeSnapshot?(): { questionId: string | null; text: string | null };
    /** Start the answer WHILE the judge decides (see PREFETCH_MIN_ANSWERABILITY). */
    prefetchAnswer?(questionId: string, text: string): void;
    modeName?(): string | null;
    telemetry?(event: AutoAnswerTelemetryEvent): void;
    log?(line: string): void;
    /**
     * DEV-ONLY content trace: the exact words the judge is ruling on, and what
     * it ruled. Telemetry and `log` carry lengths and reasons only, by
     * construction, which left one question unanswerable from a real run —
     * *which part of the speech was judged?*
     *
     * The engine never decides whether this is safe: the host supplies the
     * hook only while the Context-Intelligence content gate is open (dev build
     * AND verbose AND the explicit env opt-in), so a packaged build has no
     * hook at all.
     */
    logContent?(label: string, text: string): void;
}

/**
 * Trigger-side stage log (2026-09, latency debugging): SimpleAutoAnswer had
 * telemetry (`emit`) but nothing printed to the console, so a MEASURE_LATENCY
 * trace only ever showed the generation side (LLMHelper.stream) starting at
 * some unexplained offset — the wait-for-quiet + judge time before dispatch
 * was invisible. Gated identically to LLMHelper's `_stage`/`_measure` so one
 * env var shows the WHOLE chain: interviewer stops -> judged -> dispatched ->
 * (LLMHelper stages) -> first token.
 */
const _measure = (() => { try { return process.env.MEASURE_LATENCY === 'true' || process.env.PI_LATENCY_TRACE === 'true'; } catch { return false; } })();
function _atrace(line: string): void { if (_measure) console.log(`[AutoAnswer:trace] ${line}`); }

export class SimpleAutoAnswerEngine {
    private pending: Array<{ text: string; at: number; speaker?: string; glueNext?: boolean }> = [];
    /** Latest interviewer interim — the evidence for whether a final cut a word in half. */
    private lastInterviewerInterim = '';
    /** speakerId per interviewer final, when the STT diarizes. Keyed by normalized text. */
    private speakerByTurn = new Map<string, string>();
    private timer: ClockTimer | null = null;
    /** Fires EARLY_JUDGE_MS after the interviewer's last word: asks, never commits. */
    private earlyTimer: ClockTimer | null = null;
    /** Last interviewer text event of any kind — the commit clock. */
    private lastInterviewerAt = 0;
    private retryTimer: ClockTimer | null = null;
    private judgeSeq = 0;
    private sequence = 0;
    private lastJudgedKey = '';
    private lastAnsweredText: string | null = null;
    /** The automatic answer currently inside its feedback window. */
    private feedbackPending: { id: string; at: number; act: AutoAnswerQuestion['dialogueAct']; answerability: number } | null = null;
    private feedbackTimer: ClockTimer | null = null;
    /** When the last prefetch fired, for PREFETCH_MIN_INTERVAL_MS pacing. */
    private lastPrefetchAt: number | null = null;
    /** A dispatch waiting on a busy engine, so onEngineIdle can wake it immediately. */
    private parkedAttempt: (() => void) | null = null;
    /**
     * Circuit breaker (2026-09, explicit "disaster recovery" request): a
     * pure safety net, not a behavior change — in ANY normal conversation
     * this can never trip (a real question requires actual speech plus
     * STABILITY_MS of quiet before it even reaches dispatch, so 5 genuine
     * dispatches inside 10s is not humanly producible). It exists purely to
     * catch a future bug class this engine has no other defense against: a
     * runaway loop that keeps calling dispatch() far faster than any real
     * conversation could, which could otherwise pile up overlapping/stacked
     * generations. Timestamps of the last few real dispatches, oldest first.
     */
    private dispatchTimestamps: number[] = [];
    /** Set to a future clock time while the breaker is open; dispatch() is refused until then. */
    private circuitBreakerUntil = 0;
    /** A positive verdict superseded by still-arriving transcript — see HELD_MAX_AGE_MS. */
    private held: {
        id: string; key: string; text: string;
        answerability: number; act: AutoAnswerQuestion['dialogueAct']; at: number;
    } | null = null;
    /** Punctuation provenance of the latest interviewer final ('provider' family = a missing '?' means something). */
    private punctuationGuaranteed = false;
    /** What last bumped judgeSeq, so a discarded verdict can say what killed it. */
    private judgeSeqCause: NonNullable<AutoAnswerTelemetryEvent['supersededBy']> | null = null;
    private thresholds: AutoAnswerThresholds;

    constructor(
        private readonly host: SimpleAutoAnswerHost,
        private readonly clock: Clock = systemClock,
        thresholds: AutoAnswerThresholds = DEFAULT_THRESHOLDS,
    ) {
        this.thresholds = thresholds;
    }

    setThresholds(t: AutoAnswerThresholds): void { this.thresholds = t; }

    /** Every supersede goes through here so the telemetry can name the cause. */
    private bumpJudgeSeq(cause: NonNullable<AutoAnswerTelemetryEvent['supersededBy']>): void {
        this.judgeSeq++;
        this.judgeSeqCause = cause;
    }

    onMeetingStart(): void { this.reset(); }
    onMeetingStop(): void { this.reset(); }
    /**
     * The engine went idle. A dispatch parked behind it should go NOW rather
     * than wait out the rest of its 500 ms poll — measured on a real interview,
     * the poll was adding most of a second on top of an already 6-second wait.
     */
    onEngineIdle(): void {
        const parked = this.parkedAttempt;
        if (!parked) return;
        this.clearRetry();
        parked();
    }

    /** Provider says the interviewer's turn ended: confirm the stop sooner. */
    onProviderEndpoint(): void {
        if (!this.host.isEnabled() || this.pending.length === 0) return;
        this.arm(ENDPOINT_CONFIRM_MS);
    }

    ingest(segment: TranscriptSegment & { speaker: string; final: boolean }): void {
        if (!this.host.isEnabled() || !this.host.isMeetingActive()) return;
        const text = (segment.text ?? '').trim();
        const now = this.clock.now();

        if (segment.speaker === 'interviewer') {
            if (!segment.final) {
                // Still talking: every interim pushes the stoppage out — and
                // supersedes any in-flight verdict (review 2026-08-25: a
                // verdict resolving after the interviewer RESUMED must not
                // dispatch mid-sentence; the next stoppage re-judges).
                if (this.pending.length > 0 || text) {
                    if (text) {
                        this.bumpJudgeSeq('interim');
                        this.lastInterviewerAt = now;
                        this.lastInterviewerInterim = text;
                    }
                    this.arm(STABILITY_MS);
                }
                return;
            }
            if (!text) return;
            this.punctuationGuaranteed = (segment as { punctuationSource?: string }).punctuationSource === 'provider' ||
                (segment as { punctuationSource?: string }).punctuationSource === 'provider_final';
            const speaker = (segment as { speakerId?: string }).speakerId;
            if (speaker) {
                this.speakerByTurn.set(normalizeForCompare(text), speaker);
                if (this.speakerByTurn.size > 64) {
                    const oldest = this.speakerByTurn.keys().next().value;
                    if (oldest !== undefined) this.speakerByTurn.delete(oldest);
                }
            }
            // Decide the seam NOW: the interim this final was cut from is still
            // in hand, and it is gone as soon as the next one arrives.
            const glueNext = isMidWordCut(text, this.lastInterviewerInterim);
            this.lastInterviewerInterim = '';
            this.pending.push({ text, at: now, speaker, glueNext });
            this.bumpJudgeSeq('final');  // supersede any in-flight verdict: it judged less than this
            this.lastInterviewerAt = now;
            this.arm(STABILITY_MS);
            return;
        }

        // ── user channel: INERT (user decision 2026-09-03) ────────────────
        // The user starts answering as soon as the question lands. Their
        // speech must not cancel the stream, clear the candidate, or drop a
        // parked / deferred verdict — the answer is wanted precisely while
        // they are talking. Nothing to do on this channel.
    }

    // ── the stoppage ──────────────────────────────────────────────────────

    private arm(ms: number): void {
        this.disarm();
        this.timer = this.clock.setTimeout(() => { this.timer = null; this.onStoppage(false); }, ms);
        // The early ASK rides the same re-arm, so continuing speech pushes it
        // out exactly as it pushes out the commit.
        const early = Math.min(EARLY_JUDGE_MS, ms);
        this.earlyTimer = this.clock.setTimeout(() => { this.earlyTimer = null; this.onStoppage(true); }, early);
    }

    private disarm(): void {
        if (this.timer !== null) { this.clock.clearTimeout(this.timer); this.timer = null; }
        if (this.earlyTimer !== null) { this.clock.clearTimeout(this.earlyTimer); this.earlyTimer = null; }
    }

    private onStoppage(early: boolean): void {
        if (!this.host.isEnabled() || !this.host.isMeetingActive()) return;
        const now = this.clock.now();
        this.pending = this.pending.filter(p => now - p.at <= PENDING_MAX_AGE_MS);
        if (this.pending.length === 0) return;
        const candidate = joinTranscriptParts(this.pending);
        const key = normalizeForCompare(candidate);
        const words = candidate.split(/\s+/).filter(Boolean).length;

        // A verdict this candidate already earned, deferred because transcript
        // kept arriving. Checked BEFORE the lastJudgedKey return: an INTERIM
        // supersede leaves the candidate byte-identical, so that return would
        // otherwise swallow the very case this exists for.
        const heldReady = this.applicableHeld(key, now);
        if (heldReady) {
            this.held = null;
            this.lastJudgedKey = key;
            this.emit({
                name: 'auto_answer_judged', questionId: heldReady.id, judgeOutcome: 'held_applied',
                judgeMs: now - heldReady.at, dialogueAct: heldReady.act, answerability: heldReady.answerability,
            });
            this.host.log?.(`[AutoAnswer:simple] applying the deferred verdict for ${heldReady.id}`);
            this.host.logContent?.(`deferred verdict applied ${heldReady.id} (a=${heldReady.answerability})`, heldReady.text);
            this.deliver(heldReady.id, heldReady.text, heldReady.answerability, heldReady.act, now);
            return;
        }

        // Zero-cost prefilter — the ONLY heuristics left in the hot path.
        if (key === this.lastJudgedKey) return;                     // verdict already stands
        // A short candidate waits for more speech unless it already looks
        // like a question: a literal '?' (always positive evidence) or an
        // interrogative lead (which needs no punctuation, per the
        // punctuationProvenance absence-is-NEUTRAL contract).
        const tooShort = words < MIN_NEW_WORDS && !candidate.includes('?') && !FALLBACK_INTERROGATIVE.test(candidate);
        if (tooShort) {
            this.emit({ name: 'auto_answer_ignored', skipReason: 'incomplete', candidateWordCount: words });
            return;
        }
        if (USER_BACKCHANNEL.test(candidate)) {
            this.emit({ name: 'auto_answer_ignored', skipReason: 'backchannel', candidateWordCount: words });
            return;
        }
        if (this.lastAnsweredText && normalizeForCompare(this.lastAnsweredText) === key) {
            this.emit({ name: 'auto_answer_ignored', skipReason: 'duplicate' });
            return;
        }

        const id = `${this.host.meetingGeneration()}-q${++this.sequence}`;
        this.emit({
            name: 'auto_answer_candidate', questionId: id,
            candidateWordCount: words, endpointSource: 'quiet_window',
        });
        this.lastJudgedKey = key;
        this.host.logContent?.(`judging ${id} (${words}w)`, candidate);
        _atrace(`${id} quiet-window fired (${early ? 'early' : 'commit'}, ${words}w) — sending to judge`);
        // Key any speculation the engine starts on its own interims to THIS
        // candidate, so the dispatch below can claim it by id.
        this.host.noteCandidate?.(id, this.sequence);
        this.maybePrefetch(id, candidate, now);
        void this.consult(id, candidate, now, early);
    }

    /**
     * The held verdict, if it still applies to this candidate: same text, or
     * the same text plus a little more speech. Anything else (a revision that
     * broke the prefix, a long continuation, an old verdict) is dropped here
     * so the stoppage judges afresh.
     */
    private applicableHeld(key: string, now: number): NonNullable<SimpleAutoAnswerEngine['held']> | null {
        const h = this.held;
        if (!h) return null;
        if (now - h.at > HELD_MAX_AGE_MS) { this.held = null; return null; }
        if (key !== h.key) { this.held = null; return null; }   // see the note on HELD_MAX_AGE_MS
        return h;
    }

    /**
     * Start the answer while the judge is still deciding. Rationed by time, so
     * a declarative task gets the same head start as a question mark — see
     * PREFETCH_MIN_INTERVAL_MS. The engine applies its own guards on top (idle
     * only, never over a live stream or an existing speculation), so this can
     * be optimistic without stacking generations.
     */
    private maybePrefetch(id: string, candidate: string, now: number): void {
        if (!this.host.prefetchAnswer) return;
        if (this.lastPrefetchAt !== null && now - this.lastPrefetchAt < PREFETCH_MIN_INTERVAL_MS) return;
        this.lastPrefetchAt = now;
        try {
            this.host.prefetchAnswer(id, candidate);
        } catch { /* prefetch is an optimisation; never break the pipeline */ }
    }

    private async consult(id: string, candidate: string, committedAt: number, early = false): Promise<void> {
        const seq = this.judgeSeq;
        const generation = this.host.meetingGeneration();
        let timer: ClockTimer | null = null;
        let timedOut = false;
        const turns = this.turnsBefore(committedAt);
        const parts = this.pending.map(p => ({ speaker: p.speaker, text: p.text }));
        let raw: string | null = null;
        let outcome: 'verdict' | 'timeout' | 'error' | 'unparseable' | 'absent' = 'verdict';
        if (!this.host.judgeCandidate) {
            outcome = 'absent';
        } else {
            try {
                raw = await Promise.race([
                    this.host.judgeCandidate({
                        candidateText: candidate,
                        recentTurns: turns,
                        speakers: turns.map(t => (t.role === 'interviewer' ? this.speakerByTurn.get(normalizeForCompare(t.text)) : undefined)),
                        candidateParts: parts,
                        modeName: this.host.modeName?.() ?? null,
                        questionId: id,
                        lastAnsweredText: this.lastAnsweredText,
                    }),
                    new Promise<null>((resolve) => {
                        timer = this.clock.setTimeout(() => { timedOut = true; resolve(null); }, JUDGE_DEADLINE_MS);
                    }),
                ]);
                if (timedOut) outcome = 'timeout';
            } catch {
                outcome = 'error';
            } finally {
                if (timer !== null) this.clock.clearTimeout(timer);
            }
        }
        const judgeMs = this.clock.now() - committedAt;
        // Parse FIRST (it is pure and cheap), so that a verdict about to be
        // discarded still reaches telemetry. Live run 2026-08-25: 25 of 28
        // verdicts were dropped here and the record could not say whether a
        // single one of them had said 'answer'.
        const verdict = outcome === 'verdict' ? parseJudgeVerdict(raw, candidate) : null;
        // Superseded: more interviewer speech arrived, the meeting moved on.
        if (seq !== this.judgeSeq || !this.host.isMeetingActive() || this.host.meetingGeneration() !== generation) {
            this.emit({
                name: 'auto_answer_judged', questionId: id, judgeOutcome: 'stale', judgeMs,
                supersededBy: !this.host.isMeetingActive() ? 'meeting_ended'
                    : this.host.meetingGeneration() !== generation ? 'meeting_reset'
                    : (this.judgeSeqCause ?? undefined),
                ...(verdict ? {
                    judgeIsAsk: verdict.isAsk, judgeDirectedAtUser: verdict.directedAtUser,
                    dialogueAct: verdict.act, answerability: verdict.answerability,
                } : {}),
            });
            this.host.logContent?.(
                `superseded ${id} by ${this.judgeSeqCause ?? 'unknown'} after ${judgeMs}ms`
                + (verdict ? ` — it had said ${verdict.isAsk ? 'ASK' : 'not-ask'} a=${verdict.answerability}` : ''),
                candidate);
            // Defer, don't discard. Only a POSITIVE verdict is held: a silent
            // one must not veto the grown candidate, because the ask may be in
            // the very words that superseded it.
            if (verdict && this.host.isMeetingActive() && this.host.meetingGeneration() === generation) {
                const superseded = routeForVerdict(verdict);
                if (superseded.route === 'evaluate' && superseded.action === 'answer'
                    && superseded.answerability > ANSWER_FLOOR) {
                    this.held = {
                        id, key: normalizeForCompare(candidate),
                        text: superseded.questionText ?? candidate,
                        answerability: superseded.answerability, act: superseded.act, at: this.clock.now(),
                    };
                }
            }
            return;
        }
        if (!verdict) {
            if (outcome === 'verdict') outcome = 'unparseable';
            if (outcome !== 'absent') this.emit({ name: 'auto_answer_judged', questionId: id, judgeOutcome: outcome as 'timeout' | 'error' | 'unparseable', judgeMs });
            // A transient judge failure must not silence the question forever
            // (review 2026-08-25): clear the key so the next stoppage retries.
            this.lastJudgedKey = '';
            // Near-legacy fallback: a trailing '?', or — on providers that
            // never guarantee punctuation — an interrogative-led utterance.
            const interrogative = FALLBACK_INTERROGATIVE.test(candidate);
            const willFallbackDispatch = /\?\s*$/.test(candidate) || (!this.punctuationGuaranteed && interrogative);
            // "Just hangs, nothing displayed" (2026-09): this branch previously had
            // NO console-visible trace at all for timeout/error/unparseable outcomes
            // — only a telemetry emit() (not printed) and, IF the fallback below
            // fires, a log line. A candidate that doesn't end in '?' and doesn't open
            // with an interrogative word (common for a multi-sentence question whose
            // LAST clause is a trailing remark, e.g. "...documents? All right.") gets
            // NO fallback and therefore NO output whatsoever — indistinguishable from
            // the judge call still being in flight. Trace unconditionally so a
            // timeout/error is visibly different from "still waiting".
            _atrace(`${id} judge ${outcome} after ${judgeMs}ms — ${willFallbackDispatch ? 'fallback dispatch (trailing ? or interrogative lead)' : 'NO fallback (silently dropped — candidate has neither a trailing ? nor an interrogative lead)'}`);
            if (willFallbackDispatch) {
                this.host.log?.(`[AutoAnswer:simple] judge ${outcome} — fallback dispatch`);
                this.deliver(id, candidate, 0.9, 'general_question', committedAt);
            }
            return;
        }
        this.emit({
            name: 'auto_answer_judged', questionId: id, judgeOutcome: 'verdict', judgeMs,
            judgeIsAsk: verdict.isAsk, judgeDirectedAtUser: verdict.directedAtUser,
            dialogueAct: verdict.act, answerability: verdict.answerability,
        });
        _atrace(`${id} judge verdict in ${judgeMs}ms — isAsk=${verdict.isAsk} act=${verdict.act} answerability=${verdict.answerability}`);
        const route = routeForVerdict(verdict);
        this.host.logContent?.(
            `verdict ${id} → ${route.route === 'evaluate' ? route.action : route.route}`
            + ` (${verdict.act}, a=${verdict.answerability}, ${judgeMs}ms)`,
            route.route === 'evaluate' ? (route.questionText ?? candidate) : candidate);
        if (route.route !== 'evaluate') {
            const reason = route.route === 'wait_incomplete' ? 'incomplete' : route.reason;
            this.emit({ name: 'auto_answer_ignored', questionId: id, skipReason: reason, dialogueAct: verdict.act, answerability: verdict.answerability });
            if (route.route === 'wait_incomplete') this.lastJudgedKey = '';   // more speech may finish it → re-judge then
            return;
        }
        const text = route.questionText ?? candidate;
        // Answer or nothing. The judge decides, and the only number left in
        // the decision is ANSWER_FLOOR — the per-mode bars no longer gate a
        // dispatch, because the thing they used to demote to (the offer card)
        // is gone.
        if (route.action === 'answer' && route.answerability > ANSWER_FLOOR) {
            // An EARLY verdict was asked after EARLY_JUDGE_MS of quiet, which
            // is not enough to call the turn over. If the judge happened to be
            // fast enough that STABILITY_MS has still not elapsed, hold the
            // verdict — the commit timer is already armed and will apply it —
            // rather than answering into a breath. Usually the ~1.3 s judge has
            // outlasted the window on its own and this commits immediately.
            if (early && this.clock.now() - this.lastInterviewerAt < STABILITY_MS) {
                this.held = { id, key: normalizeForCompare(candidate), text, answerability: route.answerability, act: route.act, at: this.clock.now() };
                return;
            }
            this.deliver(id, text, route.answerability, route.act, committedAt);
        } else {
            this.emit({ name: 'auto_answer_ignored', questionId: id, skipReason: 'low_answerability', answerability: route.answerability });
        }
    }

    /** Dispatch now, or retry while the engine is busy — woken early by onEngineIdle. */
    private deliver(id: string, text: string, answerability: number, act: AutoAnswerQuestion['dialogueAct'], committedAt: number): void {
        const deadline = this.clock.now() + RETRY_TTL_MS;
        const seqAtDeliver = this.judgeSeq;
        const attempt = () => {
            if (!this.host.isMeetingActive() || this.judgeSeq !== seqAtDeliver) {
                // Live session 2026-09-03 (13-q6): a verdict of 1.0 was parked
                // behind the engine's own prefetch, the next candidate bumped
                // the sequence, and this branch exited with nothing — no
                // telemetry, no log, no answer. A park was armed, so its death
                // is an outcome and must be reported like every other one.
                // Identity, not mere presence: deliver() arms a new retry timer
                // without clearing the previous one, so a stale attempt closure
                // can still fire while a NEWER, still-valid dispatch holds the
                // park. Nulling that one here would cost it its onEngineIdle
                // fast-wake and mis-attribute the drop to the wrong question.
                const wasParked = this.parkedAttempt === attempt;
                if (wasParked) this.parkedAttempt = null;
                if (wasParked) {
                    const reason = this.host.isMeetingActive() ? 'superseded_while_parked' : 'meeting_inactive';
                    this.host.log?.(`[AutoAnswer:simple] parked dispatch for ${id} dropped: ${reason}${reason === 'superseded_while_parked' ? ` (by ${this.judgeSeqCause ?? 'unknown'})` : ''}`);
                    this.emit({ name: 'auto_answer_ignored', questionId: id, skipReason: reason, answerability });
                }
                return;
            }
            if (!this.host.engineAccepting()) {
                if (this.clock.now() >= deadline) {
                    this.parkedAttempt = null;
                    this.emit({ name: 'auto_answer_ignored', questionId: id, skipReason: 'engine_busy_or_cooling' });
                    return;
                }
                this.parkedAttempt = attempt;
                this.retryTimer = this.clock.setTimeout(attempt, RETRY_MS);
                return;
            }
            // Circuit breaker (see CIRCUIT_BREAKER_* constants and the
            // dispatchTimestamps field for the full rationale): checked here,
            // the actual dispatch chokepoint, so it catches a runaway
            // regardless of which path fed it — judge verdict, fallback
            // dispatch, or a held/superseded verdict re-applying.
            const now = this.clock.now();
            if (now < this.circuitBreakerUntil) {
                this.parkedAttempt = null;
                this.host.log?.(`[AutoAnswer:simple] CIRCUIT BREAKER OPEN — dropping dispatch for ${id} (reopens in ${Math.ceil((this.circuitBreakerUntil - now) / 1000)}s)`);
                this.emit({ name: 'auto_answer_ignored', questionId: id, skipReason: 'circuit_breaker_open', answerability });
                return;
            }
            this.dispatchTimestamps.push(now);
            this.dispatchTimestamps = this.dispatchTimestamps.filter((t) => now - t <= CIRCUIT_BREAKER_WINDOW_MS);
            if (this.dispatchTimestamps.length > CIRCUIT_BREAKER_MAX_DISPATCHES) {
                this.circuitBreakerUntil = now + CIRCUIT_BREAKER_COOLDOWN_MS;
                this.dispatchTimestamps = [];
                this.parkedAttempt = null;
                console.error(
                    `[AutoAnswer:simple] CIRCUIT BREAKER TRIPPED — ${CIRCUIT_BREAKER_MAX_DISPATCHES + 1} dispatches within ${CIRCUIT_BREAKER_WINDOW_MS}ms `
                    + `(not humanly possible from real conversation — this indicates a runaway loop). `
                    + `Pausing auto-answer for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s rather than let it keep firing.`
                );
                this.emit({ name: 'auto_answer_ignored', questionId: id, skipReason: 'circuit_breaker_tripped', answerability });
                return;
            }
            this.parkedAttempt = null;
            const q = this.question(id, text, answerability, act, committedAt);
            // If the engine already has an answer in flight for THIS question
            // (our prefetch, or its own interim speculation keyed by
            // noteCandidate), adopt it instead of starting over — that is the
            // whole point of prefetching.
            const snapshot = this.host.speculativeSnapshot?.();
            const reuseSpeculative = Boolean(snapshot && snapshot.questionId === id && snapshot.text);
            this.lastAnsweredText = text;
            this.pending = [];
            this.lastJudgedKey = '';
            this.emit({ name: 'auto_answer_decision', questionId: id, action: 'auto', answerability });
            if (reuseSpeculative) this.host.log?.(`[AutoAnswer:simple] reusing the prefetched answer for ${id}`);
            this.armFeedback(id, act, answerability);
            void this.host.dispatch(q, { reuseSpeculative });
        };
        attempt();
    }

    private question(id: string, text: string, answerability: number, act: AutoAnswerQuestion['dialogueAct'], committedAt: number): AutoAnswerQuestion {
        const now = this.clock.now();
        return {
            id, text,
            confidence: answerability, answerability, completionConfidence: 1,
            dialogueAct: act,
            isFollowUp: act === 'follow_up_question', followUpTarget: '',
            startedAt: this.pending[0]?.at ?? committedAt, lastUpdatedAt: now, committedAt,
            endpointSource: 'quiet_window',
            sourceSegments: this.pending.map(p => p.at),
            candidateGeneration: this.sequence,
            meetingGeneration: this.host.meetingGeneration(),
        };
    }

    private turnsBefore(cutoff: number): TranscriptTurn[] {
        // Judge context: the hot window minus the pending finals themselves.
        const pendingSet = new Set(this.pending.map(p => normalizeForCompare(p.text)));
        return this.host.recentTurns()
            .filter(t => !(t.role === 'interviewer' && pendingSet.has(normalizeForCompare(t.text))))
            .slice(-JUDGE_CONTEXT_TURNS);
    }

    /**
     * A manual What-to-Answer started. Inside the feedback window that is the
     * user telling us the automatic answer missed; the offer card (if any) is
     * committed either way.
     */
    onManualAnswerStarted(): void {
        const pending = this.feedbackPending;
        if (!pending) return;
        this.clearFeedback();
        const feedbackMs = this.clock.now() - pending.at;
        this.emit({
            name: 'auto_answer_feedback', questionId: pending.id, feedback: 'superseded', feedbackMs,
            dialogueAct: pending.act, answerability: pending.answerability,
        });
        this.host.log?.(`[AutoAnswer:simple] superseded by a manual answer after ${feedbackMs}ms`);
    }

    private armFeedback(id: string, act: AutoAnswerQuestion['dialogueAct'], answerability: number): void {
        this.clearFeedback();
        this.feedbackPending = { id, at: this.clock.now(), act, answerability };
        this.feedbackTimer = this.clock.setTimeout(() => {
            const pending = this.feedbackPending;
            this.feedbackTimer = null;
            this.feedbackPending = null;
            if (!pending) return;
            this.emit({
                name: 'auto_answer_feedback', questionId: pending.id, feedback: 'kept',
                dialogueAct: pending.act, answerability: pending.answerability,
            });
        }, FEEDBACK_WINDOW_MS);
    }

    private clearFeedback(): void {
        if (this.feedbackTimer !== null) { this.clock.clearTimeout(this.feedbackTimer); this.feedbackTimer = null; }
        this.feedbackPending = null;
    }

    private clearRetry(): void {
        if (this.retryTimer !== null) { this.clock.clearTimeout(this.retryTimer); this.retryTimer = null; }
    }

    private dropParked(): void { this.parkedAttempt = null; this.clearRetry(); }

    private reset(): void {
        this.disarm();
        this.dropParked();
        this.clearFeedback();
        this.pending = [];
        this.lastInterviewerInterim = '';
        this.lastInterviewerAt = 0;
        this.speakerByTurn.clear();
        this.lastJudgedKey = '';
        this.lastAnsweredText = null;
        this.lastPrefetchAt = null;
        this.held = null;
        this.bumpJudgeSeq('meeting_reset');
        this.sequence = 0;
    }

    private emit(event: Omit<AutoAnswerTelemetryEvent, 'meetingGeneration'>): void {
        try {
            this.host.telemetry?.({ ...event, meetingGeneration: this.host.meetingGeneration() } as AutoAnswerTelemetryEvent);
        } catch { /* telemetry must never break the pipeline */ }
        if (event.name === 'auto_answer_ignored') this.host.log?.(`[AutoAnswer:simple] skipped: ${event.skipReason}${event.questionId ? ` (${event.questionId})` : ''}`);
    }
}
