// electron/services/interviewKnowledge/__tests__/InterviewKnowledgeIpcFree.test.mjs
//
// Mirrors ProfileIntelligenceGate.test.mjs's pattern but asserts the OPPOSITE:
// the whole point of the Interview Knowledge feature
// (docs/specs/oss-knowledge-rag-spec.md) is that it is NOT behind the
// Pro/trial paywall. This pins that property so a future edit can't
// accidentally reintroduce isProOrTrialActive() into one of these handlers.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSafeHandle, sliceSafeHandleBlock } from '../../__tests__/ipcTestUtils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(__dirname, '../../../ipcHandlers.ts');

const KNOWLEDGE_DOC_HANDLERS = [
  'knowledge-doc:add-text',
  'knowledge-doc:add-file',
  'knowledge-doc:add-folder',
  'knowledge-doc:list',
  'knowledge-doc:delete',
  'knowledge-doc:get-status',
  'knowledge-collection:create',
  'knowledge-collection:list',
  'knowledge-collection:update',
  'knowledge-collection:delete',
  'knowledge-collection:get-active',
  'knowledge-collection:set-active',
];

describe('Interview Knowledge IPC: must stay free of the Pro/trial gate', () => {
  const source = fs.readFileSync(SOURCE, 'utf8');

  for (const handler of KNOWLEDGE_DOC_HANDLERS) {
    test(`handler "${handler}" exists and never calls isProOrTrialActive()`, () => {
      const idx = findSafeHandle(source, handler);
      assert.ok(idx >= 0, `Handler ${handler} not found in ipcHandlers.ts`);

      const slice = sliceSafeHandleBlock(source, handler).slice(0, 3000);
      assert.ok(
        !slice.includes('isProOrTrialActive'),
        `Handler ${handler} must NOT call isProOrTrialActive() — this feature is deliberately free-tier`
      );
      assert.ok(
        slice.includes('InterviewKnowledgeRetriever'),
        `Handler ${handler} should delegate to InterviewKnowledgeRetriever`
      );
    });
  }
});
