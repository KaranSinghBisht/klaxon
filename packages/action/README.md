# `klaxon/get` — the KLAXON GitHub Action

Releases a KLAXON-protected secret into one job, against a runner-made x402 payment on Hedera whose
transaction memo is the hash of a signed release commitment. The witness cannot hand over share B
without leaving that payment and an HCS message behind, and `npx klaxon verify` re-derives both from
public data.

This is a **Node 24 JS action** (`runs.using: node24`; Node 20 leaves Actions runners on
2026-09-16). `dist/` is committed because GitHub does not install dependencies for JS actions.

## Consumer workflow

```yaml
name: deploy
on: [push]

permissions:
  id-token: write     # required — this is what mints the OIDC token the witness checks
  contents: read      # required for actions/checkout

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production          # the claim the witness enforces (check 4)
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd  # v5.0.1
      - id: klaxon
        uses: KaranSinghBisht/klaxon/packages/action@0000000000000000000000000000000000000000  # replace with a real 40-hex SHA
        with:
          secret: DEPLOYER_PRIVATE_KEY
          member: ${{ secrets.KLAXON_MEMBER }}
          pay-account: ${{ vars.KLAXON_PAY_ACCOUNT }}
          pay-key: ${{ secrets.KLAXON_PAY_KEY }}
      - run: forge script Deploy --broadcast
        env:
          DEPLOYER_PRIVATE_KEY: ${{ steps.klaxon.outputs.value }}
```

**Pin every `uses:` by 40-hex SHA.** Both because a tag is mutable and because the witness's own
workflow lint (release check 5) refuses an environment-bearing job that contains an unpinned `uses:`
or an install step — KLAXON must pass its own rule. A `v1` tag in a demo repo will make the witness
refuse the release.

`environment: production` is not decoration: the OIDC `environment` claim exists **only** when the
job declares `environment:`, and check 4 requires `C.environment` to be in
`klaxon.policy.json`'s `environments`. A job with no environment still pays and is still recorded —
it is simply refused with `environment` = `(none)`.

## Inputs and outputs

| Input | Required | Default | What it is |
|---|---|---|---|
| `secret` | yes | — | Secret name as registered with `klaxon add`. Reads `.klaxon/<name>.enc` from the checkout. |
| `witness` | no | `https://klaxon-witness.fly.dev` | Witness base URL. |
| `member` | yes | — | `KLAXON_MEMBER` — the Ledger Key Ring member credential, base64 or JSON. |
| `pay-account` | yes | — | Hedera account id that pays for the release, e.g. `0.0.1234567`. |
| `pay-key` | yes | — | That account's **ECDSA** private key, `0x`-prefixed. |
| `max-tinybars` | no | `200000` | Hard per-payment spend cap, in tinybars. |

Output: `value` — the released plaintext, masked in logs.

There is deliberately **no `wallet-pass` input** (D3). `klaxon export-member --plaintext` is the
supported path; a second secret sitting in the same environment as the first buys nothing against
the attacker this design concedes.

## The two secrets and one variable

| GitHub setting | Name | Why it is where it is |
|---|---|---|
| Repository/environment **secret** | `KLAXON_MEMBER` | The Ledger Key Ring member keypair. Restores the wallet-sync key that opens share A. |
| Repository/environment **secret** | `KLAXON_PAY_KEY` | Hedera ECDSA private key, `0x`-prefixed, loaded with `PrivateKey.fromStringECDSA`. Fund it from <https://portal.hedera.com> (100 ℏ, refillable daily). |
| Repository **variable** | `KLAXON_PAY_ACCOUNT` | `0.0.1234567`. Not a secret — it is in every transfer list on a public ledger. |

The runner needs **no HBAR for gas**: the x402 facilitator's account is the fee payer on chain, and
the runner is only the debit in `transfers[]`. At `100000` tinybars a release, one HBAR buys ~1000
releases.

## `setOutput`, never `GITHUB_ENV`

| Mechanism | Blast radius | Verdict |
|---|---|---|
| `core.setOutput('value', secret)` | Reachable only via `${{ steps.<id>.outputs.value }}`. Written to `$GITHUB_OUTPUT`, a file in the runner temp dir, readable by later steps in the same job. | **Used.** |
| `core.exportVariable(...)` (`$GITHUB_ENV`) | Injected into the **environment of every subsequent step in the job**, including the `postinstall` of anything a later step installs. This is precisely the Shai-Hulud read path KLAXON exists to close. | **Never.** |

Both live for the rest of the job. The difference is that an output must be explicitly plumbed into
one step's `env:`, so the secret is in the environment of exactly the process that needs it and of
no other process. That is the honest answer to "a worm in the deploy job still gets the secret": it
gets it only if it is *in* that step.

The action calls `core.setSecret(value)` **before** anything else touches the value, then emits
`::add-mask::` for every piece of derived material (wallet-sync key, share A, share B, the data key,
the plaintext bytes in hex and base64). Masking is literal and line-oriented — it will not catch a
re-encoding the registry does not know about, so never log derived forms.

The post step re-masks and writes the commitment hash to `$GITHUB_STEP_SUMMARY`. To do that it
reads the value back from `$GITHUB_STATE`, which the runner exposes only to this action's own post
step (`STATE_*`), i.e. the same runner-temp blast radius as the output and not the job-wide
environment. Runner-side masks already persist across steps, so the re-mask is belt-and-braces.

## Failure surfacing

| Failure | Class | What the job log says |
|---|---|---|
| `getIDToken` cannot find `ACTIONS_ID_TOKEN_REQUEST_URL` | infra | `KLAXON: missing id-token: write permission — add \`permissions: { id-token: write }\` to the job` |
| Witness 403 `{class:"auth"\|"policy"}` | auth/policy | `KLAXON: release refused (<class>, check <n>: <reason> · commitment <h>)`, plus `· the project is now revoked` for a policy failure other than check 7 |
| Witness 503 `{class:"infra"}` | infra | `KLAXON: witness could not complete the release (…) — fail closed, retry`. No revoke. |
| Payment rejected (spend control, insufficient HBAR) | infra | names `pay-account` and points at the balance and `max-tinybars`; fail closed, retry |
| `sha256(B) != b_hash` | — | `KLAXON: witness returned a bad share`. The share is **never** printed — this is a witness-compromise signal. |

A 402 that arrives without `extra.memo` or `extra.feePayer` is refused **before signing**: an
unmemoed payment would settle, cost real HBAR, and then be unpairable with this run.

## `dist/` is checked in, and CI enforces it

`.github/workflows/check-dist.yml` rebuilds the bundle and runs
`git diff --exit-code -- packages/action/dist/`. **If `dist/` is stale, that job fails.** After any
change under `packages/action/src`, run:

```bash
pnpm --filter @klaxon/action build
git add packages/action/dist
```

`packages/action/dist/` is deliberately un-ignored in the repo's `.gitignore`. Three files are
committed: `index.js`, `post.js`, and a one-line `package.json` containing `{ "type": "commonjs" }`.
That last file is load-bearing — the package itself is `"type": "module"`, so without it Node reads
the CJS bundle as ESM and the action dies at startup with `module is not defined in ES module
scope`. The build script writes it; do not delete it.

## Checking OIDC before anything else

`.github/workflows/probe.yml` is a manual `workflow_dispatch` job that mints
`getIDToken("klaxon:deadbeef")` in the `production` environment and prints the decoded claims. Run
it first on any new repository: it de-risks the whole action in five minutes, and a non-empty
`environment` claim in its output is the precondition for every release.
