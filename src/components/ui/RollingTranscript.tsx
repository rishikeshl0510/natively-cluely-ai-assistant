import React, { useEffect, useRef } from 'react';
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
                        className="max-h-[4.5em] overflow-y-auto overflow-x-hidden overlay-transcript-surface transition-all duration-500 text-left"
                        style={surfaceStyle}
                    >
                        {showTranscriptText && (
                            <div>
                                <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--overlay-text-muted)] mb-0.5">
                                    {t('Question')}
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
                            className="max-h-[4.5em] overflow-y-auto overflow-x-hidden overlay-transcript-surface transition-all duration-500 text-left"
                            style={surfaceStyle}
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