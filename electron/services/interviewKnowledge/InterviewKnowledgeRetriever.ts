// electron/services/interviewKnowledge/InterviewKnowledgeRetriever.ts
//
// Free-tier "Interview Knowledge" feature (docs/specs/oss-knowledge-rag-spec.md).
// Deliberately separate from the Modes system: its own table
// (interview_knowledge_docs), its own IPC namespace (electron/ipcHandlers.ts
// `knowledge-doc:*`), and it never calls isProOrTrialActive() or any
// modes:*/profile:* handler.
//
// Chunking/embedding/hybrid-search is NOT re-derived here. ModeHybridRetriever
// (electron/services/modes/ModeHybridRetriever.ts) already carries years of
// hard-won correctness fixes for exactly this problem — batch sizing that
// avoids a native ONNX SIGTRAP, rate-limit retry with jitter, partial-embedding
// resume, embedding-space versioning so vectors from different providers are
// never compared. Reusing it is a deliberate reuse-the-library decision: this
// class maps its own KnowledgeDoc rows to the ModeReferenceFile shape
// ModeHybridRetriever already accepts, and lets it own chunk/vector storage
// (mode_reference_chunks / mode_reference_index_state) — keyed by this file's
// own `ik_`-prefixed ids, which can never collide with a Modes reference-file
// id, so nothing here can be confused with, or read back through, the Modes
// system.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseManager } from '../../db/DatabaseManager';
import { VectorStore } from '../../rag/VectorStore';
import type { EmbeddingPipeline } from '../../rag/EmbeddingPipeline';
import { ModeHybridRetriever } from '../modes/ModeHybridRetriever';
import type { ModeReferenceFile } from '../ModesManager';
import { extractSafeDocumentText } from '../SafeDocumentTextExtractor';
import type { KnowledgeDocType } from './docTypeAffinity';
export type { KnowledgeDocType } from './docTypeAffinity';

/** Constant label only — chunk storage is keyed by file id, not mode id (see module header). Never written to or read from any modes:* table. */
const INTERVIEW_KNOWLEDGE_MODE_LABEL = '__interview_knowledge__';

export interface KnowledgeDoc {
    id: string;
    title: string;
    content: string;
    contentSha256: string;
    source: 'paste' | 'file' | 'folder';
    createdAt: string;
    /** Which company/interview this doc belongs to. Null = "Unfiled" (pre-migration docs, or a user who never creates a collection — today's flat behavior, unchanged). */
    collectionId: string | null;
    /** 'other' (the default) is neither boosted nor penalized by docTypeAffinity — untyped docs behave exactly as before this field existed. */
    docType: KnowledgeDocType;
}

/** A company/interview grouping — "Acme Corp, onsite loop" — so a resume + that company's JD + interviewer notes retrieve together, scoped, instead of searching every company's documents at once. */
export interface KnowledgeCollection {
    id: string;
    name: string;
    interviewerName: string | null;
    contextNotes: string | null;
    createdAt: string;
}

export interface KnowledgeFolderIngestResult {
    added: number;
    skipped: number;
    errors: Array<{ path: string; reason: string }>;
}

interface KnowledgeDocRow {
    id: string;
    title: string;
    content: string;
    content_sha256: string;
    source: string;
    created_at: string;
    collection_id: string | null;
    doc_type: string;
}

interface KnowledgeCollectionRow {
    id: string;
    name: string;
    interviewer_name: string | null;
    context_notes: string | null;
    created_at: string;
}

function rowToDoc(row: KnowledgeDocRow): KnowledgeDoc {
    return {
        id: row.id,
        title: row.title,
        content: row.content,
        contentSha256: row.content_sha256,
        source: (row.source as KnowledgeDoc['source']) || 'paste',
        createdAt: row.created_at,
        collectionId: row.collection_id ?? null,
        docType: (row.doc_type as KnowledgeDocType) || 'other',
    };
}

function rowToCollection(row: KnowledgeCollectionRow): KnowledgeCollection {
    return {
        id: row.id,
        name: row.name,
        interviewerName: row.interviewer_name ?? null,
        contextNotes: row.context_notes ?? null,
        createdAt: row.created_at,
    };
}

export class InterviewKnowledgeRetriever {
    private static instance: InterviewKnowledgeRetriever | null = null;
    public static getInstance(): InterviewKnowledgeRetriever {
        if (!InterviewKnowledgeRetriever.instance) {
            InterviewKnowledgeRetriever.instance = new InterviewKnowledgeRetriever();
        }
        return InterviewKnowledgeRetriever.instance;
    }

    /** Test-only: drop the singleton so each test starts clean. */
    public static __resetForTests(): void {
        InterviewKnowledgeRetriever.instance = null;
    }

    private _sharedEmbeddingPipeline: EmbeddingPipeline | null = null;
    private _hybridRetriever: ModeHybridRetriever | null = null;

    /**
     * Injected once at startup (main.ts, right next to the existing
     * `ModesManager.getInstance().setSharedEmbeddingPipeline(...)` call) from
     * the SAME already-initialized RAGManager pipeline. Never construct a
     * fresh `new EmbeddingPipeline(...)` here — one nobody calls
     * `.initialize()` on stays permanently un-provisioned and silently
     * degrades every query to lexical-only forever. This is the exact bug
     * `ModeContextRetriever.ensureHybridRetriever`'s own header comment
     * documents and fixes; this class follows the same fix.
     */
    public setSharedEmbeddingPipeline(pipeline: EmbeddingPipeline): void {
        this._sharedEmbeddingPipeline = pipeline;
        this._hybridRetriever = null; // rebuild lazily against the new pipeline
    }

    /** Null when the shared pipeline hasn't been injected yet (early startup race) — callers degrade to "stored, not yet indexed" rather than throwing. */
    private ensureHybridRetriever(): ModeHybridRetriever | null {
        if (this._hybridRetriever) return this._hybridRetriever;
        if (!this._sharedEmbeddingPipeline) return null;
        const db = DatabaseManager.getInstance().getDb();
        if (!db) return null;
        const dbPath = DatabaseManager.getInstance().getDbPath();
        // VectorStore's dbPath/extPath params are vestigial (it reuses the
        // caller's already-vec-loaded connection) — matches the same empty
        // extPath ModeContextRetriever.ensureHybridRetriever passes.
        const vectorStore = new VectorStore(db, dbPath, '');
        this._hybridRetriever = new ModeHybridRetriever(db, vectorStore, this._sharedEmbeddingPipeline);
        return this._hybridRetriever;
    }

    private getDb() {
        const db = DatabaseManager.getInstance().getDb();
        if (!db) throw new Error('[InterviewKnowledgeRetriever] Database not available');
        return db;
    }

    private toReferenceFile(doc: KnowledgeDoc): ModeReferenceFile {
        return {
            id: doc.id,
            modeId: INTERVIEW_KNOWLEDGE_MODE_LABEL,
            fileName: doc.title,
            content: doc.content,
            createdAt: doc.createdAt,
        };
    }

    /** `collectionId === undefined` (the default) returns every doc, any collection — today's flat behavior. Pass a specific id, or `null` for "Unfiled only". */
    public list(collectionId?: string | null): KnowledgeDoc[] {
        const db = this.getDb();
        if (collectionId === undefined) {
            return (db.prepare('SELECT * FROM interview_knowledge_docs ORDER BY created_at ASC').all() as KnowledgeDocRow[]).map(rowToDoc);
        }
        if (collectionId === null) {
            return (db.prepare('SELECT * FROM interview_knowledge_docs WHERE collection_id IS NULL ORDER BY created_at ASC').all() as KnowledgeDocRow[]).map(rowToDoc);
        }
        return (db.prepare('SELECT * FROM interview_knowledge_docs WHERE collection_id = ? ORDER BY created_at ASC').all(collectionId) as KnowledgeDocRow[]).map(rowToDoc);
    }

    public hasAnyDocs(collectionId?: string | null): boolean {
        try {
            return this.list(collectionId).length > 0;
        } catch {
            return false;
        }
    }

    // ── Collections (companies/interviews) ──────────────────────────────

    public createCollection(params: { name: string; interviewerName?: string; contextNotes?: string }): KnowledgeCollection {
        const name = params.name?.trim();
        if (!name) throw new Error('Collection name is required');
        const id = `ikc_${crypto.randomUUID()}`;
        const createdAt = new Date().toISOString();
        this.getDb().prepare(`
            INSERT INTO interview_knowledge_collections (id, name, interviewer_name, context_notes, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, name, params.interviewerName?.trim() || null, params.contextNotes?.trim() || null, createdAt);
        return { id, name, interviewerName: params.interviewerName?.trim() || null, contextNotes: params.contextNotes?.trim() || null, createdAt };
    }

    public listCollections(): KnowledgeCollection[] {
        const rows = this.getDb()
            .prepare('SELECT * FROM interview_knowledge_collections ORDER BY created_at ASC')
            .all() as KnowledgeCollectionRow[];
        return rows.map(rowToCollection);
    }

    public updateCollection(id: string, updates: { name?: string; interviewerName?: string | null; contextNotes?: string | null }): void {
        const existing = this.getDb().prepare('SELECT * FROM interview_knowledge_collections WHERE id = ?').get(id) as KnowledgeCollectionRow | undefined;
        if (!existing) throw new Error('Collection not found');
        const name = updates.name !== undefined ? updates.name.trim() || existing.name : existing.name;
        const interviewerName = updates.interviewerName !== undefined ? (updates.interviewerName?.trim() || null) : existing.interviewer_name;
        const contextNotes = updates.contextNotes !== undefined ? (updates.contextNotes?.trim() || null) : existing.context_notes;
        this.getDb().prepare('UPDATE interview_knowledge_collections SET name = ?, interviewer_name = ?, context_notes = ? WHERE id = ?')
            .run(name, interviewerName, contextNotes, id);
    }

    /** Cascades to this collection's docs (and, via delete(), their chunks/index state) — a deleted company's documents are no longer meaningful on their own. */
    public deleteCollection(id: string): void {
        for (const doc of this.list(id)) this.delete(doc.id);
        this.getDb().prepare('DELETE FROM interview_knowledge_collections WHERE id = ?').run(id);
        // Clear the active pointer if it pointed at what was just deleted —
        // the DB's own ON DELETE SET NULL handles this too, but this keeps
        // getActiveCollectionId() correct even for callers reading a cached row.
        if (this.getActiveCollectionId() === id) this.setActiveCollectionId(null);
    }

    /** Which collection retrieval scopes to right now. Null = search every document (no collection selected). */
    public getActiveCollectionId(): string | null {
        try {
            const row = this.getDb().prepare('SELECT active_collection_id FROM interview_knowledge_state WHERE id = 1').get() as { active_collection_id: string | null } | undefined;
            return row?.active_collection_id ?? null;
        } catch {
            return null;
        }
    }

    public setActiveCollectionId(id: string | null): void {
        this.getDb().prepare(`
            INSERT INTO interview_knowledge_state (id, active_collection_id) VALUES (1, ?)
            ON CONFLICT(id) DO UPDATE SET active_collection_id = excluded.active_collection_id
        `).run(id);
    }

    public getStatus(id: string): { status: string; chunkCount: number } {
        const retriever = this.ensureHybridRetriever();
        if (!retriever) return { status: 'pending', chunkCount: 0 };
        const s = retriever.getFileIndexStatus(id);
        return { status: s.status, chunkCount: s.chunkCount };
    }

    public delete(id: string): void {
        try { this.ensureHybridRetriever()?.removeFileIndex(id); } catch { /* best-effort */ }
        this.getDb().prepare('DELETE FROM interview_knowledge_docs WHERE id = ?').run(id);
    }

    /** Add pasted or extracted text as a new knowledge doc, optionally filed under a collection (company/interview) and tagged with a docType. Indexing is fire-and-forget, same pattern as ingestModeReferenceFile. */
    public addText(params: { title: string; content: string; source?: KnowledgeDoc['source']; collectionId?: string | null; docType?: KnowledgeDocType }): KnowledgeDoc {
        const content = (params.content || '').trim();
        if (!content) throw new Error('Empty content');
        const id = `ik_${crypto.randomUUID()}`;
        const contentSha256 = crypto.createHash('sha256').update(content).digest('hex');
        const createdAt = new Date().toISOString();
        const title = params.title?.trim() || 'Untitled';
        const source = params.source || 'paste';
        const collectionId = params.collectionId ?? null;
        const docType = params.docType || 'other';
        this.getDb().prepare(`
            INSERT INTO interview_knowledge_docs (id, title, content, content_sha256, source, created_at, collection_id, doc_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(id, title, content, contentSha256, source, createdAt, collectionId, docType);
        const doc: KnowledgeDoc = { id, title, content, contentSha256, source, createdAt, collectionId, docType };
        void this.indexDoc(doc);
        return doc;
    }

    public async addFile(filePath: string, collectionId?: string | null, docType?: KnowledgeDocType): Promise<KnowledgeDoc> {
        const extracted = await extractSafeDocumentText(filePath);
        return this.addText({ title: extracted.fileName, content: extracted.content, source: 'file', collectionId, docType });
    }

    /**
     * One-shot recursive scan — a "Rescan folder" action, not a live
     * filesystem watcher. See the spec's Folder ingestion section: fs.watch/
     * FSEvents/ReadDirectoryChangesW behave too differently across
     * macOS/Windows to take on in this pass. A manual rescan needs zero
     * platform-specific code.
     *
     * One bad file (unsupported extension, oversized, corrupt) is recorded
     * and skipped — it must never abort the rest of the folder.
     */
    public async addFolder(folderPath: string, collectionId?: string | null): Promise<KnowledgeFolderIngestResult> {
        const result: KnowledgeFolderIngestResult = { added: 0, skipped: 0, errors: [] };
        const files = await this.walkFolder(folderPath);
        for (const filePath of files) {
            try {
                await this.addFile(filePath, collectionId);
                result.added++;
            } catch (e: any) {
                // extractSafeDocumentText itself rejects unsupported
                // extensions / oversized files / parse failures — one
                // catch site covers all of those skip reasons.
                result.skipped++;
                result.errors.push({ path: filePath, reason: e?.message || String(e) });
            }
        }
        return result;
    }

    private async walkFolder(folderPath: string): Promise<string[]> {
        const out: string[] = [];
        const entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(folderPath, entry.name);
            if (entry.isDirectory()) {
                out.push(...(await this.walkFolder(full)));
            } else if (entry.isFile()) {
                out.push(full);
            }
        }
        return out;
    }

    private async indexDoc(doc: KnowledgeDoc): Promise<void> {
        const retriever = this.ensureHybridRetriever();
        if (!retriever) {
            console.warn('[InterviewKnowledgeRetriever] Embedding pipeline not ready yet — doc stored, will index on next ensureAllIndexed() pass.');
            return;
        }
        try {
            await retriever.indexFile(this.toReferenceFile(doc));
        } catch (e) {
            console.warn('[InterviewKnowledgeRetriever] indexDoc failed:', e instanceof Error ? e.message : e);
        }
    }

    /**
     * Re-attempt indexing for any doc not yet fully embedded. Called lazily
     * before a live retrieval so a doc added before the shared pipeline was
     * ready (or one whose embedding provider changed since) still gets
     * indexed — mirrors ModesManager.prewarmModeReferenceIndex's role for
     * reference files.
     */
    public async ensureAllIndexed(): Promise<void> {
        const retriever = this.ensureHybridRetriever();
        if (!retriever) return;
        for (const doc of this.list()) {
            const status = retriever.getFileIndexStatus(doc.id);
            if (status.status === 'pending' || status.status === 'lexical_only' || status.status === 'failed') {
                await retriever.indexFile(this.toReferenceFile(doc));
            }
        }
    }

    /**
     * Files to retrieve over for the CURRENT turn. Defaults to whatever
     * `getActiveCollectionId()` says (null = every document — unchanged
     * behavior for an install that never creates a collection); pass an
     * explicit id (or null) to override.
     */
    public getReferenceFiles(collectionId?: string | null): ModeReferenceFile[] {
        const scope = collectionId !== undefined ? collectionId : this.getActiveCollectionId();
        return this.list(scope === null ? undefined : scope).map((d) => this.toReferenceFile(d));
    }

    /** doc id -> docType, for agenticRetrieve.ts's docTypeAffinity boosting. Scoped the same way getReferenceFiles() is, so the map only ever contains ids that were actually searched this turn. */
    public getDocTypeMap(collectionId?: string | null): Map<string, KnowledgeDocType> {
        const scope = collectionId !== undefined ? collectionId : this.getActiveCollectionId();
        const out = new Map<string, KnowledgeDocType>();
        for (const d of this.list(scope === null ? undefined : scope)) out.set(d.id, d.docType);
        return out;
    }

    /** Low-level access for agenticRetrieve.ts — null when the shared pipeline isn't ready yet (caller should treat as "no knowledge context available"). */
    public getHybridRetriever(): ModeHybridRetriever | null {
        return this.ensureHybridRetriever();
    }

    /**
     * Whole-corpus text for the given (or active) collection, one doc per
     * section, for the prompt-cache path (LLMHelper.stream's Interview
     * Knowledge block): "assume we have a set of documents needed for THIS
     * interview" — a collection IS that set (resume + JD + notes for one
     * company/interview loop). When it's small enough to be worth caching
     * wholesale, this replaces per-turn agentic retrieval entirely: the whole
     * set goes into the CACHED system prompt once, instead of a fresh
     * retrieval result being re-sent, uncached, on every single turn.
     *
     * Returns null when there are no docs in scope — caller falls back to
     * per-turn retrieval.
     */
    public getFullCorpusText(collectionId?: string | null): string | null {
        const scope = collectionId !== undefined ? collectionId : this.getActiveCollectionId();
        const docs = this.list(scope === null ? undefined : scope);
        if (docs.length === 0) return null;
        return docs
            .map((d) => `[Document: ${d.title}]\n${d.content}`)
            .join('\n\n');
    }
}
