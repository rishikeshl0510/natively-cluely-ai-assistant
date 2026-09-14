//! Detect whether THIS Windows session is currently being viewed remotely —
//! either because the session itself IS a Remote Desktop (RDP) connection, or
//! because an admin has attached to an otherwise-local console session via
//! Remote Desktop Shadowing (`mstsc /shadow`).
//!
//! # Why this exists
//!
//! Natively's existing "Undetectable Mode" content protection
//! (`setContentProtection` → `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`,
//! see WindowHelper.ts) excludes the overlay from DWM-composited capture
//! surfaces (Zoom, Meet, Teams, OBS). It does NOT survive a real RDP session:
//! RDP disables DWM composition for the session being viewed, which is the
//! exact mechanism WDA_EXCLUDEFROMCAPTURE depends on. So an IT admin (or
//! anyone) connected via genuine RDP or session shadowing sees the overlay
//! today regardless of the content-protection flag.
//!
//! There is no capture-exclusion flag that closes that gap — RDP isn't
//! "capturing the screen" via an API that respects per-window flags, it IS
//! the display session. The only mechanism that works is self-detection: know
//! we're being remoted into, and hide the overlay ourselves for the duration.
//!
//! # Mechanism
//!
//! `GetSystemMetrics` is the correct, minimal, officially documented way to
//! read both states — no window handles, no WTS API session queries, nothing
//! to register or clean up:
//!   - `SM_REMOTESESSION` (0x1000): nonzero when the CURRENT session is itself
//!     running over the Remote Desktop Protocol (Terminal Services client).
//!   - `SM_REMOTECONTROL` (0x2001): nonzero when the current session is being
//!     remote-controlled/shadowed by another session (covers `mstsc /shadow`
//!     onto an otherwise-local console session, which SM_REMOTESESSION alone
//!     would miss since the shadowed session's OWN protocol type is console).
//!
//! Both are cheap (~microsecond) reads of process/session state already
//! tracked by the OS — safe to poll every few seconds from JS.

#![cfg(target_os = "windows")]

use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_REMOTECONTROL, SM_REMOTESESSION};

#[napi(object)]
pub struct RemoteSessionState {
    /// True when this session is itself a Remote Desktop (RDP) connection.
    pub is_remote_session: bool,
    /// True when this session is currently being shadowed/remote-controlled
    /// by another session (`mstsc /shadow`), independent of whether the
    /// session itself is console or RDP.
    pub is_remote_controlled: bool,
}

/// One-shot poll of both states. Cheap enough to call every few seconds from
/// JS (electron/services/RemoteSessionGuard.ts); no allocation, no handle.
#[napi]
pub fn get_remote_session_state() -> RemoteSessionState {
    // SAFETY: GetSystemMetrics with a valid SM_* index is always safe to call
    // — it takes no pointers, has no failure mode beyond returning 0 for an
    // index the running OS doesn't recognize, and holds no resource to leak.
    let is_remote_session = unsafe { GetSystemMetrics(SM_REMOTESESSION) } != 0;
    let is_remote_controlled = unsafe { GetSystemMetrics(SM_REMOTECONTROL) } != 0;
    RemoteSessionState {
        is_remote_session,
        is_remote_controlled,
    }
}
