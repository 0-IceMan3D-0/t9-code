import { describe, expect, it } from "vite-plus/test";

import { classifyGitHubTest, parseGitSetupStatus, validateGitIdentity } from "./gitSetup";

describe("classifyGitHubTest", () => {
  it.each([
    [
      "Hi octocat! You've successfully authenticated, but GitHub does not provide shell access.",
      { kind: "authenticated", user: "octocat" },
    ],
    [
      "Warning: Permanently added 'github.com' (ED25519) to the list of known hosts.\r\ngit@github.com: Permission denied (publickey).",
      { kind: "denied" },
    ],
    ["Host key verification failed.", { kind: "hostKey" }],
    ["ssh: Could not resolve hostname github.com: Temporary failure", { kind: "unreachable" }],
    ["Timed out after 40 s", { kind: "unreachable" }],
    ["bash: ssh: command not found", { kind: "failed" }],
  ])("reads %j", (output, expected) => {
    expect(classifyGitHubTest(output)).toEqual(expected);
  });
});

describe("validateGitIdentity", () => {
  it("accepts a normal identity and empty fields", () => {
    expect(validateGitIdentity("Test User", "test@example.invalid")).toBeNull();
    expect(validateGitIdentity("", "")).toBeNull();
  });

  it("rejects multi-line values and malformed emails", () => {
    expect(validateGitIdentity("a\nb", "")).not.toBeNull();
    expect(validateGitIdentity("", "not an email")).not.toBeNull();
    expect(validateGitIdentity("", "a@b c")).not.toBeNull();
  });
});

describe("parseGitSetupStatus", () => {
  it("treats a missing public key and identity as null", () => {
    expect(
      parseGitSetupStatus(
        '{"git":true,"ssh":false,"name":null,"email":null,"keyExists":false,"publicKey":null,"keyPath":"/root/.ssh/id_ed25519"}',
      ),
    ).toEqual({
      git: true,
      ssh: false,
      name: null,
      email: null,
      keyExists: false,
      publicKey: null,
      keyPath: "/root/.ssh/id_ed25519",
    });
  });
});
