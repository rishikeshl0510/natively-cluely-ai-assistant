import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Info } from 'lucide-react';
import { useT } from '../../i18n';
import { AipSwitch, AIP_CSS } from './AIProvidersSettings';

/**
 * Screen & Vision — pulled out of AI Providers > Privacy and Intelligence >
 * Customize into its own top-level Settings tab (2026-09-28, user request:
 * these were "buried" two tabs deep). This component OWNS its own copies of
 * the state it needs rather than sharing React state with AIProvidersSettings
 * — every value here is IPC-backed (electronAPI getters/setters are the real
 * source of truth in the main process), so an independent fetch is the same
 * pattern already used throughout this settings surface, not a duplication of
 * authority. AIProvidersSettings keeps its own `providerDataScopes`/
 * `localFallback` state for the (unrelated, staying-put) Cloud Provider Data
 * Scopes card.
 */
export const ScreenVisionSettings: React.FC = () => {
    const t = useT();

    // --- Screen Understanding (vision routing) — moved verbatim from AIProvidersSettings ---
    const [screenUnderstandingMode, setScreenUnderstandingMode] = useState<'vision_first' | 'vision_only' | 'private_vision'>('vision_first');
    const [technicalInterviewVisionFirst, setTechnicalInterviewVisionFirst] = useState<boolean>(true);

    // Read-only local copies, just for this card's conditional messaging (see
    // the file header note on why these are fetched independently).
    const [providerScreenshotsScope, setProviderScreenshotsScope] = useState<boolean | undefined>(undefined);
    const [localFallbackVision, setLocalFallbackVision] = useState(false);

    // `screenUnderstandingMode` is one enum with three values, but it answers two
    // independent user questions. Presenting it as three radios forced the user to
    // read our provider-fallback architecture; presenting it as two switches asks
    // what they actually care about.
    //
    //   local-only OFF + require OFF  -> 'vision_first'   (cascade, most permissive)
    //   local-only OFF + require ON   -> 'vision_only'    (never silently drop)
    //   local-only ON                 -> 'private_vision' (local vision only)
    //
    // 'private_vision' already requires a local vision provider, so the require
    // switch is implied — and disabled — while local-only is on.
    const visionLocalOnly = screenUnderstandingMode === 'private_vision';
    const visionRequired = screenUnderstandingMode === 'vision_only' || visionLocalOnly;

    // Three enum values, two switches — so 'private_vision' cannot represent what
    // the "Require" switch was set to before local-only was turned on. See the
    // original AIProvidersSettings note this was copied from for the full
    // rationale; behavior is unchanged by the move.
    const requiredBeforeLocalOnly = useRef<boolean | null>(null);

    const applyVisionMode = async (localOnly: boolean, required: boolean) => {
        const previousMode = screenUnderstandingMode;
        const previousRequiredBefore = requiredBeforeLocalOnly.current;

        let effectiveRequired = required;
        if (localOnly && !visionLocalOnly) {
            requiredBeforeLocalOnly.current = screenUnderstandingMode === 'vision_only';
        } else if (!localOnly && visionLocalOnly) {
            effectiveRequired = requiredBeforeLocalOnly.current ?? false;
            requiredBeforeLocalOnly.current = null;
        }
        const mode = localOnly ? 'private_vision' : (effectiveRequired ? 'vision_only' : 'vision_first');
        setScreenUnderstandingMode(mode);

        try {
            const res = await window.electronAPI?.setScreenUnderstandingMode?.(mode);
            if (res && res.success === false) {
                setScreenUnderstandingMode(previousMode);
                requiredBeforeLocalOnly.current = previousRequiredBefore;
                console.warn('[ScreenVision] screen-understanding mode was not saved:', res.error);
            }
        } catch (e) {
            setScreenUnderstandingMode(previousMode);
            requiredBeforeLocalOnly.current = previousRequiredBefore;
            console.warn('[ScreenVision] screen-understanding mode write failed:', e);
        }
    };

    useEffect(() => {
        window.electronAPI?.getScreenUnderstandingMode?.().then(setScreenUnderstandingMode as any).catch(() => { });
        (window.electronAPI as any)?.getTechnicalInterviewVisionFirst?.()
            .then(setTechnicalInterviewVisionFirst)
            .catch(() => {
                window.electronAPI?.getTechnicalInterviewDirectVision?.().then(setTechnicalInterviewVisionFirst).catch(() => { });
            });
        window.electronAPI?.getProviderDataScopes?.()
            .then((scopes: any) => setProviderScreenshotsScope(scopes?.screenshots))
            .catch(() => { });
        window.electronAPI?.getLocalFallbackStatus?.()
            .then((st: any) => setLocalFallbackVision(Boolean(st?.vision)))
            .catch(() => { });
    }, []);

    useEffect(() => {
        const api: any = window.electronAPI;
        if (!api?.onScreenUnderstandingModeChanged) return;
        const unsubscribe = api.onScreenUnderstandingModeChanged(setScreenUnderstandingMode);
        return () => unsubscribe?.();
    }, []);

    useEffect(() => {
        const api: any = window.electronAPI;
        const handler = (enabled: boolean) => setTechnicalInterviewVisionFirst(enabled);
        const unsub1 = api?.onTechnicalInterviewVisionFirstChanged?.(handler);
        const unsub2 = api?.onTechnicalInterviewDirectVisionChanged?.(handler);
        return () => {
            unsub1?.();
            unsub2?.();
        };
    }, []);

    useEffect(() => {
        const api: any = window.electronAPI;
        if (!api?.onProviderDataScopesChanged) return;
        const unsubscribe = api.onProviderDataScopesChanged((scopes: any) => setProviderScreenshotsScope(scopes?.screenshots));
        return () => unsubscribe?.();
    }, []);

    // --- Automatic screen context (moved from Intelligence > Customize's
    // "Screen & vision" group, which had exactly this one flag). Same
    // registry-backed flag, fetched independently rather than sharing
    // IntelligenceSettings' broader `flags` array state.
    const [liveScreenContextEnabled, setLiveScreenContextEnabled] = useState<boolean | null>(null);

    useEffect(() => {
        window.electronAPI.getIntelligenceFlags?.().then((flags: any[]) => {
            const row = Array.isArray(flags) ? flags.find((f) => f.key === 'liveScreenContextEnabled') : null;
            if (row) setLiveScreenContextEnabled(Boolean(row.enabled));
        }).catch(() => { });
    }, []);

    const onToggleLiveScreenContext = async () => {
        const next = !liveScreenContextEnabled;
        setLiveScreenContextEnabled(next); // optimistic
        try {
            const res = await window.electronAPI.setIntelligenceFlag?.('liveScreenContextEnabled', next);
            if (res && typeof res.enabled === 'boolean') setLiveScreenContextEnabled(res.enabled);
        } catch (e) {
            setLiveScreenContextEnabled(!next); // roll back
            console.warn('[ScreenVision] failed to set liveScreenContextEnabled:', e);
        }
    };

    const localFallbackAvailable = localFallbackVision;

    return (
        <div className="space-y-5 aip-panel-fade">
            {/* AIP_CSS defines .aip-card/.aip-switch/etc.'s actual geometry (box
                size, colors) via a scoped <style> tag that normally only mounts
                inside AIProvidersSettings' own render tree. This tab reuses those
                classes (and the AipSwitch component) without mounting
                AIProvidersSettings, so it needs its own copy — duplicate <style>
                tags are harmless (identical rules, same cascade; see AIP_CSS's own
                header comment in AIProvidersSettings.tsx). Without this, every
                switch here collapses to a 0x0 box (found via live app testing,
                2026-09-28). */}
            <style>{AIP_CSS}</style>
            <div>
                <h3 className="text-sm font-bold aip-hero mb-1">{t('Screen & Vision')}</h3>
                <p className="text-xs aip-muted mb-2">{t('Controls how and when Natively looks at your screen.')}</p>
            </div>

            <div className="space-y-5">
                <div>
                    <h4 className="text-sm font-bold aip-hero mb-1">{t('Screenshots')}</h4>
                    <p className="text-xs aip-muted mb-2">{t('Controls where screenshots of your screen are processed.')}</p>
                </div>
                <div className="aip-card p-5 flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex flex-col min-w-0">
                            <span className="text-xs aip-hero font-semibold">{t('Keep screenshots on this device')}</span>
                            <span className="aip-meta leading-snug mt-0.5">
                                {t('Use a local vision model (Ollama) only. Cloud vision is never called.')}
                            </span>
                        </div>
                        <AipSwitch
                            checked={visionLocalOnly}
                            label={t('Keep screenshots on this device')}
                            onChange={(next) => applyVisionMode(next, visionRequired)}
                        />
                    </div>

                    {visionLocalOnly && !localFallbackAvailable && (
                        <div className="aip-inline-warn flex items-start gap-2">
                            <AlertCircle size={12} strokeWidth={1.75} className="shrink-0 mt-0.5" aria-hidden="true" />
                            <span>{t('No local vision model is installed. Screenshot questions will be refused rather than sent to the cloud. Install a vision-capable model under Local & Gateways.')}</span>
                        </div>
                    )}

                    <div className="flex items-center justify-between gap-3 pt-3 border-t" style={{ borderColor: 'var(--aip-divider)' }}>
                        <div className="flex flex-col min-w-0">
                            <span className={`text-xs font-semibold ${visionLocalOnly ? 'aip-faint' : 'aip-hero'}`}>
                                {t('Require a vision-capable provider')}
                            </span>
                            <span className="aip-meta leading-snug mt-0.5">
                                {visionLocalOnly
                                    ? t('Always on while screenshots stay on this device.')
                                    : t('Fail with a clear error instead of quietly answering without the screenshot.')}
                            </span>
                        </div>
                        <AipSwitch
                            checked={visionRequired}
                            disabled={visionLocalOnly}
                            label={t('Require a vision-capable provider')}
                            onChange={(next) => applyVisionMode(visionLocalOnly, next)}
                        />
                    </div>

                    <div className="flex items-center justify-between gap-3 pt-3 border-t" style={{ borderColor: 'var(--aip-divider)' }}>
                        <div className="flex flex-col min-w-0">
                            <span className="text-xs aip-hero font-semibold">{t('High-resolution capture for code')}</span>
                            <span className="aip-meta leading-snug mt-0.5">{t('In technical interview and coding modes, captures at the highest-resolution profile so small code text stays legible. Costs more tokens per screenshot.')}</span>
                        </div>
                        <AipSwitch
                            checked={technicalInterviewVisionFirst}
                            label={t('High-resolution capture for code')}
                            onChange={(next) => {
                                setTechnicalInterviewVisionFirst(next);
                                const api: any = window.electronAPI;
                                if (api?.setTechnicalInterviewVisionFirst) {
                                    api.setTechnicalInterviewVisionFirst(next);
                                } else {
                                    window.electronAPI?.setTechnicalInterviewDirectVision?.(next);
                                }
                            }}
                        />
                    </div>

                    {!visionLocalOnly && providerScreenshotsScope === false && (
                        <div className="flex items-start gap-2 pt-3 border-t" style={{ borderColor: 'var(--aip-divider)' }}>
                            <Info size={12} strokeWidth={1.75} className="aip-faint shrink-0 mt-0.5" aria-hidden="true" />
                            <p className="aip-meta leading-relaxed">
                                {localFallbackAvailable
                                    ? t('Screenshots are already blocked from cloud providers by the data scope in AI Providers > Privacy, so your local vision model handles them.')
                                    : visionRequired
                                        ? t('Screenshots are blocked from cloud providers by the data scope in AI Providers > Privacy, and no local vision model is installed. Screenshot questions will be refused rather than answered without the image.')
                                        : t('Screenshots are blocked from cloud providers by the data scope in AI Providers > Privacy, and no local vision model is installed — so the screenshot is discarded and the question is answered without it.')}
                            </p>
                        </div>
                    )}
                </div>
            </div>

            <div className="space-y-5">
                <div>
                    <h4 className="text-sm font-bold aip-hero mb-1">{t('Background screen context')}</h4>
                </div>
                <div className="aip-card p-5">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex flex-col min-w-0">
                            <span className="text-xs aip-hero font-semibold">{t('Automatic screen context')}</span>
                            <span className="aip-meta leading-snug mt-0.5">
                                {t('Periodically describes your screen in the background so automatic answers can reference it without waiting on a live capture. Off, screen understanding only runs when you manually ask about your screen.')}
                            </span>
                        </div>
                        <AipSwitch
                            checked={Boolean(liveScreenContextEnabled)}
                            label={t('Automatic screen context')}
                            onChange={onToggleLiveScreenContext}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
};
