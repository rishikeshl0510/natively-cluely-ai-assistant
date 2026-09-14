import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { safeDetachAndClose } from './wsSafeTeardown';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RECOGNITION_LANGUAGES } from '../config/languages';
import { streamingStttWsOptions } from './dnsHelpers';

const ELEVENLABS_WS_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
// Cap reconnect attempts so a flapping network can't drive an indefinite WS
// open-loop against ElevenLabs (storm risk + per-key rate-limit risk). After
// the cap, emit 'error' so the orchestrator can surface a UI prompt; a
// user-triggered restart via stop()/start() resets the counter to 0.
const RECONNECT_MAX_ATTEMPTS = 10;

// Same RMS threshold OpenAIStreamingSTT.ts uses for its REST-fallback silence
// skip (_isSilent/SILENCE_RMS_THRESHOLD) — reused here so both providers agree
// on what "silence" means rather than each guessing a different number.
const SILENCE_RMS_THRESHOLD = 50;
// How many CONSECUTIVE silent 250ms buffers (SEND_THRESHOLD_SAMPLES worth)
// must pass before we actually start skipping sends. This is a hangover, not
// an instant cutoff: stopping the moment one buffer dips below the threshold
// would clip the trailing edge of real speech (a word's quiet final
// consonant, a natural micro-pause mid-sentence). 3 buffers (~750ms) is
// comfortably past a normal pause but still short enough that we're not
// billing/streaming multiple seconds of true dead air before the skip kicks
// in. Resuming is NOT hung over — the very next non-silent buffer sends
// immediately, since missing the start of real speech is much worse than an
// extra silent buffer or two.
const SILENCE_HANGOVER_BUFFERS = 3;

// Local end-of-utterance detection (2026-09-14). Live traces (channel-tagged,
// connectionAgeMs logged) proved ElevenLabs recycles this endpoint's
// connection roughly every 15.5s regardless of what we send or configure —
// confirmed NOT caused by our own silence-skip (removed) or by
// handshakeTimeout (tested directly, ruled out) — so it looks like genuine
// server-side behavior outside our control. Until now the ONLY thing that
// promoted a pending partial_transcript to a real `final: true` segment was
// that recycle's close handler below — meaning a long answer sat un-processed
// for up to ~15.5s in the worst case, the direct cause of the reported "long
// silent pause" before anything appeared. This value makes the app detect
// "the interviewer stopped talking" itself instead of waiting on the
// connection: same threshold as SimpleAutoAnswer.ts's STABILITY_MS, since
// that constant is already the tuned, live-validated answer to exactly this
// question elsewhere in the app — reusing it here means this fires on real
// pauses, not on a breath. (A cruder ~750ms version of this same idea was
// tried once before and reverted for firing on every mid-sentence breath;
// this reuses the value proven safe for the PRIMARY trigger path instead of
// re-guessing a number.) The close-handler promotion stays as the fallback
// for the case this local timer is trying to cover for — a recycle landing
// before it fires — not the primary mechanism it was until now.
const LOCAL_SILENCE_PROMOTE_MS = 1200;

/** RMS-based silence check, same threshold/sampling approach as OpenAIStreamingSTT._isSilent — sampling every 20th value keeps this cheap even on a large combined buffer. Exported (pure, no class state) so it's unit-testable without a WebSocket mock. */
export function isSilentPcmBuffer(pcm: Int16Array, thresholdRms: number = SILENCE_RMS_THRESHOLD): boolean {
    let sum = 0;
    let count = 0;
    const step = 20;
    for (let i = 0; i < pcm.length; i += step) {
        const sample = pcm[i];
        sum += sample * sample;
        count++;
    }
    if (count === 0) return true;
    return Math.sqrt(sum / count) < thresholdRms;
}

/**
 * Given the running count of consecutive silent buffers (already updated to
 * include the current buffer) and the hangover threshold, decide whether the
 * CURRENT send should be skipped. Pure function — see isSilentPcmBuffer for
 * why this is split out of the class.
 */
export function shouldSkipSilentSend(consecutiveSilentBuffers: number, hangoverBuffers: number = SILENCE_HANGOVER_BUFFERS): boolean {
    return consecutiveSilentBuffers > hangoverBuffers;
}

export class ElevenLabsStreamingSTT extends EventEmitter {
    private apiKey: string;
    private ws: WebSocket | null = null;
    private isActive = false;
    private shouldReconnect = false;
    private reconnectAttempts = 0;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private inputSampleRate = 48000; // what the mic/system audio captures at
    private targetSampleRate = 16000; // what ElevenLabs Scribe v2 requires
    
    private buffer: Buffer[] = [];
    private isConnecting = false;
    private isSessionReady = false;
    private languageCode = 'en'; // Default to English
    // Latest partial_transcript text not yet superseded by a committed_transcript
    // for it — cleared on every committed_transcript and on connect(). If this
    // is still non-empty when the socket closes, whatever the speaker just said
    // never got a final transcript, and SimpleAutoAnswerEngine never saw it (it
    // only acts on `final: true` segments) — the close handler below logs this
    // loudly instead of silently dropping it, since this is exactly the failure
    // mode behind "asked a question, got no answer, and it wasn't reported".
    private lastUncommittedPartial = '';
    // Armed on every partial_transcript, cancelled on committed_transcript —
    // see LOCAL_SILENCE_PROMOTE_MS above.
    private localSilenceTimer: NodeJS.Timeout | null = null;

    private debugWriteStream: fs.WriteStream | null = null;
    
    // Chunk buffering properties (250ms @ 16k = 4000 samples)
    private pcmAccumulator: Int16Array[] = [];
    private pcmAccumulatorLen = 0;
    private readonly SEND_THRESHOLD_SAMPLES = 4000;

    private debugMessageCount = 0;
    // Count of consecutive silent buffers seen so far (see SILENCE_HANGOVER_BUFFERS).
    private consecutiveSilentBuffers = 0;

    // Diagnostic-only (2026-09-14): interviewer-channel and user-channel STT run
    // as two separate instances of this class simultaneously (main.ts's
    // googleSTT / googleSTT_User), and until now every instance logged through
    // the identical unlabeled "[ElevenLabsStreaming]" prefix — a live capture
    // showing frequent "Closed: code=1000" reconnects was IMPOSSIBLE to attribute
    // to one connection or the other, or to line up a Connecting/Closed pair
    // with confidence. label distinguishes the two in every log line below;
    // connectStartedAt lets the close handler report exact connection age
    // instead of requiring manual timestamp arithmetic across possibly
    // interleaved instances.
    private channelLabel: string;
    private connectStartedAt = 0;

    constructor(apiKey: string, label: string = '') {
        super();
        this.apiKey = apiKey;
        this.channelLabel = label;

        // Open a debug file only in development to avoid disk fill-up in production
        if (process.env.NODE_ENV === 'development') {
            try {
                const debugPath = path.join(os.homedir(), 'elevenlabs_debug.raw');
                this.debugWriteStream = fs.createWriteStream(debugPath);
                console.log(`[ElevenLabsStreaming] Audio debug stream opened at: ${debugPath}`);
            } catch (e) {
                console.error('[ElevenLabsStreaming] Failed to open debug stream:', e);
            }
        }
    }

    /** See channelLabel's declaration comment. */
    private tag(): string {
        return this.channelLabel ? `[ElevenLabsStreaming:${this.channelLabel}]` : '[ElevenLabsStreaming]';
    }

    /** Restart the LOCAL_SILENCE_PROMOTE_MS countdown — called on every partial_transcript. */
    private armLocalSilenceTimer(): void {
        this.clearLocalSilenceTimer();
        this.localSilenceTimer = setTimeout(() => {
            this.localSilenceTimer = null;
            this.promoteUncommittedPartialToFinal('local_silence');
        }, LOCAL_SILENCE_PROMOTE_MS);
    }

    private clearLocalSilenceTimer(): void {
        if (this.localSilenceTimer) {
            clearTimeout(this.localSilenceTimer);
            this.localSilenceTimer = null;
        }
    }

    /**
     * Promote whatever's sitting in lastUncommittedPartial to a real
     * `final: true` transcript segment. Shared by the local-silence timer
     * (the normal path now) and the 'close' handler below (the fallback, for
     * a recycle that lands before the local timer fires) — identical
     * behavior either way, so SimpleAutoAnswerEngine sees the same shape of
     * event regardless of which one triggered it.
     */
    private promoteUncommittedPartialToFinal(reason: 'local_silence' | 'connection_closed'): void {
        if (!this.lastUncommittedPartial) return;
        const text = this.lastUncommittedPartial;
        this.lastUncommittedPartial = '';
        this.clearLocalSilenceTimer();
        console.warn(`${this.tag()} Promoting uncommitted partial to final (${reason}): "${text}"`);
        this.emit('transcript', { text, isFinal: true, confidence: 1.0 });
    }

    public setSampleRate(rate: number): void {
        this.inputSampleRate = rate;
        console.log(`[ElevenLabsStreaming] Input sample rate set to ${rate}Hz`);
        // We always downsample to 16000Hz for ElevenLabs
    }

    /** No-op - channel count is expected to be mono by ElevenLabs Scribe */
    public setAudioChannelCount(_count: number): void {}

    /** Recognition language - maps Natively key to ISO-639-1 for ElevenLabs, or 'auto' to omit code */
    public setRecognitionLanguage(key: string): void {
        const newCode = key === 'auto' ? '' : (RECOGNITION_LANGUAGES[key]?.iso639 ?? this.languageCode);
        if (this.languageCode !== newCode) {
            console.log(`[ElevenLabsStreaming] Language changed: ${this.languageCode || '(auto)'} -> ${newCode || '(auto)'}`);
            this.languageCode = newCode;
            if (this.isActive) {
                console.log('[ElevenLabsStreaming] Restarting session to apply new language...');
                this.stop();
                this.start();
            }
        }
    }

    /** No-op - credentials passed via API key */
    public setCredentials(_path: string): void {}

    public start(): void {
        if (this.isActive) return;
        if (this.isConnecting) return; // Already mid-connect (prevents double-connect race)
        this.isActive = true;          // Set immediately so write() buffers audio during WS handshake
        this.shouldReconnect = true;
        this.reconnectAttempts = 0;
        this.connect();
    }

    public stop(): void {
        this.shouldReconnect = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            // safeDetachAndClose (F-201): setRecognitionLanguage does
            // stop()+start(), so this runs mid-handshake — a CONNECTING
            // socket's abort error must not escape listener-less.
            safeDetachAndClose(this.ws);
            this.ws = null;
        }
        this.isActive = false;
        this.isConnecting = false;
        this.isSessionReady = false;
        this.buffer = [];
        this.pcmAccumulator = [];
        this.pcmAccumulatorLen = 0;
        this.consecutiveSilentBuffers = 0;
        this.lastUncommittedPartial = '';
        this.clearLocalSilenceTimer();
        if (this.debugWriteStream) {
            this.debugWriteStream.end();
            this.debugWriteStream = null;
        }
        console.log('[ElevenLabsStreaming] Stopped');
    }

    public finalize(): void {
        if (!this.isActive || !this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isSessionReady) return;

        if (this.pcmAccumulatorLen > 0) {
            const combined = new Int16Array(this.pcmAccumulatorLen);
            let offset = 0;
            for (const arr of this.pcmAccumulator) {
                combined.set(arr, offset);
                offset += arr.length;
            }
            this.pcmAccumulator = [];
            this.pcmAccumulatorLen = 0;
            try {
                this.ws.send(JSON.stringify({
                    message_type: 'input_audio_chunk',
                    audio_base_64: Buffer.from(combined.buffer, combined.byteOffset, combined.byteLength).toString('base64'),
                }));
                console.log('[ElevenLabsStreaming] Finalize — flushed pending accumulator');
            } catch (err) {
                console.error('[ElevenLabsStreaming] Finalize flush failed:', err);
            }
        }
    }

    /**
     * Flush buffered audio (accumulated while disconnected — see write()'s
     * buffering branch) in small batches across multiple event-loop ticks,
     * never all at once.
     *
     * "Always crashes right after session_started" (2026-09, repeated live
     * reports): this used to be a single synchronous `while` loop draining
     * the WHOLE buffer (up to its 500-chunk cap) the instant session_started
     * arrived. Each chunk's write() does real work — resampling, an RMS
     * silence check, JSON.stringify, base64 encoding, a ws.send() — so a
     * large backlog (built up during a longer outage, or several reconnects
     * in quick succession, both of which this session has seen repeatedly)
     * turned session_started into a genuinely expensive synchronous burst
     * with no yield point, on the exact code path fired by EVERY reconnect.
     * That is a plausible, previously-unconsidered explanation for a hang
     * whose only consistent signature was "the last log line is always
     * session_started" — this is the one thing that reliably runs
     * immediately after it. Batching across setImmediate ticks bounds the
     * synchronous cost of any single tick regardless of how large the
     * backlog is, so a big buffer drains over several event-loop turns
     * instead of blocking one of them for all of it.
     */
    // Tradeoff, stated plainly: spreading this across ticks means a
    // genuinely NEW chunk arriving mid-flush (the connection is ready, so a
    // fresh write() call sends it immediately) could reach the server
    // slightly ahead of older backlogged chunks still draining — the
    // original single-tick loop had no such window. In practice the whole
    // flush resolves in a handful of setImmediate ticks (sub-millisecond
    // each when the event loop isn't already blocked, which is the
    // situation this exists to prevent), so the reordering window is brief.
    // Preferred over the alternative (blocking the event loop for however
    // long the full backlog takes) given the reported symptom is a hang, not
    // a transcription-ordering complaint.
    private flushBufferAsync(): void {
        const BATCH_SIZE = 20;
        let n = 0;
        while (n < BATCH_SIZE && this.buffer.length > 0) {
            const chunk = this.buffer.shift();
            if (chunk) this.write(chunk);
            n++;
        }
        if (this.buffer.length > 0) {
            setImmediate(() => this.flushBufferAsync());
        }
    }

    /**
     * Write raw PCM audio data.
     * ElevenLabs WebSocket expects "input_audio_chunk" in base64 16-bit PCM.
     * Note: Input from Natively DSP is 32-bit Float PCM (F32).
     */
    public write(chunk: Buffer): void {
        if (!this.isActive) return;

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isSessionReady) {
            this.buffer.push(chunk);
            if (this.buffer.length > 500) {
                this.buffer.shift(); // Cap buffer size
                console.warn('[ElevenLabsStreaming] Buffer full — oldest audio chunk dropped.');
            }

            if (!this.isConnecting && this.shouldReconnect && !this.reconnectTimer) {
                console.log('[ElevenLabsStreaming] WS not ready. Lazy connecting on new audio...');
                this.connect();
            }
            return;
        }

        // Snapshot ws reference before async operations to guard against concurrent close
        const ws = this.ws;

        try {
            // The input buffer from the native module is ALREADY 16-bit PCM (Int16LE).
            // Do NOT read it as Float32.
            const inputS16 = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 2);
            
            let outputS16: Int16Array;

            if (this.inputSampleRate === this.targetSampleRate) {
                // No downsampling needed
                outputS16 = inputS16;
            } else {
                // Downsample from inputSampleRate (e.g. 48000) to 16000Hz
                const downsampleFactor = this.inputSampleRate / this.targetSampleRate;
                const outputLength = Math.floor(inputS16.length / downsampleFactor);
                outputS16 = new Int16Array(outputLength);

                for (let i = 0; i < outputLength; i++) {
                    // Simple decimation (take every Nth sample)
                    outputS16[i] = inputS16[Math.floor(i * downsampleFactor)];
                }
            }

            // Write to debug file
            if (this.debugWriteStream) {
                // Use full slice args to avoid copying the whole backing ArrayBuffer
                this.debugWriteStream.write(Buffer.from(outputS16.buffer, outputS16.byteOffset, outputS16.byteLength));
            }

            // Accumulate
            this.pcmAccumulator.push(outputS16);
            this.pcmAccumulatorLen += outputS16.length;

            if (this.pcmAccumulatorLen >= this.SEND_THRESHOLD_SAMPLES) {
                // Combine
                const combined = new Int16Array(this.pcmAccumulatorLen);
                let offset = 0;
                for (const arr of this.pcmAccumulator) {
                    combined.set(arr, offset);
                    offset += arr.length;
                }

                // Reset
                this.pcmAccumulator = [];
                this.pcmAccumulatorLen = 0;

                // Silence gating USED to skip the send once SILENCE_HANGOVER_BUFFERS
                // consecutive buffers were confirmed silent, to save the
                // per-message cost/bandwidth of streaming dead air. REMOVED
                // (2026-09-14, root-caused the frequent "Closed: code=1000"
                // reconnect churn — every ~13s in a live session, confirmed via
                // debug log): ElevenLabs' realtime STT keepalive contract is a
                // ~5s send interval / ~10s idle timeout (per their own help
                // center, "How can I keep the WebSocket open"), independent of
                // the `inactivity_timeout` query param — that param bounds a
                // DIFFERENT, longer idle window, and does not cover this. Any
                // real conversational pause past ~750ms (this hangover) used to
                // stop sending entirely, so a normal multi-second silence
                // (interviewer listening, user thinking) reliably starved the
                // 10s keepalive and killed the session — the server-side close
                // that made a long, already-finished question sit un-committed
                // until the NEXT reconnect happened to land. Sending continuously
                // (silence included) is exactly ElevenLabs' documented fix:
                // keep the connection open for the life of the meeting instead
                // of tearing it down and rebuilding it mid-conversation.
                // isSilentPcmBuffer/consecutiveSilentBuffers/shouldSkipSilentSend
                // are left in place (still unit-tested, still meaningful) in
                // case a future bandwidth-conscious mode wants them; they are
                // simply no longer consulted before sending.
                if (isSilentPcmBuffer(combined)) {
                    this.consecutiveSilentBuffers++;
                } else {
                    this.consecutiveSilentBuffers = 0;
                }

                const base64 = Buffer.from(combined.buffer, combined.byteOffset, combined.byteLength).toString('base64');
                // ElevenLabs Scribe v2 requires fields message_type and audio_base_64
                // Use the snapshot captured earlier to avoid null-dereference from concurrent close
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        message_type: 'input_audio_chunk',
                        audio_base_64: base64,
                    }));
                }
            }
        } catch (err) {
            console.warn('[ElevenLabsStreaming] write failed:', err);
        }
    }

    private connect(): void {
        if (this.isConnecting) return;
        this.isConnecting = true;
        this.isSessionReady = false;
        this.connectStartedAt = Date.now();

        console.log(`${this.tag()} Connecting`, { hasApiKey: Boolean(this.apiKey) });

        // raw WebSocket URL with parameters
        let url = `${ELEVENLABS_WS_URL}?model_id=scribe_v2_realtime&include_timestamps=true&sample_rate=${this.targetSampleRate}`;

        // Always enable language detection metadata; only pin to a specific code when one is set
        if (this.languageCode) {
            url += `&language_code=${this.languageCode}`;
        }
        url += `&include_language_detection=true`;
        // inactivity_timeout (2026-09): ElevenLabs' realtime endpoint defaults
        // this to 20 SECONDS when the param is omitted (per their own docs).
        // Set to the documented maximum (180s) on the theory that a
        // conversational pause was tripping server-side inactivity detection.
        //
        // STATUS (2026-09-14): live traces after this fix, AND after also
        // removing the client-side silence-skip in write() (so audio streams
        // continuously, silence included — see the removed skipSend gate
        // above), still show "Closed: code=1000" roughly every 15-20s. Neither
        // change measurably reduced the close frequency, so inactivity is NOT
        // the confirmed cause — it may not be inactivity at all. Left in place
        // (harmless, and correct per the docs regardless), but do not treat it
        // as a fix for the reconnect-cycling symptom until proven otherwise.
        // channelLabel/connectStartedAt above exist so the NEXT trace can
        // attribute each close to a specific connection with its exact age,
        // instead of guessing from interleaved, unlabeled timestamps.
        url += `&inactivity_timeout=180`;

        console.log(`${this.tag()} Connecting with URL: ${url.replace(this.apiKey, '***')}`);

        // streamingStttWsOptions: IPv4-only DNS + 15s handshake cap (dnsHelpers.ts).
        this.ws = new WebSocket(url, streamingStttWsOptions({
            headers: {
                'xi-api-key': this.apiKey,
            },
        }) as any);

        this.ws.on('open', () => {
            // Guard: stop() calls removeAllListeners() before closing, so this handler
            // normally won't fire after stop(). But if there's a narrow race, bail out.
            if (!this.isActive || !this.shouldReconnect) {
                this.ws?.close();
                this.ws = null;
                this.isConnecting = false;
                return;
            }
            this.isConnecting = false;
            this.reconnectAttempts = 0;
            console.log(`${this.tag()} Connected`);

            // Note: ElevenLabs requires waiting for 'session_started' before sending audio.
            // Buffer flush happens in the 'session_started' message handler below.
        });

        this.ws.on('message', (data: WebSocket.RawData) => {
            try {
                const rawStr = data.toString();
                if (this.debugMessageCount < 10) {
                    console.log(`[ElevenLabsStreaming] RAW[${this.debugMessageCount}]:`, rawStr);
                    this.debugMessageCount++;
                }

                const msg = JSON.parse(rawStr);

                // Note: The websocket API might use "type" or "message_type"
                const msgType = msg.type || msg.message_type;

                switch (msgType) {
                    case 'session_started':
                        console.log(`${this.tag()} Session started:`, msg.config);
                        this.isSessionReady = true;
                        this.flushBufferAsync();
                        break;

                    case 'partial_transcript':
                        if (msg.text) {
                            this.lastUncommittedPartial = msg.text;
                            this.armLocalSilenceTimer();
                            this.emit('transcript', {
                                text: msg.text,
                                isFinal: false,
                                confidence: 1.0
                            });
                        }
                        break;

                    case 'committed_transcript':
                        // Always logged, unconditionally — unlike the RAW[n] dump above
                        // (capped at the first 10 messages to avoid noise), a missing
                        // final transcript is exactly the failure mode that's hardest to
                        // diagnose after the fact ("no response to a question that was
                        // clearly asked"): with the cap, a committed_transcript arriving
                        // as e.g. the 11th message on a busy connection was invisible,
                        // so there was no way to tell "it never committed" from "it
                        // committed but SimpleAutoAnswerEngine didn't act on it".
                        console.log(`[ElevenLabsStreaming] committed_transcript: "${msg.text}"`);
                        this.lastUncommittedPartial = '';
                        this.clearLocalSilenceTimer();
                        if (msg.text) {
                            this.emit('transcript', {
                                text: msg.text,
                                isFinal: true,
                                confidence: 1.0
                            });
                        }
                        break;

                    case 'auth_error':
                        console.error('[ElevenLabsStreaming] Auth error — check key scope/permissions in ElevenLabs dashboard:', msg);
                        this.emit('error', msg);
                        // Stop reconnection loops for auth failures to save API credits.
                        // Also clear any queued reconnect timer (write()'s lazy-connect or
                        // a prior close-handler enqueue) so we don't get a stray connect()
                        // attempt after the latch flips.
                        this.shouldReconnect = false;
                        if (this.reconnectTimer) {
                            clearTimeout(this.reconnectTimer);
                            this.reconnectTimer = null;
                        }
                        if (this.ws) {
                            this.ws.close();
                        }
                        break;

                    default:
                        // Log other messages for debugging (e.g. metadata or unknowns)
                        if (msg.error) {
                            console.error('[ElevenLabsStreaming] Server error:', msg.error);
                            this.emit('error', msg.error);
                        } else {
                            console.log('[ElevenLabsStreaming] Received message:', msgType, Object.keys(msg));
                        }
                }
            } catch (err) {
                console.error('[ElevenLabsStreaming] Failed to parse message:', err);
            }
        });

        this.ws.on('close', (code, reason) => {
            // Null out the ws reference immediately to prevent stale reuse
            this.ws = null;
            this.isConnecting = false;
            this.isSessionReady = false;
            const ageMs = this.connectStartedAt ? Date.now() - this.connectStartedAt : -1;
            console.log(`${this.tag()} Closed: code=${code} reason=${reason} connectionAgeMs=${ageMs}`);
            // "No response to a question that was clearly asked" (2026-09):
            // the server can close a session (even a clean code=1000) with
            // speech still sitting in an uncommitted partial_transcript, and
            // since SimpleAutoAnswerEngine only acts on `final: true`
            // segments, that utterance is otherwise silently lost.
            //
            // History: promote-to-final here was added, reverted (app became
            // unresponsive), re-added after root-causing that freeze to an
            // UNRELATED change (the reveal-pacer rate cap, confirmed fixed),
            // reverted again anyway out of caution, then re-added once more.
            //
            // STATUS (2026-09-14): `inactivity_timeout=180`, removing the
            // client-side silence-skip in write(), and raising
            // handshakeTimeout were ALL tried and ruled out — live traces
            // still show "Closed: code=1000" at a near-constant ~15.5s,
            // confirmed genuine server-side recycling outside our control
            // (see dnsHelpers.ts's streamingStttWsOptions comment for the
            // handshakeTimeout test). Since a normal committed_transcript
            // often never arrives before the next recycle, this used to be
            // the PRIMARY way most utterances ever got finalized — up to
            // ~15.5s of dead air before anything happened. armLocalSilenceTimer
            // (see partial_transcript above) now does that job properly,
            // promoting after LOCAL_SILENCE_PROMOTE_MS of real quiet instead
            // of waiting on a recycle. This close-handler call is back to
            // being the fallback it was meant to be — it only still does
            // anything if a recycle happens to land inside that same ~1.2s
            // window, which promoteUncommittedPartialToFinal's own
            // already-empty check makes a safe no-op either way.
            this.promoteUncommittedPartialToFinal('connection_closed');
            // Bug fix (2026-09, "next question stops being transcribed"):
            // this used to also require code !== 1000 before reconnecting —
            // treating ANY normal closure as "we're done", even when
            // shouldReconnect was still true (i.e. stop() was never called).
            // WebSocket ASR APIs commonly close sessions normally (code 1000)
            // for reasons that have nothing to do with the CALLER wanting to
            // stop — idle windows, session-length limits, server-side
            // recycling — and each session_started message in this file's
            // own logs carries a fresh session_id, consistent with the
            // server periodically ending and expecting a reconnect. stop()
            // already sets shouldReconnect=false BEFORE closing the socket
            // (see stop() above), so that flag alone is the correct signal
            // for "we intentionally stopped" — code is not a reliable
            // second signal on top of it, and excluding 1000 permanently
            // killed transcription on the next normal server-side close.
            if (this.shouldReconnect) {
                this.scheduleReconnect(code);
            } else {
                // If not reconnecting, mark session as truly inactive
                this.isActive = false;
            }
        });

        this.ws.on('error', (err) => {
            console.error('[ElevenLabsStreaming] WS error:', err);
            this.emit('error', err);
        });
    }

    private scheduleReconnect(closeCode?: number): void {
        if (!this.shouldReconnect) return;

        if (this.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
            console.error(`${this.tag()} Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached — giving up`);
            // Latch off the reconnect path so write()'s lazy-connect (line 154)
            // cannot resurrect the storm on the next audio chunk. start() resets
            // shouldReconnect=true so a user-triggered restart still works.
            // Mirrors the auth_error pattern at line ~317.
            this.shouldReconnect = false;
            this.emit('error', new Error('ElevenLabsStreamingSTT: max reconnect attempts exceeded'));
            return;
        }

        // A clean code=1000 close on the FIRST attempt is the routine
        // server-side recycle this file's history already documents (see the
        // 'close' handler's comment: "each session_started message... carries
        // a fresh session_id, consistent with the server periodically ending
        // and expecting a reconnect") — not a failure. The full exponential
        // backoff below exists to stop hammering a server during a genuine
        // outage; applying it to an EXPECTED, routine recycle just adds dead
        // air to every cycle for no protective reason (2026-09-14: measured
        // recycles every ~15-20s, so a full guaranteed 1000ms+ gap on each one
        // is a real, avoidable chunk of the "long silent pause before
        // anything appears" symptom). Reconnect near-instantly for this case;
        // fall back to real backoff the moment a code=1000 reconnect itself
        // fails to establish (reconnectAttempts > 0 by then), or for any
        // non-1000/error close, exactly as before.
        const isRoutineRecycle = closeCode === 1000 && this.reconnectAttempts === 0;
        const delay = isRoutineRecycle ? 150 : Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
        this.reconnectAttempts++;

        console.log(`${this.tag()} Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})${isRoutineRecycle ? ' [routine recycle, no backoff]' : ''}...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.shouldReconnect) {
                this.connect();
            }
        }, delay);
    }
}
