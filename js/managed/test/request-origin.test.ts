import { describe, expect, it } from "vitest";
import { callerContext, projectCaller } from "../src/request-origin";
import { forwardPrincipalAssertions, type Principal } from "../src/account-auth";
import { requestOriginContext } from "nanocodex/tools/environment";
const hands = [{ id: "user:laptop", name: "Laptop", mount: "/laptop", workspace: "/laptop", kind: "user" as const, capabilities: ["exec_command"] }];

describe("caller attribution", () => {
  it("overwrites forged identity and projects only an authorized Hand's logical cwd", () => {
    const headers = new Headers({
      "x-nanocodex-request-principal": JSON.stringify({ kind: "service", user_id: "forged" }),
      "x-nanocodex-client-context": JSON.stringify({ client: "nanocodex2", hand: "user:laptop", cwd: "/laptop/src", timezone: "Europe/Athens" }),
    });
    forwardPrincipalAssertions(headers, { kind: "api_key", userId: "owner", organizationId: "org", teamId: "team",
      role: "owner", subjectId: "api_key:test", credentialId: "test", authorizationEpoch: 1, capabilities: [] } as Principal);
    expect(projectCaller(callerContext(headers), hands)).toEqual({
      principal: { kind: "api_key", user_id: "owner" }, client: { name: "nanocodex2", attribution: "client_reported" },
      hand: { key: "user:laptop", path: "/laptop", attribution: "client_reported_authorized_hand" }, cwd: "/laptop/src", timezone: "Europe/Athens",
    });
  });
  it("does not infer a calling Hand or accept paths belonging to another Hand", () => {
    expect(projectCaller({}, hands)).toEqual({ client: null, hand: null });
    expect(projectCaller({ reported: { client: "web", hand: "user:other", cwd: "/other" } }, hands).hand).toBeNull();
    expect(projectCaller({ reported: { hand: "user:laptop", cwd: "/laptop-other" } }, hands).cwd).toBeNull();
  });
  it("rejects malformed hints without turning them into principal assertions", () => {
    for (const value of [{ client: "bad\nclient" }, { cwd: "/laptop/../other" }, { timezone: "not/a/timezone" }, { user_id: "forged" }])
      expect(() => requestOriginContext(value)).toThrow();
    expect(callerContext(new Headers({ "x-nanocodex-client-context": "{" }))).toEqual({});
    expect(callerContext(new Headers({ "x-nanocodex-client-context": "x".repeat(2049) }))).toEqual({});
  });
});
