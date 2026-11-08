export interface GitSetupStatus {
  readonly git: boolean;
  readonly ssh: boolean;
  readonly name: string | null;
  readonly email: string | null;
  readonly keyExists: boolean;
  readonly publicKey: string | null;
  readonly keyPath: string;
}

export function parseGitSetupStatus(json: string): GitSetupStatus {
  const value = JSON.parse(json) as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : null);
  return {
    git: value.git === true,
    ssh: value.ssh === true,
    name: text("name"),
    email: text("email"),
    keyExists: value.keyExists === true,
    publicKey: text("publicKey")?.trim() || null,
    keyPath: text("keyPath") ?? "/root/.ssh/id_ed25519",
  };
}

/** Returns why the identity cannot be saved, or null. Empty fields remove the setting. */
export function validateGitIdentity(name: string, email: string): string | null {
  if (/[\r\n]/.test(name) || /[\r\n]/.test(email)) return "Use a single line.";
  const trimmed = email.trim();
  if (trimmed.length > 0 && !/^[^\s@<>]+@[^\s@<>]+$/.test(trimmed)) {
    return "Enter an email like you@example.com.";
  }
  return null;
}

export type GitHubTestResult =
  | { readonly kind: "authenticated"; readonly user: string | null }
  | { readonly kind: "denied" }
  | { readonly kind: "hostKey" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "failed" };

/** GitHub answers `ssh -T` with exit code 1 even on success, so only the output tells. */
export function classifyGitHubTest(output: string): GitHubTestResult {
  if (/successfully authenticated/i.test(output)) {
    return { kind: "authenticated", user: /^Hi ([^!\s]+)!/m.exec(output)?.[1] ?? null };
  }
  if (/Permission denied \(publickey\)/i.test(output)) return { kind: "denied" };
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(output)) {
    return { kind: "hostKey" };
  }
  if (
    /Could not resolve hostname|Connection timed out|Network is unreachable|Connection refused|Timed out after|No route to host/i.test(
      output,
    )
  ) {
    return { kind: "unreachable" };
  }
  return { kind: "failed" };
}

export function describeGitHubTest(result: GitHubTestResult): string {
  switch (result.kind) {
    case "authenticated":
      return result.user
        ? `Connected to GitHub as ${result.user}.`
        : "Connected to GitHub. The key works.";
    case "denied":
      return "GitHub reached, but it does not know this key yet. Add the public key to your GitHub account, then test again.";
    case "hostKey":
      return "GitHub's host key did not match the one saved in Linux. Check ~/.ssh/known_hosts.";
    case "unreachable":
      return "Could not reach GitHub. Check the phone's internet connection.";
    case "failed":
      return "The test did not finish as expected. See the output below.";
  }
}
