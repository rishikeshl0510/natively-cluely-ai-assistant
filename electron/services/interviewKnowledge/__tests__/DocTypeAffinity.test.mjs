// electron/services/interviewKnowledge/__tests__/DocTypeAffinity.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadModule() {
  try {
    const distPath = path.resolve(__dirname, '../../../../dist-electron/electron/services/interviewKnowledge/docTypeAffinity.js');
    return await import(pathToFileURL(distPath).href);
  } catch {
    const srcPath = path.resolve(__dirname, '../docTypeAffinity.ts');
    return await import(pathToFileURL(srcPath).href);
  }
}

describe('inferDocTypeAffinity', () => {
  test('company-shaped question', async () => {
    const { inferDocTypeAffinity } = await loadModule();
    const s = inferDocTypeAffinity('What does this company do?');
    assert.ok(s.has('company'));
    assert.equal(s.size, 1);
  });

  test('interviewer-shaped question', async () => {
    const { inferDocTypeAffinity } = await loadModule();
    const s = inferDocTypeAffinity('Who is interviewing me today?');
    assert.ok(s.has('interviewer'));
  });

  test('role-shaped question', async () => {
    const { inferDocTypeAffinity } = await loadModule();
    const s = inferDocTypeAffinity('What are the responsibilities of this role?');
    assert.ok(s.has('role'));
  });

  test('resume-shaped question', async () => {
    const { inferDocTypeAffinity } = await loadModule();
    const s = inferDocTypeAffinity('Tell me about my experience with backend systems.');
    assert.ok(s.has('resume'));
  });

  test('compound question can match more than one type', async () => {
    const { inferDocTypeAffinity } = await loadModule();
    const s = inferDocTypeAffinity('How does my experience match this role?');
    assert.ok(s.has('resume'));
    assert.ok(s.has('role'));
  });

  test('no signal returns an empty set, never throws, never guesses', async () => {
    const { inferDocTypeAffinity } = await loadModule();
    const s = inferDocTypeAffinity('What time is it?');
    assert.equal(s.size, 0);
  });
});
