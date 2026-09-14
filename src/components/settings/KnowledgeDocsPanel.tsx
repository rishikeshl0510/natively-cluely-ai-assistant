// src/components/settings/KnowledgeDocsPanel.tsx
//
// Free-tier "Interview Knowledge" settings panel (docs/specs/oss-knowledge-rag-spec.md).
// Deliberately its own file — NOT ModesSettings.tsx (that one's the premium
// stub, see electron/services/interviewKnowledge/InterviewKnowledgeRetriever.ts's
// header for why) and NOT ProfileIntelligenceSettings.tsx. Every IPC call here
// goes through knowledge-doc:*/knowledge-collection:* channels, which are
// grep-tested to never call isProOrTrialActive()
// (electron/services/interviewKnowledge/__tests__/InterviewKnowledgeIpcFree.test.mjs).
//
// Documents are grouped into "collections" (a company/interview — "Acme Corp,
// onsite loop") so a resume + that company's JD + interviewer notes retrieve
// together, scoped to whichever collection is ACTIVE, instead of searching
// every company's documents at once. The active collection also decides where
// new uploads land.

import React, { useCallback, useEffect, useState } from 'react';
import { Building2, ChevronDown, FileText, FolderOpen, Loader2, Plus, Trash2, Upload } from 'lucide-react';
import { useT } from '../../i18n';

interface KnowledgeDoc {
    id: string;
    title: string;
    content: string;
    contentSha256: string;
    source: string;
    createdAt: string;
    collectionId: string | null;
    docType: string;
}

interface KnowledgeCollection {
    id: string;
    name: string;
    interviewerName: string | null;
    contextNotes: string | null;
    createdAt: string;
}

const StatusBadge: React.FC<{ id: string }> = ({ id }) => {
    const t = useT();
    const [status, setStatus] = useState<{ status: string; chunkCount: number } | null>(null);

    useEffect(() => {
        let cancelled = false;
        const poll = async () => {
            try {
                const res = await window.electronAPI.knowledgeDocGetStatus(id);
                if (!cancelled && res?.success) setStatus({ status: res.status, chunkCount: res.chunkCount });
            } catch { /* best-effort */ }
        };
        void poll();
        // Indexing runs fire-and-forget in the main process — poll briefly so
        // the badge moves from "indexing" to "ready" without a manual refresh.
        const id2 = setInterval(poll, 2000);
        return () => { cancelled = true; clearInterval(id2); };
    }, [id]);

    if (!status) return null;
    const label = status.status === 'ready' ? t('Ready')
        : status.status === 'indexing' ? t('Indexing…')
        : status.status === 'lexical_only' ? t('Lexical only')
        : status.status === 'failed' ? t('Failed')
        : t('Pending');
    const tone = status.status === 'ready' ? 'text-green-400 border-green-500/30 bg-green-500/10'
        : status.status === 'failed' ? 'text-red-400 border-red-500/30 bg-red-500/10'
        : 'text-text-tertiary border-border-subtle bg-bg-main';
    return (
        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone}`}>
            {status.status === 'indexing' ? <Loader2 size={10} className="animate-spin" /> : null}
            {label}{status.chunkCount ? ` · ${status.chunkCount}` : ''}
        </span>
    );
};

export const KnowledgeDocsPanel: React.FC = () => {
    const t = useT();
    const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
    const [activeId, setActiveId] = useState<string | null>(null); // company id, or null = Unfiled
    const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
    const [pasteTitle, setPasteTitle] = useState('');
    const [pasteText, setPasteText] = useState('');
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [showNewCompany, setShowNewCompany] = useState(false);
    const [newCompanyName, setNewCompanyName] = useState('');
    const [newInterviewer, setNewInterviewer] = useState('');
    const [newNotes, setNewNotes] = useState('');
    const [showPicker, setShowPicker] = useState(false);
    const [pasteDocType, setPasteDocType] = useState<'other' | 'resume' | 'company' | 'interviewer' | 'role'>('other');

    const flashNotice = (text: string) => {
        setNotice(text);
        setTimeout(() => setNotice(null), 3000);
    };

    const refreshCollections = useCallback(async () => {
        try {
            const res = await window.electronAPI.knowledgeCollectionList();
            if (res?.success) setCollections(res.collections);
        } catch { /* best-effort */ }
    }, []);

    const refreshDocs = useCallback(async (collectionId: string | null) => {
        try {
            const res = await window.electronAPI.knowledgeDocList(collectionId);
            if (res?.success) setDocs(res.docs);
        } catch { /* best-effort */ }
    }, []);

    // Load collections + whichever one is currently active (persisted in the
    // main process, so it survives closing/reopening Settings).
    useEffect(() => {
        (async () => {
            await refreshCollections();
            try {
                const res = await window.electronAPI.knowledgeCollectionGetActive();
                setActiveId(res?.success ? res.activeCollectionId : null);
            } catch { setActiveId(null); }
        })();
    }, [refreshCollections]);

    useEffect(() => { void refreshDocs(activeId); }, [activeId, refreshDocs]);

    const onSelectCompany = useCallback(async (id: string | null) => {
        setActiveId(id);
        setShowPicker(false);
        try { await window.electronAPI.knowledgeCollectionSetActive(id); } catch { /* best-effort */ }
    }, []);

    const onCreateCompany = useCallback(async () => {
        if (!newCompanyName.trim()) return;
        setBusy(true);
        try {
            const res = await window.electronAPI.knowledgeCollectionCreate({
                name: newCompanyName,
                interviewerName: newInterviewer || undefined,
                contextNotes: newNotes || undefined,
            });
            if (res?.success && res.collection) {
                await refreshCollections();
                await onSelectCompany(res.collection.id);
                setNewCompanyName(''); setNewInterviewer(''); setNewNotes('');
                setShowNewCompany(false);
            } else {
                flashNotice(res?.error || t('Could not create company.'));
            }
        } finally { setBusy(false); }
    }, [newCompanyName, newInterviewer, newNotes, refreshCollections, onSelectCompany, t]);

    const onDeleteCompany = useCallback(async (id: string) => {
        setBusy(true);
        try {
            await window.electronAPI.knowledgeCollectionDelete(id);
            await refreshCollections();
            if (activeId === id) await onSelectCompany(null);
            else await refreshDocs(activeId);
        } finally { setBusy(false); }
    }, [activeId, refreshCollections, refreshDocs, onSelectCompany]);

    const onAddPaste = useCallback(async () => {
        if (!pasteText.trim()) return;
        setBusy(true);
        try {
            const res = await window.electronAPI.knowledgeDocAddText({ title: pasteTitle, content: pasteText, collectionId: activeId, docType: pasteDocType });
            if (res?.success) {
                setPasteTitle('');
                setPasteText('');
                await refreshDocs(activeId);
            } else {
                flashNotice(res?.error || t('Could not add text.'));
            }
        } finally { setBusy(false); }
    }, [pasteTitle, pasteText, activeId, pasteDocType, refreshDocs, t]);

    const onAddFile = useCallback(async () => {
        setBusy(true);
        try {
            const res = await window.electronAPI.knowledgeDocAddFile({ collectionId: activeId, docType: pasteDocType });
            if (res?.success) await refreshDocs(activeId);
            else if (!res?.cancelled) flashNotice(res?.error || t('Could not add file.'));
        } finally { setBusy(false); }
    }, [activeId, pasteDocType, refreshDocs, t]);

    const onAddFolder = useCallback(async () => {
        setBusy(true);
        try {
            const res = await window.electronAPI.knowledgeDocAddFolder({ collectionId: activeId });
            if (res?.success) {
                await refreshDocs(activeId);
                flashNotice(t('Added {added}, skipped {skipped}.').replace('{added}', String(res.added ?? 0)).replace('{skipped}', String(res.skipped ?? 0)));
            } else if (!res?.cancelled) {
                flashNotice(res?.error || t('Could not scan folder.'));
            }
        } finally { setBusy(false); }
    }, [activeId, refreshDocs, t]);

    const onDelete = useCallback(async (id: string) => {
        setBusy(true);
        try {
            await window.electronAPI.knowledgeDocDelete(id);
            await refreshDocs(activeId);
        } finally { setBusy(false); }
    }, [activeId, refreshDocs]);

    const activeCompany = collections.find((c) => c.id === activeId) || null;

    return (
        <div className="space-y-6 max-w-2xl" data-settings-stagger>
            <header>
                <h3 className="text-lg font-bold text-text-primary mb-1">{t('Interview Knowledge')}</h3>
                <p className="text-xs text-text-secondary mb-5">
                    {t('Group documents by company so a resume, that company\'s JD, and interviewer notes retrieve together. Answers ground themselves automatically — no mode setup needed. Runs entirely on-device by default.')}
                </p>
            </header>

            {/* Company picker */}
            <section className="rounded-xl border border-border-subtle bg-bg-item-surface p-4 space-y-3">
                <div className="relative">
                    <button
                        type="button"
                        onClick={() => setShowPicker((v) => !v)}
                        className="flex w-full items-center justify-between gap-2 rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary"
                    >
                        <span className="flex min-w-0 items-center gap-2">
                            <Building2 size={13} className="shrink-0 text-text-tertiary" />
                            <span className="truncate">{activeCompany ? activeCompany.name : t('Unfiled')}</span>
                        </span>
                        <ChevronDown size={13} className="shrink-0 text-text-tertiary" />
                    </button>
                    {showPicker ? (
                        <div className="absolute z-10 mt-1 w-full rounded-lg border border-border-subtle bg-bg-item-surface p-1 shadow-lg">
                            <button
                                type="button"
                                onClick={() => onSelectCompany(null)}
                                className={`block w-full rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-bg-item-active ${activeId === null ? 'text-accent-primary' : 'text-text-primary'}`}
                            >
                                {t('Unfiled')}
                            </button>
                            {collections.map((c) => (
                                <div key={c.id} className="flex items-center justify-between gap-1 rounded-md hover:bg-bg-item-active">
                                    <button
                                        type="button"
                                        onClick={() => onSelectCompany(c.id)}
                                        className={`flex-1 truncate px-2.5 py-1.5 text-left text-xs ${activeId === c.id ? 'text-accent-primary' : 'text-text-primary'}`}
                                    >
                                        {c.name}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onDeleteCompany(c.id)}
                                        aria-label={t('Delete company')}
                                        className="shrink-0 rounded p-1 mr-1 text-text-tertiary hover:text-red-400"
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                </div>
                            ))}
                            <button
                                type="button"
                                onClick={() => { setShowPicker(false); setShowNewCompany(true); }}
                                className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-left text-xs text-accent-primary hover:bg-bg-item-active"
                            >
                                <Plus size={12} /> {t('New company')}
                            </button>
                        </div>
                    ) : null}
                </div>

                {activeCompany?.interviewerName || activeCompany?.contextNotes ? (
                    <div className="rounded-lg bg-bg-main/40 p-2.5 text-[11px] text-text-secondary space-y-0.5">
                        {activeCompany.interviewerName ? <div><span className="text-text-tertiary">{t('Interviewer:')}</span> {activeCompany.interviewerName}</div> : null}
                        {activeCompany.contextNotes ? <div><span className="text-text-tertiary">{t('Notes:')}</span> {activeCompany.contextNotes}</div> : null}
                    </div>
                ) : null}

                {showNewCompany ? (
                    <div className="space-y-2 rounded-lg border border-border-subtle bg-bg-main/40 p-3">
                        <input
                            type="text" value={newCompanyName} onChange={(e) => setNewCompanyName(e.target.value)}
                            placeholder={t('Company name')}
                            className="w-full rounded-md border border-border-subtle bg-bg-input px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary"
                        />
                        <input
                            type="text" value={newInterviewer} onChange={(e) => setNewInterviewer(e.target.value)}
                            placeholder={t('Interviewer name (optional)')}
                            className="w-full rounded-md border border-border-subtle bg-bg-input px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary"
                        />
                        <textarea
                            value={newNotes} onChange={(e) => setNewNotes(e.target.value)} rows={2}
                            placeholder={t('Interview context notes (optional)')}
                            className="w-full rounded-md border border-border-subtle bg-bg-input px-2.5 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent-primary resize-y"
                        />
                        <div className="flex gap-2">
                            <button type="button" disabled={busy || !newCompanyName.trim()} onClick={onCreateCompany}
                                className="rounded-md bg-accent-primary px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50">
                                {t('Create')}
                            </button>
                            <button type="button" onClick={() => setShowNewCompany(false)}
                                className="rounded-md border border-border-subtle px-3 py-1.5 text-[11px] font-medium text-text-secondary">
                                {t('Cancel')}
                            </button>
                        </div>
                    </div>
                ) : null}
            </section>

            <section className="rounded-xl border border-border-subtle bg-bg-item-surface p-5 space-y-3">
                <label className="block space-y-1">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">{t('Title')}</span>
                    <input
                        type="text"
                        value={pasteTitle}
                        onChange={(e) => setPasteTitle(e.target.value)}
                        placeholder={t('e.g. Resume, Job Description')}
                        className="w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary transition-colors focus:outline-none focus:border-accent-primary"
                    />
                </label>
                <label className="block space-y-1">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">{t('Paste text')}</span>
                    <textarea
                        value={pasteText}
                        onChange={(e) => setPasteText(e.target.value)}
                        rows={5}
                        placeholder={t('Paste your resume, job description, or notes here…')}
                        className="w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary transition-colors focus:outline-none focus:border-accent-primary resize-y"
                    />
                </label>
                <label className="block space-y-1">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">{t('Type')}</span>
                    <select
                        value={pasteDocType}
                        onChange={(e) => setPasteDocType(e.target.value as typeof pasteDocType)}
                        className="w-full rounded-lg border border-border-subtle bg-bg-input px-3 py-2 text-xs text-text-primary transition-colors focus:outline-none focus:border-accent-primary"
                    >
                        <option value="other">{t('Other / General')}</option>
                        <option value="resume">{t('Resume')}</option>
                        <option value="company">{t('Company info')}</option>
                        <option value="interviewer">{t('Interviewer notes')}</option>
                        <option value="role">{t('Role / Job description')}</option>
                    </select>
                    <span className="block text-[10px] text-text-tertiary">
                        {t('Helps answers pull from the right document when a question is clearly about the company, the role, or the interviewer.')}
                    </span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        disabled={busy || !pasteText.trim()}
                        onClick={onAddPaste}
                        className="rounded-md bg-accent-primary px-3 py-1.5 text-[11px] font-medium text-white transition-colors disabled:opacity-50"
                    >
                        {t('Add text')}
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onAddFile}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-input px-3 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                    >
                        <Upload size={12} /> {t('Add file')}
                    </button>
                    <button
                        type="button"
                        disabled={busy}
                        onClick={onAddFolder}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border-subtle bg-bg-input px-3 py-1.5 text-[11px] font-medium text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
                    >
                        <FolderOpen size={12} /> {t('Add folder')}
                    </button>
                    {notice ? <span className="text-[10px] text-text-tertiary">{notice}</span> : null}
                </div>
            </section>

            <section className="rounded-xl border border-border-subtle bg-bg-item-surface p-5 space-y-2">
                <h4 className="text-xs font-semibold text-text-primary">
                    {activeCompany ? t('Documents for {name}').replace('{name}', activeCompany.name) : t('Unfiled documents')}
                </h4>
                {docs.length === 0 ? (
                    <p className="text-[11px] text-text-tertiary">{t('Nothing added yet.')}</p>
                ) : (
                    <div className="space-y-1.5">
                        {docs.map((d) => (
                            <div key={d.id} className="flex items-center justify-between gap-3 rounded-lg px-2.5 py-2 hover:bg-bg-item-active">
                                <div className="min-w-0 flex items-center gap-2">
                                    <FileText size={13} className="shrink-0 text-text-tertiary" />
                                    <span className="truncate text-xs text-text-primary" title={d.title}>{d.title}</span>
                                    {d.docType && d.docType !== 'other' ? (
                                        <span className="shrink-0 rounded-full border border-border-subtle bg-bg-main px-1.5 py-0.5 text-[10px] text-text-tertiary">{d.docType}</span>
                                    ) : null}
                                    <StatusBadge id={d.id} />
                                </div>
                                <button
                                    type="button"
                                    onClick={() => onDelete(d.id)}
                                    aria-label={t('Delete')}
                                    className="shrink-0 rounded-md p-1 text-text-tertiary transition-colors hover:text-red-400"
                                >
                                    <Trash2 size={13} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
};
