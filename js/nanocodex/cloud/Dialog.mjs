import { DialogBusyError, UserRejectedRequestError } from "./Errors.mjs";

export const DEFAULT_HOST = "https://nanocodex.gakonst.workers.dev/connect-dialog/";

const APPEARANCE_PARAMETER = "nanocodex_appearance";
const MAX_APPEARANCE_LENGTH = 1024;

const iframeInstances = new Map();
const popupInstances = new Map();

export function from(parameters) {
  if (!parameters || typeof parameters !== "object") {
    throw new TypeError("Dialog.from requires parameters");
  }
  if (typeof parameters.setup !== "function") {
    throw new TypeError("Dialog.from requires setup");
  }
  return Object.freeze({
    key: requiredString(parameters.key, "dialog key"),
    name: requiredString(parameters.name, "dialog name"),
    type: requiredString(parameters.type, "dialog type"),
    setup: parameters.setup,
  });
}

export function iframe(options = {}) {
  const host = new URL(options.host ?? DEFAULT_HOST).toString();
  const appearance = serializeAppearance(options.appearance);
  return from({
    key: options.key ?? "nanocodex-iframe",
    name: options.name ?? "Nanocodex Connect",
    type: "iframe",
    setup({ appId }) {
      if (typeof document === "undefined" || typeof window === "undefined") {
        return {
          host,
          async open() {
            throw new Error("The Nanocodex iframe dialog requires a browser");
          },
        };
      }
      const source = dialogUrl(host, "iframe", appId, appearance);
      let instance = iframeInstances.get(source);
      if (!instance) {
        instance = createIframeInstance(source);
        iframeInstances.set(source, instance);
      }
      return instance;
    },
  });
}

export function popup(options = {}) {
  const host = new URL(options.host ?? DEFAULT_HOST).toString();
  const appearance = serializeAppearance(options.appearance);
  return from({
    key: options.key ?? "nanocodex-popup",
    name: options.name ?? "Nanocodex Connect",
    type: "popup",
    setup({ appId }) {
      if (typeof window === "undefined") {
        return {
          host,
          async open() {
            throw new Error("The Nanocodex popup dialog requires a browser");
          },
        };
      }
      const source = dialogUrl(host, "popup", appId, appearance);
      let instance = popupInstances.get(source);
      if (!instance) {
        instance = createPopupInstance(source, options);
        popupInstances.set(source, instance);
      }
      return instance;
    },
  });
}

export function memory(options = {}) {
  return from({
    key: options.key ?? "nanocodex-memory",
    name: options.name ?? "Nanocodex Connect playground",
    type: "memory",
    setup() {
      const listeners = new Set();
      let pending;
      let snapshot;

      function publish(value) {
        snapshot = value;
        for (const listener of [...listeners]) listener();
      }

      return {
        host: options.host ?? "https://connect.nanocodex.xyz",
        open(request) {
          if (pending) return Promise.reject(new DialogBusyError());
          return new Promise((resolve, reject) => {
            pending = { reject, request, resolve };
            publish(Object.freeze(request));
          });
        },
        getRequest() {
          return snapshot;
        },
        subscribe(listener) {
          if (typeof listener !== "function") {
            throw new TypeError("dialog subscription requires a listener");
          }
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        respond(result) {
          if (!pending) throw new Error("The Nanocodex dialog has no pending request");
          const current = pending;
          pending = undefined;
          publish(undefined);
          current.resolve(result);
        },
        reject(error = new UserRejectedRequestError()) {
          if (!pending) throw new Error("The Nanocodex dialog has no pending request");
          const current = pending;
          pending = undefined;
          publish(undefined);
          current.reject(error);
        },
      };
    },
  });
}

function createIframeInstance(host) {
  let active;
  let frame;
  let modal;
  let ready;
  let walletFrame;
  let walletHost;
  let walletModal;
  let walletReady;
  let walletStale = false;
  let walletVisible = false;

  function mount() {
    if (frame && modal) return;
    modal = document.createElement("dialog");
    modal.setAttribute("aria-label", "Nanocodex Connect permissions");
    modal.style.cssText = "border:0;outline:0;padding:0;margin:0;background:transparent;max-width:none;max-height:none;width:100vw;height:100dvh";
    modal.addEventListener("cancel", (event) => {
      event.preventDefault();
      rejectActive(new UserRejectedRequestError());
    });
    modal.addEventListener("close", () => {
      if (active) rejectActive(new UserRejectedRequestError());
    });
    frame = document.createElement("iframe");
    frame.dataset.testid = "nanocodex-connect-dialog";
    frame.title = "Nanocodex Connect permissions";
    frame.src = host;
    frame.tabIndex = -1;
    frame.setAttribute("inert", "");
    const dialogOrigin = new URL(host).origin;
    frame.allow = [
      `publickey-credentials-get ${dialogOrigin}`,
      `publickey-credentials-create ${dialogOrigin}`,
      "payment",
    ].join("; ");
    frame.style.cssText = "border:0;width:100vw;height:100dvh;background:transparent";
    frame.style.display = "none";
    modal.append(frame);
    document.body.append(modal);
    ready = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  }

  function rejectActive(error) {
    if (!active) return;
    const current = active;
    active = undefined;
    if (modal?.open) modal.close();
    frame.tabIndex = -1;
    frame.setAttribute("inert", "");
    frame.style.display = "none";
    current.reject(error);
  }

  function onMessage(event) {
    if (!active || event.origin !== new URL(host).origin || event.source !== frame?.contentWindow) return;
    const message = event.data;
    if (!message || message.type !== "nanocodex:response" || message.id !== active.request.id) return;
    const current = active;
    active = undefined;
    modal?.close();
    frame.tabIndex = -1;
    frame.setAttribute("inert", "");
    frame.style.display = "none";
    if (message.error) {
      current.reject(new UserRejectedRequestError(message.error.message));
      return;
    }
    current.resolve(message.result);
  }

  window.addEventListener("message", onMessage);

  function mountWallet(nextHost) {
    const url = new URL(nextHost ?? host);
    if (!url.searchParams.has("origin")) url.searchParams.set("origin", window.location.origin);
    url.searchParams.set("mode", "iframe");
    // Accounts may supply a fresh host URL; retain this dialog's visual options.
    setAppearance(url, new URL(host).searchParams.get(APPEARANCE_PARAMETER));
    const source = url.toString();
    if (walletFrame && walletModal && walletHost === source) return;
    walletModal?.remove();
    walletModal = document.createElement("dialog");
    walletModal.dataset.nanocodexConnectWallet = "";
    walletModal.setAttribute("aria-label", "Nanocodex Connect");
    walletModal.style.cssText = "border:0;outline:0;padding:0;background:transparent;max-width:none;max-height:none;width:100vw;height:100vh";
    walletModal.addEventListener("cancel", (event) => event.preventDefault());
    const style = document.createElement("style");
    style.textContent = "dialog[data-nanocodex-connect-wallet]::backdrop{background:transparent}";
    walletFrame = document.createElement("iframe");
    walletFrame.dataset.testid = "nanocodex-connect-wallet";
    walletFrame.title = "Nanocodex Connect";
    walletReady = new Promise((resolve) => {
      walletFrame.addEventListener("load", resolve, { once: true });
    });
    walletFrame.src = source;
    const dialogOrigin = url.origin;
    walletFrame.allow = [
      `publickey-credentials-get ${dialogOrigin}`,
      `publickey-credentials-create ${dialogOrigin}`,
      "clipboard-write",
      "payment",
    ].join("; ");
    walletFrame.style.cssText = "border:0;position:fixed;inset:0;width:100%;height:100%;background:transparent;color-scheme:light dark";
    setWalletInteractive(walletVisible);
    walletModal.append(style, walletFrame);
    document.body.append(walletModal);
    walletHost = source;
    walletStale = false;
    if (walletVisible) walletModal.showModal();
  }

  async function refreshStaleWallet() {
    if (!walletStale) return;
    walletModal?.remove();
    walletFrame = undefined;
    walletHost = undefined;
    walletModal = undefined;
    walletReady = undefined;
    mountWallet(host);
    await walletReady;
  }

  function showWallet() {
    walletVisible = true;
    setWalletInteractive(true);
    if (walletModal && !walletModal.open) walletModal.showModal();
    walletFrame?.focus();
  }

  function hideWallet() {
    walletVisible = false;
    if (walletModal?.open) walletModal.close();
    setWalletInteractive(false);
  }

  async function resetWallet() {
    walletVisible = false;
    if (walletModal?.open) walletModal.close();
    setWalletInteractive(false);
    // The hosted account is still finishing its own logout when the Wata
    // response reaches the parent. Keep that document alive until the next
    // connect, then replace it before creating the next Provider session.
    walletStale = true;
  }

  function setWalletInteractive(visible) {
    if (!walletFrame) return;
    walletFrame.tabIndex = visible ? 0 : -1;
    walletFrame.style.display = visible ? "block" : "none";
    if (visible) walletFrame.removeAttribute("inert");
    else walletFrame.setAttribute("inert", "");
  }

  // Keep the hosted wallet warm from client creation. The iframe remains
  // hidden and inert until a request is made, but its Accounts/WebAuthn
  // runtime can load while the embedding app is already useful.
  mountWallet(host);

  return {
    host,
    hideWallet,
    resetWallet,
    async open(request) {
      if (active) throw new DialogBusyError();
      mount();
      await ready;
      return new Promise((resolve, reject) => {
        active = { reject, request, resolve };
        frame.removeAttribute("inert");
        frame.tabIndex = 0;
        frame.style.display = "block";
        modal.showModal();
        frame.contentWindow.postMessage({
          type: "nanocodex:request",
          id: request.id,
          request,
        }, new URL(host).origin);
      });
    },
    showWallet,
    async waitForWallet() {
      await refreshStaleWallet();
      await walletReady;
    },
    walletTarget(options = {}) {
      mountWallet(options.host);
      if (walletVisible && walletModal && !walletModal.open) walletModal.showModal();
      return walletFrame?.contentWindow;
    },
  };
}

function createPopupInstance(host, options) {
  const source = host;
  const targetName = options.target ?? "nanocodex-connect";
  const features = options.features ?? "popup=yes,width=808,height=780,resizable=yes,scrollbars=yes";
  let walletWindow;

  function showWallet() {
    if (!walletWindow || walletWindow.closed) {
      walletWindow = window.open(source, targetName, features);
    }
    if (!walletWindow) {
      throw new Error("Nanocodex Connect was blocked. Allow the popup and try again.");
    }
    walletWindow.focus?.();
  }

  function hideWallet() {
    if (walletWindow && !walletWindow.closed) walletWindow.close();
    walletWindow = undefined;
  }

  return {
    host: source,
    async open() {
      throw new Error("The Nanocodex popup supports account authorization only");
    },
    showWallet,
    hideWallet,
    walletTarget() {
      return walletWindow && !walletWindow.closed ? walletWindow : undefined;
    },
  };
}

function dialogUrl(host, mode, appId, appearance) {
  const url = new URL(host);
  url.searchParams.set("app_id", appId);
  url.searchParams.set("origin", window.location.origin);
  url.searchParams.set("mode", mode);
  setAppearance(url, appearance);
  return url.toString();
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function setAppearance(url, appearance) {
  // Explicit SDK options own this parameter, including clearing stale host values.
  url.searchParams.delete(APPEARANCE_PARAMETER);
  if (appearance) url.searchParams.set(APPEARANCE_PARAMETER, appearance);
}

function serializeAppearance(appearance) {
  if (appearance === undefined) return undefined;
  if (!appearance || typeof appearance !== "object" || Array.isArray(appearance)) {
    throw new TypeError("Dialog appearance must be an object");
  }
  const keys = ["theme", "accentColor", "fontFamily", "borderRadius"];
  if (Object.keys(appearance).some((key) => !keys.includes(key))) {
    throw new TypeError("Dialog appearance contains an unsupported option");
  }
  const { theme, accentColor, fontFamily, borderRadius } = appearance;
  if (theme !== undefined && !["light", "dark", "system"].includes(theme)) {
    throw new TypeError("Dialog appearance theme must be light, dark, or system");
  }
  if (accentColor !== undefined && (typeof accentColor !== "string" || !/^#[\da-f]{6}$/i.test(accentColor))) {
    throw new TypeError("Dialog appearance accentColor must be a six-digit hex color");
  }
  if (fontFamily !== undefined && (typeof fontFamily !== "string" || fontFamily.length > 160
    || !/^[a-zA-Z0-9 ,"'_-]+$/.test(fontFamily) || !fontFamily.trim())) {
    throw new TypeError("Dialog appearance fontFamily must be a font list of at most 160 characters");
  }
  if (borderRadius !== undefined && (typeof borderRadius !== "number" || !Number.isFinite(borderRadius)
    || borderRadius < 0 || borderRadius > 24)) {
    throw new TypeError("Dialog appearance borderRadius must be between 0 and 24 pixels");
  }
  // Pick known scalar fields, never invoking a caller's toJSON or carrying CSS.
  const serialized = JSON.stringify({ theme, accentColor, fontFamily, borderRadius });
  if (serialized.length > MAX_APPEARANCE_LENGTH) {
    throw new TypeError("Dialog appearance is too large");
  }
  return serialized;
}
