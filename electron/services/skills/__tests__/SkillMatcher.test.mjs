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
});
