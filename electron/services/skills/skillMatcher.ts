// electron/services/skills/skillMatcher.ts
//
// Automatic skill triggering: today a skill only ever runs when the user
// explicitly types "/skill-name" or "$skill-name" (ipcHandlers.ts's
// skillPrefixMatch block). This module lets an ENABLED skill fire on its own
// when the message text matches a trigger phrase the skill author explicitly
// quoted in its description — no LLM call, so a skill cannot silently
// misfire on unrelated content, and no network round trip, so this stays
// synchronous and zero-latency on the live auto-answer hot path (this runs
// inline before dispatch on every turn — see SkillsManager's hot-path
// comment on its own cache).
//
// DELIBERATE DESIGN: match ONLY on double-quoted phrases in `description`,
// not on the whole description's prose. A description is written to EXPLAIN
// the skill to a human reading a skill list; large parts of it (examples,
// caveats, "based on research including...") are not trigger conditions and
// would produce false positives if matched wholesale. Quoted phrases are
// different — they are the skill author explicitly saying "this exact
// wording means invoke me," the same way SKILL_AUTHORING.md (see
// docs/skills/SKILL_AUTHORING.md) instructs every future skill to be
// written. A skill with no quoted phrases in its description simply never
// auto-fires — it falls back to manual /skill-name invocation exactly as
// today, so this is 100% backward compatible with every existing skill that
// wasn't written with auto-matching in mind.
//
// SEMANTIC UPGRADE (2026-09-28): an exact literal substring was too brittle —
// "review this code" would not fire for "can you review my code real quick"
// or "could you check this code over", both plainly the same trigger spoken
// differently. A live question is transcribed speech, not typed text: it
// carries fillers, reordering, and STT artifacts a literal match cannot
// absorb. This adds a FUZZY tier (word-overlap containment, order-independent,
// tolerant of one missing content word) below the exact tier, scored lower so
// an exact quoted-phrase hit always outranks a fuzzy one. Deliberately NOT an
// embedding/LLM call — see the latency note above.

export interface AutoMatchableSkill {
    id: string;
    description: string;
    /**
     * Optional author-declared AnswerType tags (AnswerPlanner.ts's
     * `AnswerType` union, e.g. 'system_design_answer', 'coding_question_
     * answer') this skill applies to. Purely additive (2026-09-28, user:
     * "let that find the correct skill for it, the answertype") — a skill
     * with no tags behaves exactly as before, keyword-matched only. This
     * reuses AnswerPlanner's classification, which is computed on every
     * turn anyway for the coding-contract trigger, so it costs nothing
     * extra — no new LLM call, unlike a dedicated semantic matcher would.
     */
    answerTypes?: string[];
}

/** Phrases the skill author quoted as literal trigger wording, lowercased. Empty array = this skill never auto-fires. */
export function extractTriggerPhrases(description: string): string[] {
    const matches = [...String(description || '').matchAll(/"([^"]{2,60})"/g)];
    return matches.map((m) => m[1].trim().toLowerCase()).filter((p) => p.length > 0);
}

export interface SkillMatchResult {
    skillId: string;
    matchedPhrase: string;
}

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'to', 'of', 'and', 'or', 'is', 'are', 'my', 'your', 'this', 'that',
    'me', 'you', 'i', 'please', 'can', 'could', 'would', 'just', 'quick', 'real', 'kindly',
]);

function contentWords(phrase: string): string[] {
    return phrase
        .split(/[^a-z0-9']+/i)
        .map((w) => w.toLowerCase())
        .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Fuzzy containment: what fraction of the phrase's CONTENT words (stop words
 * excluded on both sides) appear anywhere in the message, order-independent.
 *
 * Requires at least TWO content words. A phrase that reduces to one content
 * word ("can you help" -> just "help") has no reordering/paraphrase to
 * absorb in the first place — fuzzy matching it would fire on any message
 * containing that one common word anywhere, which is exactly the false-
 * positive risk the exact-substring tier was designed to avoid. A one-word
 * trigger is already served correctly by the exact tier.
 */
function fuzzyContainment(phrase: string, messageWords: Set<string>): number {
    const words = contentWords(phrase);
    if (words.length < 2) return 0;
    let hit = 0;
    for (const w of words) if (messageWords.has(w)) hit++;
    return hit / words.length;
}

/** A fuzzy hit needs most of the phrase's content words present — tolerant of one missing word on longer phrases, but never a majority-absent match. */
const FUZZY_THRESHOLD = 0.75;

/**
 * Returns the best-matching enabled skill for this message, or null.
 *
 * Two tiers, exact always outranking fuzzy:
 *   - EXACT: the phrase appears as a literal substring (unchanged behavior).
 *   - FUZZY: the phrase's content words are mostly present, in any order —
 *     catches paraphrased/reordered speech an exact substring misses.
 *
 * Within a tier, "best" = the skill with the most distinct matched phrases;
 * ties broken by the longest single matched phrase (a longer quoted phrase is
 * a more specific, more deliberate trigger than a short one).
 */
export function matchSkillForMessage(message: string, skills: AutoMatchableSkill[]): SkillMatchResult | null {
    const lower = String(message || '').toLowerCase();
    if (!lower.trim()) return null;
    const messageWords = new Set(lower.split(/[^a-z0-9']+/i).filter(Boolean));

    let bestExact: { skillId: string; hitCount: number; longestPhrase: string } | null = null;
    let bestFuzzy: { skillId: string; hitCount: number; longestPhrase: string } | null = null;

    for (const skill of skills) {
        const phrases = extractTriggerPhrases(skill.description);
        let exactHits = 0, exactLongest = '';
        let fuzzyHits = 0, fuzzyLongest = '';
        for (const phrase of phrases) {
            if (lower.includes(phrase)) {
                exactHits++;
                if (phrase.length > exactLongest.length) exactLongest = phrase;
                continue; // an exact hit is also trivially a fuzzy hit — count it once, at the stronger tier
            }
            if (fuzzyContainment(phrase, messageWords) >= FUZZY_THRESHOLD) {
                fuzzyHits++;
                if (phrase.length > fuzzyLongest.length) fuzzyLongest = phrase;
            }
        }
        if (exactHits > 0 && (
            !bestExact || exactHits > bestExact.hitCount ||
            (exactHits === bestExact.hitCount && exactLongest.length > bestExact.longestPhrase.length)
        )) {
            bestExact = { skillId: skill.id, hitCount: exactHits, longestPhrase: exactLongest };
        }
        if (fuzzyHits > 0 && (
            !bestFuzzy || fuzzyHits > bestFuzzy.hitCount ||
            (fuzzyHits === bestFuzzy.hitCount && fuzzyLongest.length > bestFuzzy.longestPhrase.length)
        )) {
            bestFuzzy = { skillId: skill.id, hitCount: fuzzyHits, longestPhrase: fuzzyLongest };
        }
    }

    const winner = bestExact ?? bestFuzzy;
    return winner ? { skillId: winner.skillId, matchedPhrase: winner.longestPhrase } : null;
}

/**
 * Match by the question's already-computed AnswerPlanner classification
 * (2026-09-28, user: "use it as only signal" — this is the SOLE matcher on
 * the live auto-answer path, IntelligenceEngine.ts's WTA V3 skill-injection
 * site; `matchSkillForMessage` above is no longer consulted there, though it
 * remains available for other callers, e.g. manual typed chat). A skill only
 * participates if its author explicitly tagged it with `answerTypes` in
 * frontmatter — an untagged skill is never selected by this function.
 *
 * Category first, then identity: `answerType` narrows to the skills tagged
 * for this turn's category (deterministic exact-set membership — `answerType`
 * is itself already a classifier's output, so fuzziness on top of it would
 * only compound uncertainty). When more than one enabled skill shares that
 * tag (2026-09-28, user: "we might have same answer type for multiple"),
 * that alone can't say WHICH one applies — fall back to `matchSkillForMessage`
 * scoped to just those candidates, so the author's own quoted trigger wording
 * breaks the tie instead of an arbitrary list-order pick. A single-candidate
 * category skips this step entirely (its own quoted phrases don't have to
 * match — the category match already earned it the slot).
 */
export function matchSkillByAnswerType(
    answerType: string | null | undefined,
    skills: AutoMatchableSkill[],
    questionText?: string,
): SkillMatchResult | null {
    if (!answerType) return null;
    const candidates = skills.filter((s) => s.answerTypes?.includes(answerType));
    if (candidates.length === 0) return null;
    if (candidates.length === 1) {
        return { skillId: candidates[0].id, matchedPhrase: `[answerType:${answerType}]` };
    }
    const tieBreak = matchSkillForMessage(String(questionText || ''), candidates);
    if (tieBreak) return tieBreak;
    // No candidate's quoted phrases matched the live text either — still
    // resolve to SOMETHING rather than silently answering with no skill at
    // all, since the category match is real signal even without a phrase hit.
    return { skillId: candidates[0].id, matchedPhrase: `[answerType:${answerType}, untied]` };
}
