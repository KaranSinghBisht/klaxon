import { describe, expect, it } from "vitest";
import { isPinnedImage, isPinnedUses, matchInstallPattern } from "../src/lint/patterns.js";
import { lintWorkflows, WorkflowParseError } from "../src/lint/workflow-lint.js";
import {
  CLEAN_WORKFLOW,
  PINNED_ACTION,
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

const DIGEST = `sha256:${"c".repeat(64)}`;

/** The protected job, with whatever the case under test puts inside it. */
const deployJob = (body: string): string => `name: deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
${body}`;

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

/**
 * The unreadable cases. Each of these used to produce *zero* findings and pass: `steps:` that is
 * not a list was silently treated as no steps, a `container:` was never looked at, and a `run:`
 * carrying an unresolved `${{ … }}` cannot be matched by a literal pattern at all.
 */
describe("workflow lint · what cannot be read is not clean", () => {
  it("flags a job whose steps: is not a list", () => {
    const result = lint(deployJob(`    steps: \${{ fromJSON(needs.plan.outputs.steps) }}\n`));

    expect(result.matchedJobs).toEqual([`${WORKFLOW_PATH}#deploy`]);
    expect(result.findings[0]).toMatchObject({ kind: "malformed", job: "deploy" });
    expect(result.findings[0]?.detail).toContain("steps: is not a list");
  });

  it("flags a job that declares neither steps: nor uses:", () => {
    expect(lint(deployJob("")).findings[0]).toMatchObject({ kind: "malformed", job: "deploy" });
  });

  it("flags a step that is not a mapping", () => {
    const result = lint(
      deployJob(`    steps:\n      - uses: ${PINNED_ACTION}\n      - "echo hi"\n`),
    );

    expect(result.findings[0]).toMatchObject({ kind: "malformed" });
    expect(result.findings[0]?.detail).toContain("step 2");
  });

  it("leaves a reusable-workflow job with no steps of its own alone", () => {
    const reusable = `name: deploy
on: push
jobs:
  deploy:
    environment: production
    uses: klaxon-demo/klaxon-repo/.github/workflows/release.yml@${"a".repeat(40)}
`;
    const result = lint(reusable);

    expect(result.matchedJobs).toEqual([`${WORKFLOW_PATH}#deploy`]);
    expect(result.findings).toEqual([]);
  });

  it("flags a run: carrying an unresolved GitHub expression", () => {
    // `${{ env.SETUP }}` can expand to `npm i` on the runner, long after this lint has said yes.
    const result = lint(deployJob(`    steps:\n      - run: \${{ env.SETUP }}\n`));

    expect(result.findings[0]).toMatchObject({ kind: "unresolvable-run", job: "deploy" });
    expect(result.findings[0]?.detail).toContain("cannot be resolved statically");
  });

  it("still reads a run: that only mentions a dollar sign", () => {
    expect(lint(deployJob("    steps:\n      - run: echo $HOME\n")).findings).toEqual([]);
  });
});

describe("workflow lint · container images", () => {
  it("flags an unpinned container image", () => {
    const result = lint(deployJob("    container: node:latest\n    steps:\n      - run: make\n"));

    expect(result.findings[0]).toMatchObject({ kind: "unpinned-container", job: "deploy" });
    expect(result.findings[0]?.detail).toContain("node:latest");
  });

  it("accepts a container pinned to a digest, in either form", () => {
    const asString = lint(
      deployJob(
        `    container: ghcr.io/foundry-rs/foundry@${DIGEST}\n    steps:\n      - run: make\n`,
      ),
    );
    const asMapping = lint(
      deployJob(
        `    container:\n      image: ghcr.io/foundry-rs/foundry@${DIGEST}\n      options: --user root\n    steps:\n      - run: make\n`,
      ),
    );

    expect(asString.findings).toEqual([]);
    expect(asMapping.findings).toEqual([]);
  });

  it("flags a container: that names no image at all", () => {
    const result = lint(
      deployJob("    container:\n      options: --user root\n    steps:\n      - run: make\n"),
    );

    expect(result.findings[0]).toMatchObject({ kind: "malformed", job: "deploy" });
  });

  it("only inspects the container of the job that carries the environment", () => {
    const other = `name: deploy
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    container: node:latest
    steps:
      - run: make build
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: ./scripts/deploy.sh
`;
    expect(lint(other).findings).toEqual([]);
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

describe("container: pinning", () => {
  it.each([
    `ghcr.io/foundry-rs/foundry@${DIGEST}`,
    `node@${DIGEST}`,
    `registry.example.com:5000/tools@${DIGEST}`,
  ])("accepts %s", (image) => {
    expect(isPinnedImage(image)).toBe(true);
  });

  it.each([
    "node:latest",
    "node:24-slim",
    "ghcr.io/foundry-rs/foundry",
    `node@sha256:${"a".repeat(63)}`,
    `node@sha256:${"A".repeat(64)}`,
  ])("rejects %s", (image) => {
    expect(isPinnedImage(image)).toBe(false);
  });
});
