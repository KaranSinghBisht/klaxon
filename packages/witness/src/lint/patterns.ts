/**
 * A §5.6. The job that carries the protected environment must not be able to run attacker-supplied
 * code before the release step, and every action it uses must be pinned to an immutable commit.
 * These are matched against whitespace-normalised, case-insensitive `run:` text.
 */
export interface InstallPattern {
  name: string;
  re: RegExp;
}

export const INSTALL_PATTERNS: InstallPattern[] = [
  { name: "node-package-manager-install", re: /\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add)\b/i },
  { name: "npx", re: /\bnpx\b/i },
  { name: "pnpm-dlx", re: /\bpnpm\s+dlx\b/i },
  { name: "bunx", re: /\bbunx\b/i },
  { name: "pip-install", re: /\bpip3?\s+install\b/i },
  { name: "uv-install", re: /\buv\s+(pip\s+)?install\b/i },
  { name: "poetry-install", re: /\bpoetry\s+install\b/i },
  { name: "cargo-install", re: /\bcargo\s+(install|add)\b/i },
  { name: "go-install", re: /\bgo\s+(install|get)\b/i },
  { name: "gem-install", re: /\bgem\s+install\b/i },
  { name: "bundle-install", re: /\bbundle\s+install\b/i },
  { name: "apt-install", re: /\bapt(-get)?\s+install\b/i },
  { name: "brew-install", re: /\bbrew\s+install\b/i },
  { name: "curl-pipe-shell", re: /\b(curl|wget)\b[^\n]*\|\s*(ba)?sh\b/i },
];

/** `owner/repo@<40 hex>` or `owner/repo/path@<40 hex>` — a tag or branch is not a pin. */
export const PINNED_USES = /^[^@]+@[0-9a-f]{40}$/;
/** A local action lives in the repo at the same sha, so it is already pinned by the sha. */
export const LOCAL_USES = /^\.\//;
/** A digest-addressed container image is immutable in the same way a commit sha is. */
export const DOCKER_DIGEST_USES = /^docker:\/\/.+@sha256:[0-9a-f]{64}$/;
/** Any `${{ … }}` we cannot resolve statically — we refuse rather than guess. */
export const GITHUB_EXPRESSION = /\$\{\{/;

export function normaliseRun(run: string): string {
  return run.replace(/\s+/g, " ").trim();
}

export function matchInstallPattern(run: string): InstallPattern | null {
  const text = normaliseRun(run);
  for (const p of INSTALL_PATTERNS) {
    if (p.re.test(text)) return p;
  }
  return null;
}

export function isPinnedUses(uses: string): boolean {
  const value = uses.trim();
  if (LOCAL_USES.test(value)) return true;
  if (DOCKER_DIGEST_USES.test(value)) return true;
  return PINNED_USES.test(value);
}
