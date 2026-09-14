// electron/services/skills/skillMatcher.ts
//
// Automatic skill triggering: today a skill only ever runs when the user
// explicitly types "/skill-name" or "$skill-name" (ipcHandlers.ts's
// skillPrefixMatch block). This module lets an ENABLED skill fire on its own
// when the message text matches a trigger phrase the skill author explicitly
// quoted in its description — no LLM call, no fuzzy scoring, so a skill
// cannot silently misfire on unrelated content.
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

export interface AutoMatchableSkill {
    id: string;
    description: string;
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

/**
 * Returns the best-matching enabled skill for this message, or null.
 * "Best" = the skill with the most distinct matched phrases; ties broken by
 * the longest single matched phrase (a longer quoted phrase is a more
 * specific, more deliberate trigger than a short one, so it wins a tie).
 */
export function matchSkillForMessage(message: string, skills: AutoMatchableSkill[]): SkillMatchResult | null {
    const lower = String(message || '').toLowerCase();
    if (!lower.trim()) return null;

    let best: { skillId: string; hitCount: number; longestPhrase: string } | null = null;
    for (const skill of skills) {
        const phrases = extractTriggerPhrases(skill.description);
        let hitCount = 0;
        let longestPhrase = '';
        for (const phrase of phrases) {
            if (lower.includes(phrase)) {
                hitCount++;
                if (phrase.length > longestPhrase.length) longestPhrase = phrase;
            }
        }
        if (hitCount === 0) continue;
        if (
            !best ||
            hitCount > best.hitCount ||
            (hitCount === best.hitCount && longestPhrase.length > best.longestPhrase.length)
        ) {
            best = { skillId: skill.id, hitCount, longestPhrase };
        }
    }
    return best ? { skillId: best.skillId, matchedPhrase: best.longestPhrase } : null;
}
