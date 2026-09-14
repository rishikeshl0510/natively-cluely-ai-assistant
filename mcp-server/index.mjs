#!/usr/bin/env node
// mcp-server/index.mjs
//
// Local MCP server for Natively's free-tier "Interview Knowledge" feature
// (docs/specs/oss-knowledge-rag-spec.md). Lets any MCP client — Claude
// Desktop, Claude Code, another agent doing company research — add
// companies and documents directly into the same SQLite database Natively
// itself reads from, without going through the app's UI.
//
// WHY A SEPARATE PACKAGE. This process is launched by the MCP client as a
// plain `node` process, not through Electron. The main app's better-sqlite3
// is rebuilt against Electron's Node ABI (scripts/rebuild-native-electron.js,
// run from postinstall) — loading THAT build from plain Node throws a
// NODE_MODULE_VERSION mismatch. This package's own `npm install` builds its
// own better-sqlite3 against whatever Node runs it, so the two never touch.
//
// WHY DIRECT SQLITE ACCESS INSTEAD OF CALLING INTO THE APP. Natively may not
// be running when this server is asked to add something (an agent doing
// research at 2am with the app closed should still be able to file the
// result away). SQLite's WAL journal mode (already the mode Natively sets —
// electron/db/DatabaseManager.ts:376) is specifically designed for safe
// multi-process access: this connection can read and write the same file
// concurrently with a running Natively instance. What this server does NOT
// do is chunk/embed a newly added document itself — that requires the same
// heavyweight EmbeddingPipeline/ONNX machinery the main app already owns
// (electron/services/interviewKnowledge/InterviewKnowledgeRetriever.ts).
// Instead, a doc inserted here lands with no vectors yet; the next time
// Natively runs a retrieval, ensureAllIndexed() (called from
// electron/LLMHelper.ts before every Interview Knowledge query) notices the
// un-indexed row and embeds it then. So: this server is a thin, always-
// available WRITER; the running app is the only INDEXER. A document added
// while Natively is closed simply gets indexed the next time it's opened
// and asked a question.
//
// SCHEMA. Mirrors electron/db/DatabaseManager.ts's migrations v32-v34
// exactly (interview_knowledge_docs, interview_knowledge_collections,
// interview_knowledge_state) so this server works identically whether it
// runs before or after Natively has ever launched — CREATE TABLE IF NOT
// EXISTS on both sides makes whichever one runs first a no-op for the other.
// If that schema ever changes, update both places; there is no shared
// import between them because this package cannot depend on Electron-only
// TypeScript sources.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PRODUCT_NAME = 'Natively';

/** Replicates Electron's app.getPath('userData') without an Electron runtime. */
function resolveUserDataPath() {
    if (process.env.NATIVELY_TEST_USERDATA) return process.env.NATIVELY_TEST_USERDATA;
    const home = os.homedir();
    switch (process.platform) {
        case 'win32':
            return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), PRODUCT_NAME);
        case 'darwin':
            return path.join(home, 'Library', 'Application Support', PRODUCT_NAME);
        default:
            return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), PRODUCT_NAME);
    }
}

function openDb() {
    const userDataPath = resolveUserDataPath();
    fs.mkdirSync(userDataPath, { recursive: true });
    const dbPath = path.join(userDataPath, 'natively.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.exec(`
        CREATE TABLE IF NOT EXISTS interview_knowledge_collections (
            id                TEXT PRIMARY KEY,
            name              TEXT NOT NULL,
            interviewer_name  TEXT,
            context_notes     TEXT,
            created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS interview_knowledge_docs (
            id              TEXT PRIMARY KEY,
            title           TEXT NOT NULL,
            content         TEXT NOT NULL,
            content_sha256  TEXT NOT NULL,
            source          TEXT NOT NULL DEFAULT 'paste',
            created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            collection_id   TEXT REFERENCES interview_knowledge_collections(id) ON DELETE CASCADE,
            doc_type        TEXT NOT NULL DEFAULT 'other'
        );
        CREATE INDEX IF NOT EXISTS idx_interview_knowledge_docs_created ON interview_knowledge_docs(created_at);
        CREATE INDEX IF NOT EXISTS idx_interview_knowledge_docs_collection ON interview_knowledge_docs(collection_id);
        CREATE TABLE IF NOT EXISTS interview_knowledge_state (
            id                    INTEGER PRIMARY KEY CHECK (id = 1),
            active_collection_id  TEXT REFERENCES interview_knowledge_collections(id) ON DELETE SET NULL
        );
    `);
    return db;
}

const DOC_TYPES = ['resume', 'company', 'interviewer', 'role', 'other'];

const db = openDb();

// ── Skills (electron/services/SkillsManager.ts) ──────────────────────────
//
// Unlike knowledge docs, skills are plain files — SkillsManager reads
// <userData>/skills/<folder>/SKILL.md fresh on every listSkills() call, no
// cache to invalidate, so a file this server writes is picked up by a
// running Natively instance immediately with no coordination needed.
//
// Mirrors SkillsManager.ts's slugify() and BUILTIN_SKILL_IDS exactly so a
// skill created here classifies identically to one uploaded through the
// app's own Settings > Skills panel. Keep in sync with that file.
const BUILTIN_SKILL_IDS = new Set(['humanize-text', 'humanize-ai-text']);
const MAX_SKILL_FILE_BYTES = 100 * 1024;
// Mirrors SkillsManager.ts's MAX_SKILL_INSTRUCTIONS_CHARS_FOR_PROMPT — the
// file can be up to MAX_SKILL_FILE_BYTES, but only this much of `instructions`
// is actually injected into a live prompt when the skill fires (the rest is
// silently truncated at answer time). Warn here so an author sees it at
// creation time instead of discovering the truncation later.
const MAX_SKILL_INSTRUCTIONS_CHARS_FOR_PROMPT = 6000;

function slugify(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}

function skillsDir() {
    return path.join(resolveUserDataPath(), 'skills');
}

function buildSkillMarkdown({ name, description, instructions }) {
    // YAML frontmatter — a bare `key: value` line is enough for the app's
    // parser (parseSkillMarkdown in SkillsManager.ts); no need for a full
    // YAML library. Escaping: wrap in double quotes and escape embedded
    // quotes/backslashes if the value contains a colon or starts with a
    // character that would otherwise be parsed as YAML syntax.
    const needsQuoting = (s) => /^[\s"'>|*&!%#@,[\]{}]/.test(s) || /:\s|#/.test(s);
    const yamlValue = (s) => {
        const str = String(s).replace(/\r\n/g, ' ').replace(/\n/g, ' ').trim();
        return needsQuoting(str) ? `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : str;
    };
    return `---\nname: ${yamlValue(name)}\ndescription: ${yamlValue(description)}\n---\n\n${String(instructions).trim()}\n`;
}

function findCollectionByName(name) {
    return db.prepare('SELECT * FROM interview_knowledge_collections WHERE name = ? COLLATE NOCASE').get(name);
}

function createCollection({ name, interviewerName, contextNotes }) {
    const id = `ikc_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    db.prepare(`
        INSERT INTO interview_knowledge_collections (id, name, interviewer_name, context_notes, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(id, name.trim(), interviewerName?.trim() || null, contextNotes?.trim() || null, createdAt);
    return { id, name: name.trim(), interviewerName: interviewerName?.trim() || null, contextNotes: contextNotes?.trim() || null, createdAt };
}

const server = new McpServer({ name: 'natively-interview-knowledge', version: '1.0.0' });

server.tool(
    'create_skill',
    'Create a new Natively Skill — a Q&A answer template: when a question of a given kind comes up live (typed or spoken and auto-answered), answer it a given way. The topic is unrestricted — coding, behavioral, sales, system design, literally anything — what makes it a Skill is that trigger-plus-template shape, not the subject matter. IMPORTANT: for automatic triggering to work, `description` MUST include the literal trigger wording in double quotes, e.g. \'Use when the user asks to "review this code" or "check my PR"\' — see docs/skills/SKILL_AUTHORING.md for the full guide and examples. A description with no quoted phrases means the skill will never fire automatically (manual-only, which this app no longer has a UI for) — always include at least one quoted trigger phrase unless the skill is intentionally inert.',
    {
        name: z.string().min(1).describe('Human-readable skill name, e.g. "Code Review Checklist"'),
        description: z.string().min(1).describe('What KIND of question this answers AND when to trigger it. MUST include at least one double-quoted literal trigger phrase for automatic matching to work, e.g. \'Use when the user asks to "review this code"\'.'),
        instructions: z.string().min(1).describe('The answer template the agent follows once triggered — the concrete shape the answer should take for this question type, written as directives, e.g. "1. State the approach first. 2. Give complexity. 3. Then code."'),
        overwrite: z.boolean().optional().describe('Overwrite an existing skill with the same id. Default false (refuses if one already exists).'),
    },
    async ({ name, description, instructions, overwrite }) => {
        const id = slugify(name);
        if (!id) return { content: [{ type: 'text', text: 'Could not derive a valid id from that name — use letters, numbers, hyphens, or underscores.' }], isError: true };
        if (BUILTIN_SKILL_IDS.has(id)) {
            return { content: [{ type: 'text', text: `"${id}" collides with a built-in skill and cannot be created or overwritten.` }], isError: true };
        }
        const markdown = buildSkillMarkdown({ name, description, instructions });
        if (Buffer.byteLength(markdown, 'utf8') > MAX_SKILL_FILE_BYTES) {
            return { content: [{ type: 'text', text: `Skill content is too large (${Buffer.byteLength(markdown, 'utf8')} bytes, max ${MAX_SKILL_FILE_BYTES}).` }], isError: true };
        }
        const dir = path.join(skillsDir(), id);
        const skillPath = path.join(dir, 'SKILL.md');
        if (fs.existsSync(skillPath) && !overwrite) {
            return { content: [{ type: 'text', text: `A skill with id "${id}" already exists. Pass overwrite:true to replace it.` }], isError: true };
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(skillPath, markdown, 'utf8');
        const quotedPhraseCount = (description.match(/"[^"]{2,60}"/g) || []).length;
        const warnings = [];
        if (quotedPhraseCount === 0) {
            warnings.push('description has no double-quoted trigger phrase — this skill will never fire automatically. Consider revising the description or calling create_skill again with overwrite:true.');
        }
        if (instructions.length > MAX_SKILL_INSTRUCTIONS_CHARS_FOR_PROMPT) {
            warnings.push(`instructions are ${instructions.length} chars, over the ${MAX_SKILL_INSTRUCTIONS_CHARS_FOR_PROMPT}-char live-prompt cap — only the first ${MAX_SKILL_INSTRUCTIONS_CHARS_FOR_PROMPT} chars will actually be sent when this skill fires (the rest is truncated at answer time, to protect live-turn latency). A Skill is meant to be a short answer template, not a document — trim it with overwrite:true.`);
        }
        const warning = warnings.length ? `\n\nWARNING: ${warnings.join('\n\nWARNING: ')}` : '';
        return { content: [{ type: 'text', text: `Created skill "${name}" (id: ${id}) at ${skillPath}.${warning}` }] };
    },
);

server.tool(
    'list_skills',
    'List every Natively Skill currently installed (built-in and user-created), with their descriptions and whether each has an automatic trigger phrase.',
    {},
    async () => {
        let entries;
        try {
            entries = fs.readdirSync(skillsDir(), { withFileTypes: true });
        } catch {
            return { content: [{ type: 'text', text: 'No skills directory found yet.' }] };
        }
        const rows = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const skillPath = path.join(skillsDir(), entry.name, 'SKILL.md');
            try {
                const content = fs.readFileSync(skillPath, 'utf8');
                const nameMatch = content.match(/^name:\s*(.+)$/m);
                const descMatch = content.match(/^description:\s*([\s\S]*?)(?:\n\w+:|\n---)/m) || content.match(/^description:\s*(.+)$/m);
                const description = (descMatch?.[1] || '').replace(/^["']|["']$/g, '').trim();
                const hasTrigger = /"[^"]{2,60}"/.test(description);
                rows.push(`- ${(nameMatch?.[1] || entry.name).replace(/^["']|["']$/g, '')} (id: ${slugify(nameMatch?.[1] || entry.name)}) ${hasTrigger ? '[auto-triggers]' : '[manual/inert — no quoted trigger phrase]'}`);
            } catch { /* skip unreadable/malformed entries */ }
        }
        return { content: [{ type: 'text', text: rows.length ? rows.join('\n') : 'No skills installed.' }] };
    },
);

server.tool(
    'create_knowledge_company',
    'Create a new company/interview grouping in Natively\'s Interview Knowledge base (e.g. "Acme Corp, onsite loop"). Documents added under this company retrieve together, scoped to it.',
    {
        name: z.string().min(1).describe('Company or interview name, e.g. "Acme Corp"'),
        interviewerName: z.string().optional().describe('Name of the person interviewing, if known'),
        contextNotes: z.string().optional().describe('Free-text notes about this interview (round type, focus areas, etc.)'),
    },
    async ({ name, interviewerName, contextNotes }) => {
        const existing = findCollectionByName(name);
        if (existing) {
            return { content: [{ type: 'text', text: `A company named "${existing.name}" already exists (id: ${existing.id}). Use add_knowledge_document with companyName to add to it.` }] };
        }
        const created = createCollection({ name, interviewerName, contextNotes });
        return { content: [{ type: 'text', text: `Created company "${created.name}" (id: ${created.id}).` }] };
    },
);

server.tool(
    'add_knowledge_document',
    'Add a document (resume, job description, company research, interviewer notes, etc.) into Natively\'s Interview Knowledge base. If companyName is given and no company with that name exists yet, it is created automatically. The app indexes the document for retrieval the next time Natively is running and answers a question — this call does not require Natively to be open.',
    {
        title: z.string().min(1).describe('Short title, e.g. "Acme Corp — Q3 earnings summary"'),
        content: z.string().min(1).describe('Full text content of the document'),
        companyName: z.string().optional().describe('Company/interview name to file this under. Created automatically if it does not already exist. Omit to leave the document unfiled.'),
        docType: z.enum(DOC_TYPES).optional().describe('What kind of document this is — helps Natively prioritize it for matching questions (e.g. a "company" question favors company-typed docs). Defaults to "other".'),
    },
    async ({ title, content, companyName, docType }) => {
        let collectionId = null;
        if (companyName) {
            const existing = findCollectionByName(companyName);
            collectionId = existing ? existing.id : createCollection({ name: companyName }).id;
        }
        const id = `ik_${crypto.randomUUID()}`;
        const contentSha256 = crypto.createHash('sha256').update(content.trim()).digest('hex');
        const createdAt = new Date().toISOString();
        db.prepare(`
            INSERT INTO interview_knowledge_docs (id, title, content, content_sha256, source, created_at, collection_id, doc_type)
            VALUES (?, ?, ?, ?, 'mcp', ?, ?, ?)
        `).run(id, title.trim(), content.trim(), contentSha256, createdAt, collectionId, docType || 'other');
        const filedNote = companyName ? ` under "${companyName}"` : ' (unfiled)';
        return { content: [{ type: 'text', text: `Added "${title.trim()}"${filedNote} (id: ${id}). It will be indexed the next time Natively answers a question.` }] };
    },
);

server.tool(
    'list_knowledge_companies',
    'List every company/interview grouping currently in Natively\'s Interview Knowledge base.',
    {},
    async () => {
        const rows = db.prepare('SELECT id, name, interviewer_name, context_notes, created_at FROM interview_knowledge_collections ORDER BY created_at ASC').all();
        if (rows.length === 0) return { content: [{ type: 'text', text: 'No companies yet.' }] };
        const lines = rows.map((r) => `- ${r.name} (id: ${r.id})${r.interviewer_name ? `, interviewer: ${r.interviewer_name}` : ''}`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

server.tool(
    'list_knowledge_documents',
    'List documents in Natively\'s Interview Knowledge base, optionally scoped to one company.',
    {
        companyName: z.string().optional().describe('Only list documents filed under this company. Omit to list every document.'),
    },
    async ({ companyName }) => {
        let rows;
        if (companyName) {
            const collection = findCollectionByName(companyName);
            if (!collection) return { content: [{ type: 'text', text: `No company named "${companyName}" found.` }] };
            rows = db.prepare('SELECT id, title, doc_type, created_at FROM interview_knowledge_docs WHERE collection_id = ? ORDER BY created_at ASC').all(collection.id);
        } else {
            rows = db.prepare('SELECT id, title, doc_type, created_at FROM interview_knowledge_docs ORDER BY created_at ASC').all();
        }
        if (rows.length === 0) return { content: [{ type: 'text', text: 'No documents found.' }] };
        const lines = rows.map((r) => `- ${r.title} [${r.doc_type}] (id: ${r.id})`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
);

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error('[natively-interview-knowledge-mcp] Fatal error:', err);
    process.exit(1);
});
