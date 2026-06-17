/**
 * Dynamic handle to the desktop preview bridge.
 *
 * Read fresh from `window.desktopBridge` on every access so dev/HMR and
 * late preload injection do not get stuck with a `null` snapshot captured
 * at import time. `null` on the web build where there is no Electron host.
 */
export function getPreviewBridge() {
  return typeof window === "undefined" ? null : (window.desktopBridge?.preview ?? null);
}

/**
 * @deprecated Use `getPreviewBridge()` instead. Kept for backwards compatibility
 * until remaining call sites are migrated off the import-time snapshot.
 */
export const previewBridge = getPreviewBridge();
