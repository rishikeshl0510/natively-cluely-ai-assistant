// electron/services/__tests__/RateLimiterPriority2026_09_28.test.mjs
//
// User report (2026-09-28, live session): the auto-answer JUDGE call — small,
// fast, and on the most latency-critical path in the app (nothing downstream
// starts until it returns) — was observed queuing behind unrelated vision and
// generation calls sharing the same `gemini` RateLimiter, adding real
// wall-clock delay unrelated to the judge call's own speed. Fix: `acquire()`
// takes an optional `priority` flag that inserts the waiter at the FRONT of
// the queue instead of the back when the bucket is already empty.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadModule() {
    try {
        const distPath = path.resolve(__dirname, '../../../dist-electron/electron/services/RateLimiter.js');
        return await import(pathToFileURL(distPath).href);
    } catch {
        const srcPath = path.resolve(__dirname, '../RateLimiter.ts');
        return await import(pathToFileURL(srcPath).href);
    }
}

describe('RateLimiter priority acquire', () => {
    test('priority caller resolves before earlier-queued non-priority callers once tokens free up', async () => {
        const { RateLimiter } = await loadModule();
        // 1 token/500ms: slow enough that the sub-millisecond gap between
        // synchronous statements below can never accidentally refill a
        // token mid-test (the bug in an earlier version of this test, which
        // used a 1000/sec rate — fast enough that acquire()'s own internal
        // refill() call regenerated a token between statements and let low1
        // skip the queue entirely instead of actually waiting behind it).
        const limiter = new RateLimiter(1, 2);
        try {
            await limiter.acquire(); // drain the starting token — bucket is now empty

            const order = [];
            const low1 = limiter.acquire().then(() => order.push('low1'));
            const low2 = limiter.acquire().then(() => order.push('low2'));
            // low1/low2 are synchronously queued (FIFO push) before this line
            // ever runs — no timer needed for ordering, since nothing here
            // awaits between them.
            const prio = limiter.acquire(true).then(() => order.push('prio'));

            await Promise.all([low1, low2, prio]);
            assert.equal(order[0], 'prio', 'the priority caller must resolve before the two callers that queued ahead of it');
            assert.deepEqual(order.slice(1), ['low1', 'low2'], 'non-priority callers keep their original FIFO order relative to each other');
        } finally {
            limiter.destroy();
        }
    });

    test('a priority acquire with an immediately-available token behaves exactly like a normal one (no queueing needed)', async () => {
        const { RateLimiter } = await loadModule();
        const limiter = new RateLimiter(5, 1.0);
        try {
            const before = Date.now();
            await limiter.acquire(true);
            assert.ok(Date.now() - before < 50, 'an available token is granted immediately regardless of the priority flag');
        } finally {
            limiter.destroy();
        }
    });
});
