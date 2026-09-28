// electron/services/skills/__tests__/SkillMatcher.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadModule() {
  try {
    const distPath = path.resolve(__dirname, '../../../../dist-electron/electron/services/skills/skillMatcher.js');
    return await import(pathToFileURL(distPath).href);
  } catch {
    const srcPath = path.resolve(__dirname, '../skillMatcher.ts');
    return await import(pathToFileURL(srcPath).href);
  }
}

describe('extractTriggerPhrases', () => {
  test('extracts quoted phrases only', async () => {
    const { extractTriggerPhrases } = await loadModule();
    const phrases = extractTriggerPhrases('Trigger this skill whenever the user asks to "humanize" text or "sound more natural".');
    assert.deepEqual(phrases, ['humanize', 'sound more natural']);
  });

  test('no quotes returns an empty array — this skill never auto-fires', async () => {
    const { extractTriggerPhrases } = await loadModule();
    const phrases = extractTriggerPhrases('A general purpose helper skill with no explicit trigger wording.');
    assert.deepEqual(phrases, []);
  });
});

describe('matchSkillForMessage', () => {
  test('matches a message containing a quoted trigger phrase', async () => {
    const { matchSkillForMessage } = await loadModule();
    const skills = [
      { id: 'humanize-ai-text', description: 'Use when the user asks to "humanize" text.' },
    ];
    const result = matchSkillForMessage('Can you humanize this paragraph for me?', skills);
    assert.equal(result?.skillId, 'humanize-ai-text');
    assert.equal(result?.matchedPhrase, 'humanize');
  });

  test('no match when no quoted phrase appears in the message', async () => {
    const { matchSkillForMessage } = await loadModule();
    const skills = [
      { id: 'humanize-ai-text', description: 'Use when the user asks to "humanize" text.' },
    ];
    const result = matchSkillForMessage('What is the time complexity of quicksort?', skills);
    assert.equal(result, null);
  });

  test('a skill with no quoted phrases never auto-fires, even on an on-topic message', async () => {
    const { matchSkillForMessage } = await loadModule();
    const skills = [
      { id: 'some-skill', description: 'Helps with general writing tasks and editing.' },
    ];
    const result = matchSkillForMessage('Help me edit this general writing task please.', skills);
    assert.equal(result, null);
  });

  test('when two skills match, the one with more distinct phrase hits wins', async () => {
    const { matchSkillForMessage } = await loadModule();
    const skills = [
      { id: 'skill-a', description: 'Trigger on "review" only.' },
      { id: 'skill-b', description: 'Trigger on "review" and "code" and "pull request".' },
    ];
    const result = matchSkillForMessage('Please review this code before I open a pull request.', skills);
    assert.equal(result?.skillId, 'skill-b');
  });

  test('empty message never matches', async () => {
    const { matchSkillForMessage } = await loadModule();
    const skills = [{ id: 'humanize-ai-text', description: 'Use when the user asks to "humanize" text.' }];
    assert.equal(matchSkillForMessage('', skills), null);
    assert.equal(matchSkillForMessage('   ', skills), null);
  });

  test('FUZZY (2026-09-28): a paraphrased/reordered spoken version of a multi-word trigger still matches', async () => {
    const { matchSkillForMessage } = await loadModule();
    const skills = [
      { id: 'code-review', description: 'Use when the user asks to "review this code".' },
    ];
    // Real live speech: filler words, reordering, no exact substring.
    const result = matchSkillForMessage('could you review my code real quick before I ship it', skills);
    assert.equal(result?.skillId, 'code-review');
    assert.equal(result?.matchedPhrase, 'review this code');
  });

  test('FUZZY: an exact hit always outranks a fuzzy hit on a different skill', async () => {
    const { matchSkillForMessage } = await loadModule();
    const skills = [
      { id: 'exact-skill', description: 'Trigger on "check my pull request".' },
      { id: 'fuzzy-skill', description: 'Trigger on "check my pull request status".' },
    ];
    // Literal substring for exact-skill; fuzzy-skill's phrase is missing "status" so it's a fuzzy-only hit too.
    const result = matchSkillForMessage('please check my pull request', skills);
    assert.equal(result?.skillId, 'exact-skill');
  });

  test('FUZZY: a short phrase made entirely of stop words never fuzzy-matches (nothing distinctive to anchor on)', async () => {
    const { matchSkillForMessage } = await loadModule();
    const skills = [
      { id: 'vague-skill', description: 'Trigger on "can you help".' },
    ];
    const result = matchSkillForMessage('I was wondering if this update could help my team out today', skills);
    assert.equal(result, null);
  });

  test('FUZZY: below-threshold word overlap does not match', async () => {
    const { matchSkillForMessage } = await loadModule();
    const skills = [
      { id: 'design-skill', description: 'Trigger on "walk me through the system design".' },
    ];
    // Only "system" overlaps out of the content words (walk, system, design) — well under threshold.
    const result = matchSkillForMessage('what is a good system for watering plants', skills);
    assert.equal(result, null);
  });
});

describe('matchSkillByAnswerType', () => {
  test('matches a skill whose answerTypes includes this turn\'s classification', async () => {
    const { matchSkillByAnswerType } = await loadModule();
    const skills = [
      { id: 'system-design-skill', description: 'irrelevant here', answerTypes: ['system_design_answer'] },
      { id: 'coding-skill', description: 'irrelevant here', answerTypes: ['coding_question_answer', 'dsa_question_answer'] },
    ];
    const result = matchSkillByAnswerType('system_design_answer', skills);
    assert.equal(result?.skillId, 'system-design-skill');
  });

  test('a skill with no answerTypes tag is never selected', async () => {
    const { matchSkillByAnswerType } = await loadModule();
    const skills = [
      { id: 'untagged-skill', description: 'no answerTypes field at all' },
    ];
    const result = matchSkillByAnswerType('coding_question_answer', skills);
    assert.equal(result, null, 'an untagged skill must not fire on answerType routing');
  });

  test('no answerType classification (null/undefined) matches nothing', async () => {
    const { matchSkillByAnswerType } = await loadModule();
    const skills = [
      { id: 'coding-skill', description: 'x', answerTypes: ['coding_question_answer'] },
    ];
    assert.equal(matchSkillByAnswerType(null, skills), null);
    assert.equal(matchSkillByAnswerType(undefined, skills), null);
  });

  test('an answerType with no matching skill tag returns null (no false positive)', async () => {
    const { matchSkillByAnswerType } = await loadModule();
    const skills = [
      { id: 'coding-skill', description: 'x', answerTypes: ['coding_question_answer'] },
    ];
    const result = matchSkillByAnswerType('negotiation_answer', skills);
    assert.equal(result, null);
  });

  test('with no question text and no quoted phrases on either candidate, falls through to the first one (no crash, no null)', async () => {
    const { matchSkillByAnswerType } = await loadModule();
    const skills = [
      { id: 'first-skill', description: 'x', answerTypes: ['behavioral_interview_answer'] },
      { id: 'second-skill', description: 'y', answerTypes: ['behavioral_interview_answer'] },
    ];
    const result = matchSkillByAnswerType('behavioral_interview_answer', skills);
    assert.equal(result?.skillId, 'first-skill');
  });

  test('TIE-BREAK (2026-09-28): two skills sharing an answerType are disambiguated by quoted trigger phrase, not list order', async () => {
    const { matchSkillByAnswerType } = await loadModule();
    const skills = [
      { id: 'general-behavioral', description: 'Use for "tell me about yourself" or "why do you want this role".', answerTypes: ['behavioral_interview_answer'] },
      { id: 'fde-behavioral', description: 'Use for "how would you handle" or "walk me through a time".', answerTypes: ['behavioral_interview_answer'] },
    ];
    // The live question text matches the SECOND skill's phrase, not the first's —
    // a naive first-wins pick would return the wrong skill here.
    const result = matchSkillByAnswerType('behavioral_interview_answer', skills, 'How would you handle a production outage at 2am?');
    assert.equal(result?.skillId, 'fde-behavioral', 'the quoted-phrase tie-break must override list order');
  });

  test('TIE-BREAK: when neither shared-tag candidate\'s phrases match, still resolves to a candidate rather than null', async () => {
    const { matchSkillByAnswerType } = await loadModule();
    const skills = [
      { id: 'skill-a', description: 'Use for "some specific phrase".', answerTypes: ['negotiation_answer'] },
      { id: 'skill-b', description: 'Use for "another specific phrase".', answerTypes: ['negotiation_answer'] },
    ];
    const result = matchSkillByAnswerType('negotiation_answer', skills, 'what is your notice period');
    assert.ok(result, 'the category match alone is real signal — must not silently answer with no skill');
    assert.equal(result.skillId, 'skill-a', 'falls through to the first candidate when the tie-break itself finds nothing');
  });

  test('a SINGLE candidate for the answerType is returned even if its own quoted phrases don\'t match the live text', async () => {
    const { matchSkillByAnswerType } = await loadModule();
    const skills = [
      { id: 'only-candidate', description: 'Use for "some other wording entirely".', answerTypes: ['dsa_question_answer'] },
    ];
    // The category match alone is enough for a lone candidate — it must not
    // additionally have to win its own phrase check.
    const result = matchSkillByAnswerType('dsa_question_answer', skills, 'completely unrelated live transcript text');
    assert.equal(result?.skillId, 'only-candidate');
  });
});
