# demo — the harness for the before/after shoot

Four moving parts stage the film. Two exist in this repo; two are GitHub repositories that get built
during the Gate work (they need a real `.enc`, a real deployed action SHA, and — for the worm's
`klaxon get` — the CLI resolvable, i.e. published or `npm link`ed).

| Part | Where | State |
|---|---|---|
| `collector/` | this repo, workspace package | **done** — the sink, prints stolen vars in block type |
| `worm/` (`postinstall-shape`) | this repo, NOT a workspace package | **done** — reads env, POSTs the collector, then tries `klaxon get` |
| `contracts` (`DemoUSD` + `TokenTreasury`) | `packages/contracts/src/demo/` | **done** — token treasury so "12,400 dUSD → 0" reads on real Etherscan |
| `ordinary-repo` | a separate public GitHub repo | spec below — build on Gate day |
| `klaxon-repo` | a separate public GitHub repo | spec below — build on Gate day |

## Why the two repos are not scaffolded here

Their content is not authorable by hand yet, and guessing it now bakes in errors:

- `klaxon-repo/.klaxon/DEPLOYER_PRIVATE_KEY.enc` comes out of a real `klaxon add`, which needs the
  Ledger (Gate A) and the live witness. There is no honest placeholder.
- `klaxon.policy.json`'s `project_id` derives from the trustchain root, which only exists after
  `ring init`.
- The deploy job's `uses: <owner>/klaxon/packages/action@<40-hex>` needs the repo public and a real
  commit SHA (land-then-pin), and the worm's `klaxon get` needs `klaxon` resolvable.

## ordinary-repo — the victim

A public repo, one job `build-and-deploy`: `npm ci` (which runs the worm's postinstall) → `forge
script DeployDemoToken`. `DEPLOYER_PRIVATE_KEY` is a **plain** GitHub Actions secret. Depends on
`postinstall-shape` (the worm) so `npm ci` triggers it. This is the "before": the worm reads the
plain secret and it lands on the collector in giant type; the stolen key drains the treasury.

## klaxon-repo — the protected repo

A public repo, two jobs:

- `install` — **no `environment`**, `npm ci` (runs the worm), uploads a build artifact. The worm here
  gets no plain secret; its `klaxon get` attempt is the *paid refusal* (pays the witness, refused
  because the install job carries no environment), the phone buzzes, the project revokes.
- `deploy` — `environment: production` with **no protection rules** (that is the "0 human approvals"
  point, not a disabled safeguard — say so on camera), a pinned container, `uses:
  <owner>/klaxon/packages/action@<40-hex>` to release the secret, then `forge script
  DeployDemoToken`. **No `${{ }}` inside any `run:`** — check 5 now refuses an unresolvable run step,
  and in an environment-bearing job that would revoke.

Committed to the repo: `.klaxon/DEPLOYER_PRIVATE_KEY.enc` and `klaxon.policy.json`, both from
`klaxon add` after Gate A.

## Shoot

`scripts/shoot.sh [ordinary-repo-dir] [klaxon-repo-dir]` lays out the tmux window: LEFT ordinary,
RIGHT klaxon, aux underneath for the one push that hits both. Terminal font ≥ 18 pt. Real time —
cut queue latency, never speed up.
