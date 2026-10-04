import assert from "node:assert/strict";
import { test } from "node:test";

import { Dialog } from "../cloud/index.mjs";

const DEFAULT_HOST = "https://nanocodex.gakonst.workers.dev/connect-dialog/";
const DEFAULT_ORIGIN = "https://nanocodex.gakonst.workers.dev";

test("the default Connect dialog stays embedded and accepts responses only from its iframe origin", async () => {
  const browser = createBrowserHarness();
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = browser.document;
  globalThis.window = browser.window;

  try {
    assert.equal(Dialog.DEFAULT_HOST, DEFAULT_HOST);
    const dialog = Dialog.iframe().setup({ appId: "embedded-test" });
    const source = new URL(dialog.host);
    assert.equal(source.origin, DEFAULT_ORIGIN);
    assert.equal(source.pathname, "/connect-dialog/");
    assert.equal(source.searchParams.get("app_id"), "embedded-test");
    assert.equal(source.searchParams.get("origin"), "https://consumer.example");
    assert.equal(source.searchParams.get("mode"), "iframe");

    const request = { id: "request-1", type: "connect" };
    const result = dialog.open(request);
    const modal = browser.document.body.children.find(
      (element) => element.attributes.get("aria-label") === "Nanocodex Connect permissions",
    );
    const frame = modal.children[0];

    assert.equal(modal.tagName, "DIALOG");
    assert.equal(frame.tagName, "IFRAME");
    assert.equal(frame.src, dialog.host);
    assert.match(frame.allow, new RegExp(`publickey-credentials-get ${DEFAULT_ORIGIN}`));

    frame.dispatch("load");
    await Promise.resolve();
    assert.deepEqual(frame.contentWindow.messages, [{
      message: { type: "nanocodex:request", id: request.id, request },
      targetOrigin: DEFAULT_ORIGIN,
    }]);

    let settled = false;
    result.then(() => { settled = true; });
    const response = {
      type: "nanocodex:response",
      id: request.id,
      result: { approved: true },
    };
    browser.window.dispatchMessage({
      data: response,
      origin: "https://attacker.example",
      source: frame.contentWindow,
    });
    browser.window.dispatchMessage({
      data: response,
      origin: DEFAULT_ORIGIN,
      source: {},
    });
    await Promise.resolve();
    assert.equal(settled, false);

    browser.window.dispatchMessage({
      data: response,
      origin: DEFAULT_ORIGIN,
      source: frame.contentWindow,
    });
    assert.deepEqual(await result, { approved: true });
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test("popup URLs overwrite caller-controlled routing parameters", () => {
  const previousWindow = globalThis.window;
  const opened = [];
  globalThis.window = {
    location: { origin: "https://consumer.example" },
    open(source) {
      opened.push(source);
      return { closed: false, focus() {} };
    },
  };

  try {
    const dialog = Dialog.popup({
      host: `${DEFAULT_HOST}?app_id=attacker&origin=https://attacker.example&mode=iframe`,
    }).setup({ appId: "consumer-example" });
    dialog.showWallet();
    const source = new URL(opened[0]);
    assert.equal(source.searchParams.get("app_id"), "consumer-example");
    assert.equal(source.searchParams.get("origin"), "https://consumer.example");
    assert.equal(source.searchParams.get("mode"), "popup");
  } finally {
    globalThis.window = previousWindow;
  }
});

test("appearance travels to wallet, replacement wallet, funding iframe, and reset", async () => {
  const browser = createBrowserHarness();
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = browser.document;
  globalThis.window = browser.window;
  const appearance = { theme: "dark", accentColor: "#AABBCC", fontFamily: '"Open Sans", sans-serif', borderRadius: 12 };
  const readAppearance = (source) => JSON.parse(new URL(source).searchParams.get("nanocodex_appearance"));
  const walletFrames = () => browser.document.body.children
    .flatMap(modal => modal.children).filter(child => child.dataset.testid === "nanocodex-connect-wallet");

  try {
    const dialog = Dialog.iframe({ appearance }).setup({ appId: "appearance-iframe" });
    assert.deepEqual(readAppearance(dialog.host), appearance);
    assert.deepEqual(readAppearance(walletFrames().at(-1).src), appearance);
    // A fresh Accounts URL must not drop or override the developer's options.
    dialog.walletTarget({ host: `${DEFAULT_HOST}?app_id=appearance-iframe&nanocodex_appearance=bad` });
    assert.deepEqual(readAppearance(walletFrames().at(-1).src), appearance);

    const request = { id: "appearance-funding", type: "machineUsdFund" };
    const result = dialog.open(request);
    const frame = browser.document.body.children
      .find(modal => modal.attributes.get("aria-label") === "Nanocodex Connect permissions").children[0];
    assert.deepEqual(readAppearance(frame.src), appearance);
    frame.dispatch("load");
    await Promise.resolve();
    assert.equal(frame.contentWindow.messages[0].message.request.type, "machineUsdFund");
    browser.window.dispatchMessage({
      data: { type: "nanocodex:response", id: request.id, result: { funded: true } },
      origin: DEFAULT_ORIGIN,
      source: frame.contentWindow,
    });
    assert.deepEqual(await result, { funded: true });

    await dialog.resetWallet();
    const ready = dialog.waitForWallet();
    assert.deepEqual(readAppearance(walletFrames().at(-1).src), appearance);
    walletFrames().at(-1).dispatch("load");
    await ready;
    const other = Dialog.iframe({ appearance: { theme: "light" } }).setup({ appId: "appearance-iframe" });
    assert.notEqual(other, dialog, "differently themed dialogs must not share cached instances");
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});

test("popup appearance is snapshotted, replaces stale URL values, and survives reopening", () => {
  const previousWindow = globalThis.window;
  const opened = [];
  globalThis.window = {
    location: { origin: "https://consumer.example" },
    open(source) {
      opened.push(source);
      return { closed: false, close() { this.closed = true; }, focus() {} };
    },
  };
  try {
    const appearance = { theme: "system", accentColor: "#112233", fontFamily: "system-ui", borderRadius: 0 };
    const configured = Dialog.popup({ host: `${DEFAULT_HOST}?nanocodex_appearance=bad`, appearance });
    appearance.theme = "light";
    const dialog = configured.setup({ appId: "appearance-popup" });
    dialog.showWallet();
    dialog.hideWallet();
    dialog.showWallet();
    assert.equal(opened.length, 2);
    for (const source of opened) {
      const parameters = new URL(source).searchParams;
      assert.equal(parameters.get("mode"), "popup");
      assert.equal(parameters.getAll("nanocodex_appearance").length, 1);
      assert.deepEqual(JSON.parse(parameters.get("nanocodex_appearance")), { ...appearance, theme: "system" });
      assert.ok(parameters.get("nanocodex_appearance").length <= 1024);
    }
    const native = Dialog.popup({ host: `${DEFAULT_HOST}?nanocodex_appearance=bad` }).setup({ appId: "appearance-default" });
    assert.equal(new URL(native.host).searchParams.has("nanocodex_appearance"), false);
  } finally {
    globalThis.window = previousWindow;
  }
});

test("appearance rejects malformed values and arbitrary CSS before browser setup", () => {
  for (const appearance of [
    null, [], "dark", { theme: "auto" }, { accentColor: "red" },
    { accentColor: "#ffffff; color:red" }, { fontFamily: "url(https://example.com/font)" },
    { fontFamily: "serif; display:none" }, { fontFamily: "a".repeat(161) }, { fontFamily: " " },
    { borderRadius: -1 }, { borderRadius: 25 }, { borderRadius: Infinity },
    { borderRadius: "12" }, { css: "body { display: none }" },
  ]) {
    for (const factory of [Dialog.iframe, Dialog.popup]) {
      assert.throws(() => factory({ appearance }), /Dialog appearance/);
    }
  }
  assert.doesNotThrow(() => Dialog.iframe({ appearance: { theme: "light", borderRadius: 24 } }));
});

function createBrowserHarness() {
  const windowListeners = new Map();
  const body = createElement("body");
  const document = {
    body,
    createElement(tagName) {
      const element = createElement(tagName);
      if (tagName === "iframe") {
        element.contentWindow = {
          messages: [],
          postMessage(message, targetOrigin) {
            this.messages.push({ message, targetOrigin });
          },
        };
      }
      return element;
    },
  };
  const window = {
    location: { origin: "https://consumer.example" },
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    dispatchMessage(event) {
      windowListeners.get("message")?.(event);
    },
  };
  return { document, window };
}

function createElement(tagName) {
  const listeners = new Map();
  return {
    attributes: new Map(),
    children: [],
    dataset: {},
    open: false,
    style: {},
    tagName: tagName.toUpperCase(),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    append(...children) {
      this.children.push(...children);
    },
    close() {
      this.open = false;
    },
    dispatch(type, event = {}) {
      listeners.get(type)?.(event);
    },
    focus() {},
    remove() {},
    removeAttribute(name) {
      this.attributes.delete(name);
    },
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    showModal() {
      this.open = true;
    },
  };
}
