import React, { useEffect, useRef } from 'react';
import { Mic } from 'lucide-react';
import { useT } from '../../i18n';

interface ChannelStatus {
    status: 'connected' | 'reconnecting' | 'failed' | 'awaiting-audio';
    error?: string;
    provider?: string;
}

interface RollingTranscriptProps {
    text: string;
    isActive?: boolean;
    surfaceStyle?: React.CSSProperties;
    interviewerChannel?: ChannelStatus;
    microphoneChannel?: ChannelStatus;
    /** Teleprompter dual-channel feed (live-overlay-ui-spec.md Section 1.6):
     *  the user's own mic speech, live, alongside the interviewer line above.
     *  Optional so any other mount of this component (if one exists) keeps
     *  working single-channel with no prop changes required. */
    userText?: string;
    isUserActive?: boolean;
    /** Human-readable label for the mic-channel line. Defaults to "You" —
     *  overridable once Settings gains a per-speaker display-name option
     *  (Section 2/3 follow-up). */
    userLabel?: string;
}

const RollingTranscript: React.FC<RollingTranscriptProps> = ({
    text, isActive = true, surfaceStyle,
    interviewerChannel, microphoneChannel,
    userText, isUserActive = true, userLabel,
}) => {
    const t = useT();
    const containerRef = useRef<HTMLDivElement>(null);
    const userContainerRef = useRef<HTMLDivElement>(null);

    const intStatus = interviewerChannel?.status ?? 'connected';
    const micStatus = microphoneChannel?.status ?? 'connected';
    const anyAwaitingAudio = intStatus === 'awaiting-audio' || micStatus === 'awaiting-audio';
    const isNormal = intStatus === 'connected' && micStatus === 'connected' && !anyAwaitingAudio;
    const showTranscriptText = intStatus !== 'failed' && micStatus !== 'failed';
    const showUserLine = userText !== undefined && micStatus !== 'failed';

    // Mic capture confirmation (2026-09-15): the app's one other STT status
    // pill is deliberately suppressed whenever everything is healthy (see
    // NativelyInterface.tsx's shouldShowSttSummaryPill — "only surface for
    // genuine problems"), so there was NO positive "yes, your mic is being
    // heard" signal anywhere during a live meeting, only silence when fine
    // and an error pill when not. This is a small, always-visible dot (not
    // gated on an error) using the SAME microphoneChannel prop this
    // component already receives — no new backend/IPC plumbing.
    const micDotClass =
        micStatus === 'connected' ? 'bg-emerald-400/80 animate-pulse'
            : micStatus === 'awaiting-audio' ? 'bg-amber-400/80'
                : micStatus === 'reconnecting' ? 'bg-amber-400/80 animate-pulse'
                    : 'bg-red-400/80';
    const micStatusLabel =
        micStatus === 'connected' ? t('Your mic is being captured')
            : micStatus === 'awaiting-audio' ? t('Waiting for your mic…')
                : micStatus === 'reconnecting' ? t('Reconnecting your mic…')
                    : t('Your mic is not being captured');

    // Wrapped multi-line teleprompter feed (not a horizontal-scroll ticker
    // anymore — the previous whitespace-nowrap + scrollLeft design put the
    // full transcript on one long line running off-screen). Each line
    // auto-scrolls its OWN vertical overflow to the bottom as new text
    // commits, so the latest words stay in view within the panel's bounds.
    useEffect(() => {
        if (containerRef.current && showTranscriptText && text) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
    }, [text, showTranscriptText]);

    useEffect(() => {
        if (userContainerRef.current && showUserLine && userText) {
            userContainerRef.current.scrollTop = userContainerRef.current.scrollHeight;
        }
    }, [userText, showUserLine]);

    return (
        <div className="relative w-full">
            <div className="relative w-full">
                <div className="w-[90%] mx-auto pt-2 space-y-1.5">
                    <div
                        ref={containerRef}
                        // No fixed max-height (2026-09-15): removed the old
                        // hardcoded max-h-[4.5em] clamp so the panel grows
                        // with content instead of hiding most of it behind a
                        // tiny fixed window. overflow-y-auto stays as a
                        // SAFETY NET, not a clamp — it does nothing while
                        // there is room to grow; it only engages if the real
                        // ceiling (the main-process window-height clamp,
                        // reportShellSize's workArea.height*0.9 budget) is
                        // actually hit, so content becomes scrollable instead
                        // of silently clipped by the shell's overflow-hidden
                        // with no way to reach the rest (confirmed live —
                        // removing overflow-y-auto entirely caused exactly
                        // that). scrollbarWidth 'thin' keeps it visible/
                        // discoverable, same fix as the answer area.
                        className="overflow-y-auto overlay-transcript-surface transition-all duration-500 text-left"
                        style={{ ...surfaceStyle, scrollbarWidth: 'thin' }}
                    >
                        {showTranscriptText && (
                            <div>
                                <div className="flex items-center justify-between mb-0.5">
                                    <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--overlay-text-muted)]">
                                        {t('Question')}
                                    </div>
                                    <div className="flex items-center gap-1" title={micStatusLabel}>
                                        <Mic className="w-2.5 h-2.5 text-[var(--overlay-text-muted)] opacity-60" />
                                        <span className={`w-[5px] h-[5px] rounded-full ${micDotClass}`} />
                                    </div>
                                </div>
                                <span className="text-[13px] italic leading-7 text-[var(--overlay-text-muted)] transition-all duration-300 whitespace-pre-wrap break-words">
                                    {text || t('Listening…')}
                                    {isActive && isNormal && (
                                        <span className="inline-flex items-center ml-2 align-middle">
                                            <span className="w-[3px] h-[3px] bg-emerald-400/70 rounded-full animate-pulse" />
                                        </span>
                                    )}
                                </span>
                            </div>
                        )}
                    </div>
                    {showUserLine && (
                        <div
                            ref={userContainerRef}
                            // No fixed max-height (2026-09-15): removed the old
                        // hardcoded max-h-[4.5em] clamp so the panel grows
                        // with content instead of hiding most of it behind a
                        // tiny fixed window. overflow-y-auto stays as a
                        // SAFETY NET, not a clamp — it does nothing while
                        // there is room to grow; it only engages if the real
                        // ceiling (the main-process window-height clamp,
                        // reportShellSize's workArea.height*0.9 budget) is
                        // actually hit, so content becomes scrollable instead
                        // of silently clipped by the shell's overflow-hidden
                        // with no way to reach the rest (confirmed live —
                        // removing overflow-y-auto entirely caused exactly
                        // that). scrollbarWidth 'thin' keeps it visible/
                        // discoverable, same fix as the answer area.
                        className="overflow-y-auto overlay-transcript-surface transition-all duration-500 text-left"
                        style={{ ...surfaceStyle, scrollbarWidth: 'thin' }}
                        >
                            <span className="text-[13px] leading-7 text-[var(--overlay-text-primary)] transition-all duration-300 whitespace-pre-wrap break-words">
                                <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--overlay-text-muted)] mr-1.5">
                                    {userLabel || 'You'}
                                </span>
                                {userText || ''}
                                {isUserActive && isNormal && (
                                    <span className="inline-flex items-center ml-2 align-middle">
                                        <span className="w-[3px] h-[3px] bg-blue-400/70 rounded-full animate-pulse" />
                                    </span>
                                )}
                            </span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default RollingTranscript;