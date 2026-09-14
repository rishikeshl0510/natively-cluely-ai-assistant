import { execFileSync } from 'child_process';

/**
 * Detects whether THIS machine's screen is currently being viewed by a real
 * remote-desktop / screen-sharing session — Windows RDP or session shadowing
 * (`mstsc /shadow`), or macOS Screen Sharing (VNC / Apple Remote Desktop).
 *
 * # Why this exists (the gap it closes)
 *
 * Natively's "Undetectable Mode" content protection (WindowHelper's
 * `setContentProtection` → `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`
 * on Windows, `NSWindowSharingNone` on macOS) hides the overlay from
 * DWM/WindowServer-composited capture — Zoom, Meet, Teams, OBS. It does NOT
 * cover either platform's real remote-viewing path:
 *   - Windows RDP disables DWM composition for the viewed session, which is
 *     exactly the mechanism WDA_EXCLUDEFROMCAPTURE depends on.
 *   - macOS Screen Sharing/VNC reads the raw display framebuffer, not
 *     per-window WindowServer sharing state.
 * Neither gap has a capture-exclusion-flag fix — those protocols aren't
 * "capturing the screen" through an API that would respect one; they mirror
 * the session directly. The only mechanism that works is self-detection:
 * know we are being remoted into, and hide the overlay ourselves for as long
 * as that's true. See native-module/src/remote_session_windows.rs for the
 * Windows half of this and the CLAUDE.md research trail that led here.
 *
 * # Platform-injectable by design
 *
 * Per this project's cross-platform contract, platform detection must be
 * injectable rather than embedded in the poller — `createChecker(platform,
 * native)` takes the platform as a parameter so both branches are exercised
 * directly in tests (`createChecker('darwin', ...)` / `createChecker('win32',
 * ...)`) without needing to run on both OSes.
 */

export type RemoteSessionChecker = () => boolean;

export interface RemoteSessionNative {
  getRemoteSessionState?: () => { isRemoteSession: boolean; isRemoteControlled: boolean };
}

/**
 * Windows: a single cheap `GetSystemMetrics(SM_REMOTESESSION | SM_REMOTECONTROL)`
 * read via the native module. No handles, nothing to clean up — safe to poll.
 */
export function createWindowsChecker(native: RemoteSessionNative): RemoteSessionChecker {
  return () => {
    try {
      const state = native.getRemoteSessionState?.();
      return !!(state && (state.isRemoteSession || state.isRemoteControlled));
    } catch {
      // Missing/stale binary (pre-rebuild) — fail closed. Never claim
      // detection we can't actually back with a real read.
      return false;
    }
  };
}

const SCREEN_SHARING_PORT = 5900;

/**
 * macOS: heuristic. There is no public API for "is Screen Sharing actively
 * viewing me right now" (unlike Windows' SM_REMOTESESSION) — the closest
 * available signal is an ESTABLISHED TCP connection on the Screen
 * Sharing/VNC port, which only exists while screensharingd has a live
 * viewer. `lsof` ships with every macOS install, so this needs no new
 * dependency; the short, fail-safe `execFileSync` probe matches the existing
 * ImeDetector.ts precedent (`defaults read com.apple.HIToolbox`).
 *
 * Known limitations (documented rather than silently assumed away):
 *   - A Screen Sharing port changed from the 5900 default
 *     (`defaults write com.apple.RemoteManagement`) is not detected.
 *   - A third-party VNC server that doesn't front through screensharingd on
 *     this port is not detected.
 *   - False positives are effectively zero: an ESTABLISHED connection on
 *     5900 only occurs when something is actively viewing over VNC.
 */
export function createMacChecker(
  execFile: typeof execFileSync = execFileSync,
): RemoteSessionChecker {
  return () => {
    try {
      const raw = execFile(
        'lsof',
        ['-nP', `-iTCP:${SCREEN_SHARING_PORT}`, '-sTCP:ESTABLISHED'],
        { encoding: 'utf8', timeout: 1500 },
      );
      // First line is lsof's column header; any further line is a live connection.
      return raw.split('\n').filter((line) => line.trim().length > 0).length > 1;
    } catch {
      // lsof missing, or (the common case) exits non-zero when it finds no
      // matching connection — either way, fail closed rather than guess.
      return false;
    }
  };
}

/** A platform with no detection story never claims one. */
function createUnsupportedChecker(): RemoteSessionChecker {
  return () => false;
}

/** Platform-injectable factory — see the module doc comment for why. */
export function createChecker(
  platform: NodeJS.Platform,
  native: RemoteSessionNative,
): RemoteSessionChecker {
  if (platform === 'win32') return createWindowsChecker(native);
  if (platform === 'darwin') return createMacChecker();
  return createUnsupportedChecker();
}

const DEFAULT_POLL_MS = 3000;

/**
 * Polls a RemoteSessionChecker on an interval and notifies listeners only on
 * an active/inactive state CHANGE, not on every tick.
 */
export class RemoteSessionGuard {
  private readonly checker: RemoteSessionChecker;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;
  private readonly listeners = new Set<(active: boolean) => void>();

  // Plain field assignment, not TS constructor-parameter-property shorthand:
  // this module is imported both via esbuild (dist-electron) AND directly as
  // raw .ts by RemoteSessionGuard.test.mjs (Node's built-in type-stripping,
  // matching the LitellmModelLabel test precedent) — and Node's stripper
  // rejects parameter properties ("not supported in strip-only mode").
  constructor(checker: RemoteSessionChecker, intervalMs: number = DEFAULT_POLL_MS) {
    this.checker = checker;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    // Never hold the process open just to keep polling.
    (this.timer as unknown as { unref?: () => void })?.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Returns an unsubscribe function. */
  onChange(cb: (active: boolean) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private poll(): void {
    let next: boolean;
    try {
      next = this.checker();
    } catch {
      next = false;
    }
    if (next === this.active) return;
    this.active = next;
    for (const cb of [...this.listeners]) {
      try {
        cb(next);
      } catch {
        /* one listener's error must not break the poll loop for the others */
      }
    }
  }
}
