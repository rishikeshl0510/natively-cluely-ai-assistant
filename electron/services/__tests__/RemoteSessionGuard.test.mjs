// electron/services/RemoteSessionGuard.ts
//
// Detects whether this machine is currently being viewed by a real
// remote-desktop / screen-sharing session (Windows RDP/shadow via
// GetSystemMetrics through the native module, macOS Screen Sharing via an
// lsof heuristic on port 5900) — see the module doc comment for why
// Natively's existing content-protection flags (WDA_EXCLUDEFROMCAPTURE /
// NSWindowSharingNone) do not cover either path.
//
// Platform detection is injectable (createChecker(platform, native)) per the
// project's cross-platform contract, so both branches are exercised directly
// here without needing to run this suite on both operating systems. This is
// a pure, dependency-injected module (only `child_process` at the edges, and
// even that is swappable) — imported as raw .ts (Node's built-in type
// stripping), matching the LitellmModelLabel/ImeDetectorCache precedent.
// Parameter-property constructor shorthand is deliberately NOT used in the
// source for exactly this reason (Node's stripper rejects it).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'RemoteSessionGuard.ts');

const { RemoteSessionGuard, createChecker, createMacChecker, createWindowsChecker } =
  await import(pathToFileURL(SRC).href);

describe('createWindowsChecker: GetSystemMetrics-backed native check', () => {
  test('true when isRemoteSession is true (this session IS an RDP session)', () => {
    const checker = createWindowsChecker({
      getRemoteSessionState: () => ({ isRemoteSession: true, isRemoteControlled: false }),
    });
    assert.equal(checker(), true);
  });

  test('true when isRemoteControlled is true (session is being shadowed)', () => {
    const checker = createWindowsChecker({
      getRemoteSessionState: () => ({ isRemoteSession: false, isRemoteControlled: true }),
    });
    assert.equal(checker(), true);
  });

  test('false when both are false (local console, not shadowed)', () => {
    const checker = createWindowsChecker({
      getRemoteSessionState: () => ({ isRemoteSession: false, isRemoteControlled: false }),
    });
    assert.equal(checker(), false);
  });

  test('fails closed (false) when the native export is missing (stale/pre-rebuild binary)', () => {
    const checker = createWindowsChecker({});
    assert.equal(checker(), false);
  });

  test('fails closed (false) when the native call throws', () => {
    const checker = createWindowsChecker({
      getRemoteSessionState: () => {
        throw new Error('boom');
      },
    });
    assert.doesNotThrow(() => checker());
    assert.equal(checker(), false);
  });
});

describe('createMacChecker: lsof-on-port-5900 heuristic', () => {
  test('false when lsof returns only its header line (no viewer connected)', () => {
    const fakeExecFile = () => 'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n';
    const checker = createMacChecker(fakeExecFile);
    assert.equal(checker(), false);
  });

  test('true when lsof returns a header plus an established connection line', () => {
    const fakeExecFile = () =>
      'COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n' +
      'screensha  1234 root   10u  IPv4 0x0        0t0  TCP *:5900->192.168.1.5:54321 (ESTABLISHED)\n';
    const checker = createMacChecker(fakeExecFile);
    assert.equal(checker(), true);
  });

  test('fails closed (false) when lsof exits non-zero (the common "nothing found" case)', () => {
    const fakeExecFile = () => {
      const err = new Error('exit 1');
      throw err;
    };
    const checker = createMacChecker(fakeExecFile);
    assert.doesNotThrow(() => checker());
    assert.equal(checker(), false);
  });

  test('calls lsof with array args scoped to the Screen Sharing port, ESTABLISHED only', () => {
    let capturedArgs = null;
    const fakeExecFile = (cmd, args) => {
      assert.equal(cmd, 'lsof');
      capturedArgs = args;
      return '';
    };
    createMacChecker(fakeExecFile)();
    assert.ok(Array.isArray(capturedArgs), 'args must be passed as an array, never shell-interpolated');
    assert.ok(capturedArgs.some((a) => a.includes('5900')), 'must scope to port 5900');
    assert.ok(capturedArgs.some((a) => a.includes('ESTABLISHED')), 'must filter to ESTABLISHED connections only');
  });
});

describe('createChecker: platform-injectable factory', () => {
  test("platform='win32' delegates to the Windows (native) checker", () => {
    const native = { getRemoteSessionState: () => ({ isRemoteSession: true, isRemoteControlled: false }) };
    const checker = createChecker('win32', native);
    assert.equal(checker(), true);
  });

  test("platform='darwin' returns a working boolean-returning checker", () => {
    // We don't inject execFile through this path (createChecker owns the
    // real execFileSync internally for darwin) — mirrors the ImeDetector
    // precedent of asserting the CONTRACT (boolean, no throw) rather than a
    // host-dependent value.
    const checker = createChecker('darwin', {});
    assert.equal(typeof checker, 'function');
    assert.doesNotThrow(() => {
      const result = checker();
      assert.equal(typeof result, 'boolean');
    });
  });

  test('an unsupported platform (e.g. linux) never claims detection', () => {
    const checker = createChecker('linux', {});
    assert.equal(checker(), false);
  });
});

describe('RemoteSessionGuard: interval polling + change notification', () => {
  test('polls once immediately on start() and notifies listeners of the initial state', () => {
    let calls = 0;
    const checker = () => {
      calls += 1;
      return true;
    };
    const guard = new RemoteSessionGuard(checker, 50_000);
    const events = [];
    guard.onChange((active) => events.push(active));
    guard.start();
    try {
      assert.equal(calls, 1, 'start() must poll synchronously, not wait for the first interval tick');
      assert.deepEqual(events, [true]);
      assert.equal(guard.isActive, true);
    } finally {
      guard.stop();
    }
  });

  test('does not notify again on a second poll while the checker keeps returning the same value', () => {
    const checker = () => true;
    const guard = new RemoteSessionGuard(checker, 50_000);
    const events = [];
    guard.onChange((active) => events.push(active));
    guard.start(); // false → true: fires once
    guard.stop();
    guard.start(); // true → true: must NOT fire again
    guard.stop();
    assert.deepEqual(events, [true]);
  });

  test('start() is idempotent — calling it twice does not double-poll', () => {
    let calls = 0;
    const checker = () => {
      calls += 1;
      return false;
    };
    const guard = new RemoteSessionGuard(checker, 50_000);
    guard.start();
    guard.start();
    try {
      assert.equal(calls, 1, 'a second start() while already running must be a no-op');
    } finally {
      guard.stop();
    }
  });

  test('stop() is safe to call when never started, and safe to call twice', () => {
    const guard = new RemoteSessionGuard(() => false, 50_000);
    assert.doesNotThrow(() => guard.stop());
    guard.start();
    guard.stop();
    assert.doesNotThrow(() => guard.stop());
  });

  test('a throwing checker fails closed (treated as inactive) instead of crashing the poll', () => {
    const checker = () => {
      throw new Error('probe failed');
    };
    const guard = new RemoteSessionGuard(checker, 50_000);
    const events = [];
    guard.onChange((active) => events.push(active));
    assert.doesNotThrow(() => guard.start());
    try {
      assert.equal(guard.isActive, false);
      assert.deepEqual(events, [], 'inactive is the initial default — a throw settling to false is not a CHANGE');
    } finally {
      guard.stop();
    }
  });

  test('a listener that throws does not prevent other listeners from being notified', () => {
    const guard = new RemoteSessionGuard(() => true, 50_000);
    const secondCalls = [];
    guard.onChange(() => {
      throw new Error('listener bug');
    });
    guard.onChange((active) => secondCalls.push(active));
    assert.doesNotThrow(() => guard.start());
    try {
      assert.deepEqual(secondCalls, [true]);
    } finally {
      guard.stop();
    }
  });

  test('onChange returns an unsubscribe function', () => {
    const guard = new RemoteSessionGuard(() => true, 50_000);
    const events = [];
    const unsubscribe = guard.onChange((active) => events.push(active));
    unsubscribe();
    guard.start();
    try {
      assert.deepEqual(events, [], 'unsubscribed listener must not be notified');
    } finally {
      guard.stop();
    }
  });

  test('reflects an edge transition across two independent start/stop cycles', () => {
    let remoteActive = false;
    const checker = () => remoteActive;
    const guard = new RemoteSessionGuard(checker, 50_000);
    const events = [];
    guard.onChange((active) => events.push(active));

    guard.start(); // polls false → initial default, no change event
    guard.stop();
    assert.equal(guard.isActive, false);

    remoteActive = true;
    guard.start(); // polls true → rising edge
    guard.stop();
    assert.equal(guard.isActive, true);

    remoteActive = false;
    guard.start(); // polls false → falling edge
    guard.stop();
    assert.equal(guard.isActive, false);

    assert.deepEqual(events, [true, false]);
  });
});
