// electron/services/interviewKnowledge/docTypeAffinity.ts
//
// Cheap, deterministic (no LLM call) classification of which Interview
// Knowledge document TYPE a question is most likely asking about, so
// agenticRetrieve.ts can prioritize matching chunks when truncating to
// tokenBudget/topK — the same "regex table, no model call" approach this
// codebase already uses for turn-shape classification
// (electron/llm/answerPlannerPatterns.ts backing AnswerPlanner.planAnswer),
// kept consistent rather than inventing a different technique here.
//
// This never EXCLUDES a document type — a question with no strong signal
// returns an empty affinity set, and agenticRetrieve treats that as "no
// reordering, today's behavior exactly." Boosting, never filtering: an
// affinity guess that's wrong should degrade to normal ranking, not refuse
// evidence a different document type happens to hold the answer in.

export type KnowledgeDocType = 'resume' | 'company' | 'interviewer' | 'role' | 'other';

export const KNOWLEDGE_DOC_TYPES: readonly KnowledgeDocType[] = ['resume', 'company', 'interviewer', 'role', 'other'];

const COMPANY_RE = /\b(this company|the company|what do they do|their product|their business|company('s)? (culture|mission|values|revenue|size|history)|about (them|the company))\b/i;
const INTERVIEWER_RE = /\b(the interviewer|who('s| is) interviewing|my interviewer|the person interviewing)\b/i;
const ROLE_RE = /\b(this (role|position|job)|the (role|position|job)|job description|responsibilities|what('s| is) expected of me|day.to.day|reporting to)\b/i;
const RESUME_RE = /\b(my (experience|background|resume|skills|projects)|i('ve| have) worked|tell me about (myself|yourself))\b/i;

/**
 * Returns the set of doc types this question shows a clear textual affinity
 * for. Usually 0 or 1 entries; a compound question ("how does my experience
 * match this role?") can legitimately return more than one — that's a
 * feature, not ambiguity to resolve, since agenticRetrieve boosts everything
 * in the set equally rather than picking a single winner.
 */
export function inferDocTypeAffinity(question: string): Set<KnowledgeDocType> {
    const q = String(question || '');
    const out = new Set<KnowledgeDocType>();
    if (COMPANY_RE.test(q)) out.add('company');
    if (INTERVIEWER_RE.test(q)) out.add('interviewer');
    if (ROLE_RE.test(q)) out.add('role');
    if (RESUME_RE.test(q)) out.add('resume');
    return out;
}
