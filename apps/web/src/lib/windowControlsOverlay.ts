const WCO_CLASS_NAME = "wco";
const ELECTRON_FULL_SCREEN_CLASS_NAME = "electron-full-screen";

interface WindowControlsOverlayLike {
  readonly visible: boolean;
  addEventListener(type: "geometrychange", listener: EventListener): void;
  removeEventListener(type: "geometrychange", listener: EventListener): void;
}

interface NavigatorWithWindowControlsOverlay extends Navigator {
  readonly windowControlsOverlay?: WindowControlsOverlayLike;
}

function getWindowControlsOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined") {
    return null;
  }

  return (navigator as NavigatorWithWindowControlsOverlay).windowControlsOverlay ?? null;
}

export function syncDocumentWindowControlsOverlayClass(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const overlay = getWindowControlsOverlay();
  const update = () => {
    document.documentElement.classList.toggle(WCO_CLASS_NAME, overlay !== null && overlay.visible);
  };

  update();
  if (!overlay) {
    return () => {};
  }

  overlay.addEventListener("geometrychange", update);
  return () => {
    overlay.removeEventListener("geometrychange", update);
  };
}

export function syncDocumentElectronFullScreenClass(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }

  const update = (isFullScreen: boolean) => {
    document.documentElement.classList.toggle(ELECTRON_FULL_SCREEN_CLASS_NAME, isFullScreen);
  };

  const getInitialFullScreenState = window.desktopBridge?.getWindowFullScreenState;
  if (getInitialFullScreenState) {
    update(getInitialFullScreenState());
  }

  const onWindowFullScreenChange = window.desktopBridge?.onWindowFullScreenChange;
  if (!onWindowFullScreenChange) {
    return () => {};
  }

  return onWindowFullScreenChange(update);
}
