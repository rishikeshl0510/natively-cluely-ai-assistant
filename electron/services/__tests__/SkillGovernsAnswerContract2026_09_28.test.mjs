// electron/services/__tests__/SkillGovernsAnswerContract2026_09_28.test.mjs
//
// User report (2026-09-28): a matched skill was a passive footer the model
// could weigh however it liked against the mode/coding-contract instructions
// already composed earlier in the prompt — in practice it usually lost,
// which is not what a skill is supposed to be ("it is supposed to be a
// contract bro"). Two things had to be verified together, end to end:
//
//   1. FETCH: a live, spoken-transcript-shaped question actually matches the
//      right skill (matchSkillForMessage against skillMatcher.ts's exact +
//      fuzzy tiers) and SkillsManager renders it into a promptBlock.
//   2. GOVERN: once matched, the composed system prompt tells the model the
//      skill's instructions are AUTHORITATIVE for this turn's shape — not
//      just "also consider this" — while still preserving whatever safety/
//      evidence rules were already composed (composeWtaSystemPrompt in
//      electron/llm/wtaSystemPrompt.ts, and the matching inline site in
//      IntelligenceEngine.ts's V3 auto-answer path).
//
// Fetch and govern are independent failure modes — a skill can match
// correctly and still lose the conflict once in the prompt (the bug this
// fixes), or the governing language can be correct while matching itself is
// broken (a different bug). Both are asserted here so a regression in either
// one is caught on its own.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

async function loadSkillMatcher() {
    try {
        const distPath = path.resolve(root, 'dist-electron/electron/services/skills/skillMatcher.js');
        return await import(pathToFileURL(distPath).href);
    } catch {
        const srcPath = path.resolve(root, 'electron/services/skills/skillMatcher.ts');
        return await import(pathToFileURL(srcPath).href);
    }
}

async function loadComposeWtaSystemPrompt() {
    const distPath = path.resolve(root, 'dist-electron/electron/llm/index.js');
    return (await import(pathToFileURL(distPath).href)).composeWtaSystemPrompt;
}

// ---------------------------------------------------------------------------
// 1. FETCH — the skill is actually found for a realistic live-question shape
// ---------------------------------------------------------------------------
describe('skill fetch: a live question actually matches its skill', () => {
    test('exact quoted phrase, spoken verbatim, matches', async () => {
        const { matchSkillForMessage } = await loadSkillMatcher();
        const skills = [
            { id: 'system-design', description: 'Use when asked to "design a URL shortener" or "design a rate limiter".' },
        ];
        const result = matchSkillForMessage('Can you design a URL shortener for me?', skills);
        assert.ok(result, 'a message containing the exact quoted trigger must match');
        assert.equal(result.skillId, 'system-design');
        assert.equal(result.matchedPhrase, 'design a url shortener');
    });

    test('paraphrased/reordered speech (STT-shaped) still matches via the fuzzy tier', async () => {
        const { matchSkillForMessage } = await loadSkillMatcher();
        const skills = [
            { id: 'code-review', description: 'Use when the user asks to "review this code" before merging.' },
        ];
        // Same content words as "review this code", reordered and padded the
        // way transcribed speech actually arrives — no literal substring match.
        const result = matchSkillForMessage('could you go ahead and review my code real quick', skills);
        assert.ok(result, 'a paraphrased spoken variant must still match via fuzzy containment');
        assert.equal(result.skillId, 'code-review');
    });

    test('a message matching no trigger phrase fetches nothing (no false positive)', async () => {
        const { matchSkillForMessage } = await loadSkillMatcher();
        const skills = [
            { id: 'system-design', description: 'Use when asked to "design a URL shortener".' },
        ];
        const result = matchSkillForMessage('what is your greatest weakness', skills);
        assert.equal(result, null, 'an unrelated question must not fetch an unrelated skill');
    });
});

// ---------------------------------------------------------------------------
// 2. GOVERN — once fetched, the composed prompt makes the skill authoritative
// ---------------------------------------------------------------------------
describe('skill govern: the composed prompt makes the skill authoritative, not optional', () => {
    const skill = { id: 'system-design', name: 'System Design', promptBlock: '<active_skill>Always open with a one-sentence restatement.</active_skill>' };

    test('composeWtaSystemPrompt: V3 system is preserved AND the skill is framed as governing', async () => {
        const composeWtaSystemPrompt = await loadComposeWtaSystemPrompt();
        const out = composeWtaSystemPrompt('V3 SYSTEM PROMPT WITH MODE + CONTRACT RULES', 'LEGACY OVERRIDE', skill);

        assert.ok(out.startsWith('V3 SYSTEM PROMPT WITH MODE + CONTRACT RULES'),
            'earlier safety/evidence/mode composition must still lead the prompt, not be discarded');
        assert.ok(out.includes(skill.promptBlock), 'the skill promptBlock itself must be present verbatim');

        // The governing language, not just presence — this is the actual fix.
        // A skill that is merely APPENDED (the old bug) would pass every
        // assertion above while still losing the conflict at generation time.
        assert.match(out, /GOVERNS THIS TURN/i, 'the skill section must be explicitly framed as governing this turn');
        assert.match(out, /authoritative format/i, 'the model must be told the skill is authoritative, not optional');
        assert.match(out, /skill wins/i, 'a formatting conflict between the skill and earlier instructions must resolve to the skill');

        // Order matters: the governing framing must appear strictly AFTER the
        // v3/mode content, mirroring how it's actually composed (skill can't
        // govern content the model hasn't read yet).
        const modeIdx = out.indexOf('V3 SYSTEM PROMPT WITH MODE + CONTRACT RULES');
        const governsIdx = out.search(/GOVERNS THIS TURN/i);
        assert.ok(modeIdx < governsIdx, 'the governing skill section must come after the mode/contract content it overrides');
    });

    test('no active skill -> byte-identical to the V3 prompt (inert on ordinary turns)', async () => {
        const composeWtaSystemPrompt = await loadComposeWtaSystemPrompt();
        assert.equal(
            composeWtaSystemPrompt('V3 SYSTEM PROMPT', 'LEGACY OVERRIDE', undefined),
            'V3 SYSTEM PROMPT',
            'a turn with no matched skill must be unaffected by this change',
        );
    });

    test('safety/evidence rules are not disclaimed away by the governing language', async () => {
        const composeWtaSystemPrompt = await loadComposeWtaSystemPrompt();
        const out = composeWtaSystemPrompt('V3 SYSTEM PROMPT', 'LEGACY OVERRIDE', skill);
        // The precedence shift must be scoped to FORMAT, not a blanket
        // "ignore everything above" — that would be a real regression
        // (a skill could otherwise instruct around safety/grounding rules).
        assert.match(out, /safety[\s\S]{0,80}still apply|still apply[\s\S]{0,80}safety/i,
            'the directive must explicitly carve out safety/evidence rules as still binding');
    });

    test('the V3 auto-answer inline site (IntelligenceEngine.ts) uses the same governing framing', () => {
        const source = read('electron/IntelligenceEngine.ts');
        assert.match(source, /GOVERNS THIS TURN/,
            'the live auto-answer path (not just the manual-chat/legacy composer) must carry the same precedence directive');
        assert.match(source, /_skillPromptBlock[\s\S]{0,40}\?[\s\S]{0,200}GOVERNS THIS TURN/,
            'the governing framing must be applied at the actual _skillPromptBlock injection site, not just exist somewhere in the file');
    });
});

// ---------------------------------------------------------------------------
// 3. FETCH-BY-CLASSIFICATION (2026-09-28, user: "use it as only signal" /
//    "answertype should be tagged") — the live auto-answer path selects a
//    skill by the turn's already-computed AnswerPlanner classification, not
//    by re-scanning the question text for quoted phrases. Pinned as a source
//    assertion (like the test above) rather than executing IntelligenceEngine
//    directly, since that class needs heavy Electron/DB mocking the rest of
//    this file deliberately avoids — the previous PR #429-style regression
//    (skill injection silently discarded under V3) was exactly this class of
//    "the right helper exists, but the live call site stopped using it"
//    drift, so pinning the call site itself is the point, not a nice-to-have.
describe('skill fetch-by-answerType: the live auto-answer path routes on classification, not keywords', () => {
    test('the WTA V3 skill-match site calls matchSkillByAnswerType, not matchSkillForMessage', () => {
        const source = read('electron/IntelligenceEngine.ts');
        assert.match(source, /matchSkillByAnswerType/,
            'the live auto-answer path must import/call matchSkillByAnswerType');
        assert.match(source, /matchSkillByAnswerType\(answerPlan\.answerType,\s*enabledSkills/,
            'the call must pass this turn\'s own answerPlan.answerType and the already-filtered enabledSkills list');
    });

    test('the match is scoped to ENABLED skills only, same list either matcher would use', () => {
        const source = read('electron/IntelligenceEngine.ts');
        assert.match(source, /listSkills\(\)\.filter\(\(s: any\) => s\.enabled !== false\)/,
            'skill fetching for answerType routing must exclude disabled skills, same as the keyword matcher always did');
    });
});
