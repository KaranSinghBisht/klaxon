import { sha256 } from "@klaxon/core";

export const REPOSITORY = "klaxon-demo/klaxon-repo";
export const REPOSITORY_ID = "987654321";
export const TRUSTCHAIN_ROOT = "root-0123456789abcdef";
export const TOPIC_ID = "0.0.48213";
export const COMMIT_SHA = "a".repeat(40);
export const SECRET = "DEPLOYER_PRIVATE_KEY";
export const ENVIRONMENT = "production";
export const WORKFLOW_PATH = ".github/workflows/deploy.yml";
export const PINNED_ACTION = `actions/checkout@${"1".repeat(40)}`;

export interface PolicyFixtureOptions {
  projectId: string;
  secrets?: string[];
  environments?: string[];
  maxReleases?: number;
}

/**
 * The policy is hashed as **exact committed bytes** (A §4.3), so the fixture returns the bytes it
 * serves and the tests anchor `sha256` of those same bytes. Reformatting the JSON changes the hash,
 * which is the property under test.
 */
export function policyFixture(opts: PolicyFixtureOptions): { bytes: Buffer; hash: string } {
  const environments: Record<string, { secrets: string[] }> = {};
  for (const env of opts.environments ?? [ENVIRONMENT]) {
    environments[env] = { secrets: opts.secrets ?? [SECRET] };
  }
  const policy = {
    klaxon: 1,
    project_id: opts.projectId,
    repository_id: REPOSITORY_ID,
    max_releases: opts.maxReleases ?? 50,
    environments,
    workflow_rules: { forbid_install_steps: true, require_pinned_uses: true },
  };
  const bytes = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`, "utf8");
  return { bytes, hash: sha256(bytes).toString("hex") };
}

export const CLEAN_WORKFLOW = `name: deploy
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ${PINNED_ACTION}
      - run: make build
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: ${PINNED_ACTION}
      - name: release the secret
        uses: ./packages/action
      - run: ./scripts/deploy.sh
`;

export const WORKFLOW_WITH_INSTALL_STEP = `name: deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: ${PINNED_ACTION}
      - run: npm ci
      - run: ./scripts/deploy.sh
`;

export const WORKFLOW_WITH_UNPINNED_USES = `name: deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/deploy.sh
`;

export const WORKFLOW_WITHOUT_ENVIRONMENT = `name: deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: ${PINNED_ACTION}
      - run: ./scripts/deploy.sh
`;

export const WORKFLOW_ENVIRONMENT_OBJECT = `name: deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: production
      url: https://example.com
    steps:
      - uses: ${PINNED_ACTION}
      - run: ./scripts/deploy.sh
`;

export const WORKFLOW_ENVIRONMENT_EXPRESSION = `name: deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: \${{ matrix.env }}
    steps:
      - uses: ${PINNED_ACTION}
      - run: ./scripts/deploy.sh
`;

export const WORKFLOW_WITH_PNPM_DLX = `name: deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: pnpm dlx some-tool
`;

export const WORKFLOW_WITH_CURL_PIPE_SH = `name: deploy
on: push
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: curl -sSf https://example.com/install | sh
`;
