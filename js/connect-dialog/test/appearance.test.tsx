import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Dialog } from "nanocodex/connect";

// This transport check replaces only the presentation boundary. The SDK URL
// builder, hosted app parser, and appearance prop forwarding all run unchanged.
const rendered = vi.hoisted(() => ({ appearance: undefined as unknown }));
vi.mock("nanocodex-connect-ui/App", () => ({
  ConnectOnboarding(props: { appearance?: unknown }) {
    rendered.appearance = props.appearance;
    return null;
  },
}));

let App: typeof import("../src/DialogApp").App;
beforeAll(async () => {
  vi.stubGlobal("window", {
    location: { origin: "https://consumer.example", search: "" },
    addEventListener: vi.fn(),
  });
  ({ App } = await import("../src/DialogApp"));
});

function renderSearch(search: string) {
  window.location.search = search;
  rendered.appearance = "not rendered";
  renderToStaticMarkup(createElement(App));
  return rendered.appearance;
}

function query(value: unknown) {
  return `?${new URLSearchParams({ nanocodex_appearance: JSON.stringify(value) })}`;
}

describe("hosted dialog appearance transport", () => {
  it("forwards an SDK popup URL to the onboarding appearance prop", () => {
    const appearance = { theme: "system", accentColor: "#123ABC", fontFamily: '\"Open Sans\", system-ui', borderRadius: 24 } as const;
    const source = Dialog.popup({ appearance }).setup({ appId: "hosted-appearance-test" }).host;
    expect(renderSearch(new URL(source).search)).toEqual(appearance);
    expect(renderSearch(query({ theme: "light", borderRadius: 0 }))).toEqual({ theme: "light", borderRadius: 0 });
  });

  it("uses native defaults for missing, malformed, duplicate, oversized, or CSS-bearing values", () => {
    for (const search of [
      "", "?nanocodex_appearance={", "?nanocodex_appearance=null",
      `${query({ theme: "dark" })}&nanocodex_appearance={}`,
      `?nanocodex_appearance=${" ".repeat(1025)}`,
      query([]), query({ theme: "auto" }), query({ accentColor: "red" }),
      query({ fontFamily: "serif;display:none" }), query({ fontFamily: "url(https://evil.example)" }),
      query({ fontFamily: "x".repeat(161) }), query({ borderRadius: 25 }),
      query({ theme: "dark", css: "body { display:none }" }),
    ]) expect(renderSearch(search)).toBeUndefined();
  });
});
