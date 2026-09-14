// electron/audio/__tests__/ElevenLabsSilenceGating.test.mjs
//
// Pins the silence-skip logic that stops ElevenLabsStreamingSTT from
// streaming dead air: isSilentPcmBuffer (RMS check, same threshold as
// OpenAIStreamingSTT's REST-fallback silence skip) and shouldSkipSilentSend
// (the hangover — don't skip until N consecutive silent buffers, so real
// speech's trailing edge is never clipped; resume is instant on the very
// next non-silent buffer).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadModule() {
  try {
    const distPath = path.resolve(__dirname, '../../../dist-electron/electron/audio/ElevenLabsStreamingSTT.js');
    return await import(pathToFileURL(distPath).href);
  } catch {
    const srcPath = path.resolve(__dirname, '../ElevenLabsStreamingSTT.ts');
    return await import(pathToFileURL(srcPath).href);
  }
}

function silentBuffer(len = 4000) {
  return new Int16Array(len); // all zeros
}

function loudBuffer(len = 4000, amplitude = 5000) {
  const arr = new Int16Array(len);
  for (let i = 0; i < len; i++) arr[i] = amplitude * Math.sin(i / 4);
  return arr;
}

describe('isSilentPcmBuffer', () => {
  test('an all-zero buffer is silent', async () => {
    const { isSilentPcmBuffer } = await loadModule();
    assert.equal(isSilentPcmBuffer(silentBuffer()), true);
  });

  test('a loud sine-wave buffer is not silent', async () => {
    const { isSilentPcmBuffer } = await loadModule();
    assert.equal(isSilentPcmBuffer(loudBuffer()), false);
  });

  test('an empty buffer is treated as silent', async () => {
    const { isSilentPcmBuffer } = await loadModule();
    assert.equal(isSilentPcmBuffer(new Int16Array(0)), true);
  });

  test('respects a custom threshold', async () => {
    const { isSilentPcmBuffer } = await loadModule();
    const quiet = loudBuffer(4000, 30); // RMS well under the default 50 threshold
    assert.equal(isSilentPcmBuffer(quiet), true);
    assert.equal(isSilentPcmBuffer(quiet, 10), false); // but louder than a stricter threshold
  });
});

describe('shouldSkipSilentSend', () => {
  test('does not skip below the hangover count', async () => {
    const { shouldSkipSilentSend } = await loadModule();
    assert.equal(shouldSkipSilentSend(1), false);
    assert.equal(shouldSkipSilentSend(3), false); // exactly at the default hangover — still sends this one
  });

  test('skips once past the hangover count', async () => {
    const { shouldSkipSilentSend } = await loadModule();
    assert.equal(shouldSkipSilentSend(4), true);
    assert.equal(shouldSkipSilentSend(10), true);
  });

  test('a resumed (non-silent) buffer resets the streak to 0, which never skips', async () => {
    const { shouldSkipSilentSend } = await loadModule();
    assert.equal(shouldSkipSilentSend(0), false);
  });

  test('respects a custom hangover value', async () => {
    const { shouldSkipSilentSend } = await loadModule();
    assert.equal(shouldSkipSilentSend(1, 0), true); // hangover 0 -> skip immediately
    assert.equal(shouldSkipSilentSend(5, 10), false);
  });
});
