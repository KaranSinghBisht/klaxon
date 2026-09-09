# Migrating a pipeline onto KLAXON

KLAXON does not replace GitHub Environments, pinned actions, or the split between installing and deploying. It **requires** them — the witness's own lint (check 5) refuses a release to a job that declares the environment and also matches its install denylist or uses an unpinned action. That lint is a denylist over literal `run:` strings, not a sandbox; what it does and does not catch is set out in `docs/THREAT-MODEL.md` § What check 5 actually is, and the honest summary is at the end of § 2 below. This is the checklist a platform engineer works through per repo. Budget a day for the first deploy workflow, less for each one after.

## 1. Put every secret-bearing job in an Environment

The OIDC token only carries an `environment` claim when the job declares one, and that claim is the only job identity KLAXON trusts (there is no `job` claim in GitHub's token).

```yaml
jobs:
  deploy:
    environment: production      # required — the claim the witness enforces
    permissions:
      id-token: write            # mint the OIDC token
      contents: read
```

- The environment must exist with **no protection rules that pause the job** for the "0 human approvals" property; branch restrictions are fine.
- On GitHub Free, environments exist for **public repositories only**. Private repos need Pro or Team.
- Bind on `repository_id`, not the repository name — names are renameable; KLAXON already does this.

## 2. Never install packages in the job that holds secrets

This is the whole Shai-Hulud lesson. The job that runs `klaxon/get` must run from a pinned container image or a prebuilt artifact, and its `run:` steps must match none of the 14 patterns the witness enforces (`packages/witness/src/lint/patterns.ts`):

```
npm|pnpm|yarn|bun install|i|ci|add · npx · pnpm dlx · bunx
pip|pip3 install · uv pip install · poetry install
cargo install|add · go install|get · gem install · bundle install
apt-get install · brew install · curl … | sh · wget … | sh
```

Pattern:

```yaml
jobs:
  build:                          # installs, builds, tests — NO environment, NO secrets
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<40-hex>
      - run: npm ci && npm run build
      - uses: actions/upload-artifact@<40-hex>
        with: { name: dist, path: dist/ }
  deploy:                         # environment-bearing — consumes the artifact, installs nothing
    needs: build
    runs-on: ubuntu-latest
    environment: production
    permissions: { id-token: write, contents: read }
    container: ghcr.io/foundry-rs/foundry@sha256:<digest>
    steps:
      - uses: actions/checkout@<40-hex>
      - uses: actions/download-artifact@<40-hex>
        with: { name: dist }
      - id: klaxon
        uses: KaranSinghBisht/klaxon/packages/action@<40-hex>
        with:
          secret: DEPLOYER_PRIVATE_KEY
          member: ${{ secrets.KLAXON_MEMBER }}
          pay-account: ${{ vars.KLAXON_PAY_ACCOUNT }}
          pay-key: ${{ secrets.KLAXON_PAY_KEY }}
      - run: forge script script/Deploy.s.sol --broadcast
        env:
          DEPLOYER_PRIVATE_KEY: ${{ steps.klaxon.outputs.value }}
```

Plumb the output into exactly the one step that needs it. Never `echo "X=…" >> $GITHUB_ENV` — that puts the secret in the environment of every later step, which is precisely the read path KLAXON exists to close.

**Know what this pattern does and does not buy you.** The `build` job has no `environment:`, so check 5
never looks at it — and check 5 does not open the artifact it produces. Whatever a compromised
dependency of `build` writes into `dist/` runs inside `deploy`, next to the secret. The same is true
of a composite action: a 40-hex pin proves the action is immutable, not that its own steps are clean,
and the lint does not fetch them. The denylist is also a string match, not a shell model —
`make deploy`, `./gradlew build`, `yarn dlx`, `docker run` and `bash <(curl …)` all pass it.

None of that breaks KLAXON's claim, and it is worth being clear why: code that reaches the deploy job
by any of those routes still cannot obtain the secret without a paid, signed, consensus-timestamped
commitment naming the secret, the environment and the run. The split job pattern raises the cost of
getting into the protected job. The commitment is what stops the secret leaving it quietly.

## 3. Pin every `uses:` by 40-hex commit SHA

Tags are mutable. The lint refuses `@v4`. Note that some repositories (e.g. `pnpm/action-setup`) publish annotated tags: `git ls-remote --refs` returns the tag object's SHA, which is *not* a valid pin — resolve the commit the tag points at.

## 4. Reusable workflows and pull requests

- Reusable workflows from another repository are refused by default (the witness would have to fetch a workflow outside the project to lint it). Keep deploy workflows in-repo, or run your own witness with that repository allow-listed.
- `pull_request` events are refused: the token's `sha` is a merge commit that differs from `workflow_sha`.

## 5. Secrets you keep vs. secrets you stop keeping

| Before | After |
|---|---|
| `DEPLOYER_PRIVATE_KEY`, RPC keys, Etherscan, Vercel, … as repo secrets | one `.klaxon/<NAME>.enc` per secret, committed |
| — | `secrets.KLAXON_MEMBER` — one base64 line from `klaxon export-member` |
| — | `secrets.KLAXON_PAY_KEY` + `vars.KLAXON_PAY_ACCOUNT` — a dedicated Hedera account holding a few ℏ |

Two low-value credentials replace N high-value ones. Both are assumed to leak in the threat model; neither alone yields a secret.

## 6. Start with the boring secret

Put the Etherscan key or an RPC key behind KLAXON on a low-stakes repo first. The deployer key goes last — and for **mainnet**, it should not be in CI at all: propose from CI, sign from a Safe with Ledgers. KLAXON is for the sixty tokens that have no OIDC path.
