import { describe, expect, it } from "vitest";
import { isPinnedUses, matchInstallPattern } from "../src/lint/patterns.js";
import { lintWorkflows, WorkflowParseError } from "../src/lint/workflow-lint.js";
import {
  CLEAN_WORKFLOW,
  WORKFLOW_ENVIRONMENT_EXPRESSION,
  WORKFLOW_ENVIRONMENT_OBJECT,
  WORKFLOW_PATH,
  WORKFLOW_WITH_CURL_PIPE_SH,
  WORKFLOW_WITH_INSTALL_STEP,
  WORKFLOW_WITH_PNPM_DLX,
  WORKFLOW_WITH_UNPINNED_USES,
  WORKFLOW_WITHOUT_ENVIRONMENT,
} from "./helpers/fixtures.js";

const lint = (text: string, environment = "production") =>
  lintWorkflows([{ path: WORKFLOW_PATH, text }], environment);

describe("workflow lint", () => {
  it("accepts a job with no install step and only pinned uses", () => {
    const result = lint(CLEAN_WORKFLOW);
    expect(result.matchedJobs).toEqual([`${WORKFLOW_PATH}#deploy`]);
    expect(result.findings).toEqual([]);
  });

  it("only lints the job that carries the environment", () => {
    // The `build` job in the clean fixture runs `make build`; it is not the protected job.
    expect(lint(CLEAN_WORKFLOW).matchedJobs).not.toContain(`${WORKFLOW_PATH}#build`);
  });

  it("flags npm ci", () => {
    const result = lint(WORKFLOW_WITH_INSTALL_STEP);
    expect(result.findings[0]).toMatchObject({ kind: "install", job: "deploy" });
    expect(result.findings[0]?.detail).toContain("node-package-manager-install");
  });

  it("flags pnpm dlx", () => {
    expect(lint(WORKFLOW_WITH_PNPM_DLX).findings[0]).toMatchObject({ kind: "install" });
  });

  it("flags curl | sh", () => {
    const result = lint(WORKFLOW_WITH_CURL_PIPE_SH);
    expect(result.findings[0]?.detail).toContain("curl-pipe-shell");
  });

  it("flags an unpinned uses:", () => {
    const result = lint(WORKFLOW_WITH_UNPINNED_USES);
    expect(result.findings[0]).toMatchObject({ kind: "unpinned" });
    expect(result.findings[0]?.detail).toContain("actions/checkout@v4");
  });

  it("reads environment given as {name, url}", () => {
    const result = lint(WORKFLOW_ENVIRONMENT_OBJECT);
    expect(result.matchedJobs).toEqual([`${WORKFLOW_PATH}#deploy`]);
    expect(result.findings).toEqual([]);
  });

  it("refuses an environment it cannot resolve statically", () => {
    const result = lint(WORKFLOW_ENVIRONMENT_EXPRESSION);
    expect(result.findings[0]).toMatchObject({ kind: "unresolvable-environment" });
    expect(result.matchedJobs).toEqual([]);
  });

  it("matches no job when none declares the environment", () => {
    expect(lint(WORKFLOW_WITHOUT_ENVIRONMENT).matchedJobs).toEqual([]);
  });

  it("throws rather than reporting a broken workflow as clean", () => {
    expect(() => lint("jobs:\n  deploy:\n   - [unclosed\n")).toThrow(WorkflowParseError);
  });
});

describe("install patterns", () => {
  it.each([
    "npm install",
    "npm ci",
    "pnpm add zod",
    "yarn install --frozen-lockfile",
    "npx cowsay hi",
    "bunx cowsay",
    "pip3 install requests",
    "uv pip install ruff",
    "poetry install",
    "cargo install cargo-audit",
    "go install ./cmd/x",
    "gem install bundler",
    "bundle install",
    "sudo apt-get install -y jq",
    "brew install jq",
    "curl -sSf https://x.dev/i | bash",
    "wget -qO- https://x.dev/i | sh",
  ])("flags %s", (run) => {
    expect(matchInstallPattern(run)).not.toBeNull();
  });

  it.each(["make build", "./scripts/deploy.sh", "echo installing nothing", "go build ./..."])(
    "leaves %s alone",
    (run) => {
      expect(matchInstallPattern(run)).toBeNull();
    },
  );

  it("normalises whitespace before matching", () => {
    expect(matchInstallPattern("npm\n  ci")).not.toBeNull();
  });
});

describe("uses: pinning", () => {
  it("accepts a 40-hex commit sha", () => {
    expect(isPinnedUses(`actions/checkout@${"a".repeat(40)}`)).toBe(true);
  });

  it("accepts a local action", () => {
    expect(isPinnedUses("./packages/action")).toBe(true);
  });

  it("accepts a docker image addressed by digest", () => {
    expect(isPinnedUses(`docker://alpine@sha256:${"b".repeat(64)}`)).toBe(true);
  });

  it.each([
    "actions/checkout@v4",
    "actions/checkout@main",
    `actions/checkout@${"a".repeat(39)}`,
    `actions/checkout@${"A".repeat(40)}`,
    "docker://alpine:3.20",
  ])("rejects %s", (uses) => {
    expect(isPinnedUses(uses)).toBe(false);
  });
});
