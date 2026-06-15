import { useCallback, useSyncExternalStore } from "react";
import { useThemeSettings } from "@/hooks/useThemeSettings";
import { isNodeViewMode, type NodeViewMode } from "@/utils/themeSettings";

const DESKTOP_OVERRIDE_KEY = "komaritheme:node-view-mode-session:desktop";
const MOBILE_OVERRIDE_KEY = "komaritheme:node-view-mode-session:mobile";
const MOBILE_QUERY = "(max-width: 720px)";

interface ViewModeState {
  device: "desktop" | "mobile";
  override: NodeViewMode | null;
}

const listeners = new Set<() => void>();
let mediaQuery: MediaQueryList | null = null;
let subscribedMediaQuery: MediaQueryList | null = null;
let snapshot: ViewModeState = {
  device: "desktop",
  override: null,
};

function readOverride(key: string): NodeViewMode | null {
  try {
    const value = sessionStorage.getItem(key);
    return isNodeViewMode(value) ? value : null;
  } catch {
    return null;
  }
}

function writeOverride(key: string, value: NodeViewMode) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Keep in-memory behavior if session storage is unavailable.
  }
}

function clearOverride(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing to clear if session storage is unavailable.
  }
}

function getMediaQuery() {
  if (typeof window === "undefined" || !window.matchMedia) return null;
  mediaQuery ??= window.matchMedia(MOBILE_QUERY);
  return mediaQuery;
}

function getDevice(): ViewModeState["device"] {
  return getMediaQuery()?.matches ? "mobile" : "desktop";
}

function getOverrideKey(device: ViewModeState["device"]) {
  return device === "mobile" ? MOBILE_OVERRIDE_KEY : DESKTOP_OVERRIDE_KEY;
}

function readSnapshot(): ViewModeState {
  const device = getDevice();
  return {
    device,
    override: readOverride(getOverrideKey(device)),
  };
}

function refreshSnapshot() {
  const next = readSnapshot();
  if (snapshot.device !== next.device || snapshot.override !== next.override) {
    snapshot = next;
  }
  return snapshot;
}

let snapshotInitialized = false;

function getSnapshot(): ViewModeState {
  // useSyncExternalStore calls getSnapshot on every render, so it must be cheap
  // and stable. Read storage/matchMedia exactly once to seed the cache; after
  // that the snapshot is kept fresh by the media/storage/setMode handlers.
  if (!snapshotInitialized) {
    snapshotInitialized = true;
    refreshSnapshot();
  }
  return snapshot;
}

function emit() {
  for (const listener of listeners) listener();
}

const handleMediaChange = () => {
  refreshSnapshot();
  emit();
};

function addMediaListener(mq: MediaQueryList) {
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", handleMediaChange);
  } else {
    mq.addListener(handleMediaChange);
  }
}

function removeMediaListener(mq: MediaQueryList) {
  if (typeof mq.removeEventListener === "function") {
    mq.removeEventListener("change", handleMediaChange);
  } else {
    mq.removeListener(handleMediaChange);
  }
}

function ensureMediaSubscription() {
  const mq = getMediaQuery();
  if (!mq || subscribedMediaQuery === mq) return;
  if (subscribedMediaQuery) removeMediaListener(subscribedMediaQuery);
  subscribedMediaQuery = mq;
  addMediaListener(mq);
}

function clearMediaSubscription() {
  if (!subscribedMediaQuery) return;
  removeMediaListener(subscribedMediaQuery);
  subscribedMediaQuery = null;
}

// Cross-tab override sync. Registered once for the whole module (on the first
// subscriber) rather than per-hook-instance — every consumer shares the same
// global state, so N components would otherwise install N identical listeners.
const handleStorage = (event: StorageEvent) => {
  if (event.key === DESKTOP_OVERRIDE_KEY || event.key === MOBILE_OVERRIDE_KEY) {
    refreshSnapshot();
    emit();
  }
};
let storageListenerAttached = false;

function ensureStorageSubscription() {
  if (storageListenerAttached || typeof window === "undefined") return;
  window.addEventListener("storage", handleStorage);
  storageListenerAttached = true;
}

function clearStorageSubscription() {
  if (!storageListenerAttached || typeof window === "undefined") return;
  window.removeEventListener("storage", handleStorage);
  storageListenerAttached = false;
}

function subscribe(listener: () => void) {
  const wasEmpty = listeners.size === 0;
  listeners.add(listener);
  if (wasEmpty) {
    ensureMediaSubscription();
    ensureStorageSubscription();
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearMediaSubscription();
      clearStorageSubscription();
    }
  };
}

export function useViewMode() {
  const themeSettings = useThemeSettings();
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const defaultMode =
    state.device === "mobile"
      ? themeSettings.mobileNodeViewMode
      : themeSettings.desktopNodeViewMode;
  const mode = state.override ?? defaultMode;

  const setMode = useCallback(
    (next: NodeViewMode) => {
      const key = getOverrideKey(state.device);
      // Selecting the current theme default clears the session override and
      // follows the default again, instead of pinning an override that can never
      // be removed (which would also stop future default changes from applying).
      if (next === defaultMode) {
        clearOverride(key);
      } else {
        writeOverride(key, next);
      }
      refreshSnapshot();
      emit();
    },
    [state.device, defaultMode],
  );

  const toggleMode = useCallback(() => {
    setMode(mode === "compact" ? "large" : "compact");
  }, [mode, setMode]);

  return {
    device: state.device,
    mode,
    defaultMode,
    isOverridden: state.override != null,
    setMode,
    toggleMode,
  };
}
