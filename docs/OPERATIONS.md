# Operations

What an operator does after `init`, what breaks, and what recovers it. Everything here assumes the
two properties in `docs/THREAT-MODEL.md`; nothing here weakens them.

Every command below was checked against the CLI definitions in `packages/cli/src/commands/` and
`packages/verify/src/bin.ts`. Where a documented procedure has no command yet, it says so.

## Day-to-day

| Task | Command | Device? |
|---|---|---|
| Add a secret | `printf '%s' "$VALUE" \| klaxon add NAME` | no |
| Change a secret's value | `printf '%s' "$NEW" \| klaxon rotate NAME` — generation N+1; the witness retires N | no |
| Change who may receive what | edit `klaxon.policy.json`, then `klaxon policy commit` — hashes the **exact committed bytes** and device-signs the hash onto Sepolia | **yes** |
| Stop all releases now | `klaxon revoke --reason "…"` — operator-signed, no device | no |
| Resume after a revoke | `klaxon unrevoke` — device-signs `Registry.unrevoke(project, epoch+1)`; the witness clears when it sees the event (3 confirmations; ≈ 1 min) | **yes** |
| Audit | `klaxon-verify` from **any** machine — it never talks to the witness (see below) | no |

`rotate` means the **upstream credential changes** — a new deployer key, a new API token.
Re-encrypting the same value invalidates almost nothing: a captured share A under generation N is
inert only because generation N+1 holds a different data key *and the old secret is dead*. Share B is
deterministic per generation (`docs/CLAIM.md`), so anyone who saw one release of generation N keeps
the ability to decrypt generation N forever. Rotation is the only thing that ends that.

## Running the verifier

No package in this repository is published — every `package.json` is `"private": true` — so `npx`
resolves nothing, and there is no `klaxon verify` subcommand: the verifier is a separate binary,
`klaxon-verify`. From a clean checkout of the public repo, on any machine:

```bash
git clone https://github.com/KaranSinghBisht/klaxon && cd klaxon && pnpm install
pnpm --filter @klaxon/verify dev --topic 0.0.X --witness 0.0.Y --registry 0xREG
```

`--topic`, `--witness` and `--registry` are all required — the tool prints usage and exits 2 without
them. Add `--json` for the machine-readable report. Exit codes: `0` clean, `1` violations found, `2`
the read could not complete.

## When the phone buzzes

A policy refusal means something asked for a secret it was not allowed: wrong environment, an install
step in the deploy job, an unpinned action, a secret outside the policy, a stale generation, a
replayed commitment. The project is already revoked. Tap the notification — it opens the attacker's
own payment on HashScan.

1. **Read the record.** `--since` takes a **Hedera consensus timestamp** (`seconds.nanos`), not a
   date — it becomes `timestamp=gte:` on the mirror node. To read the last 24 hours:

   ```bash
   # GNU/Linux
   pnpm --filter @klaxon/verify dev --topic 0.0.X --witness 0.0.Y --registry 0xREG \
     --since "$(date -d '1 day ago' +%s).0"
   # macOS
   pnpm --filter @klaxon/verify dev --topic 0.0.X --witness 0.0.Y --registry 0xREG \
     --since "$(date -v-1d +%s).0"
   ```

   **Rotate every secret the report names as released in the window — only those.**
2. Find the cause in the run the alarm names (`run_id` is in the message).
3. `klaxon unrevoke` from the device once the cause is fixed.

An **infra** alarm (mirror node, GitHub, RPC, Ledger's API unreachable) never revokes. The job failed
closed; retry it.

## The two files on the laptop that matter

- **`WITNESS_MASTER` — 32 bytes.** Share B for every secret is *derived* from it
  (`HKDF(master, project/secret/gen)`), never stored. **Write it on paper before the first
  `klaxon add`.** With it, the repo, and the Key Ring, every secret is recoverable with zero witness
  state. Without it, nothing the witness holds helps you — by design, it holds nothing that decrypts
  alone. When the operator self-hosts, `klaxon` keeps a copy at `~/.klaxon/witness-master.key`
  (mode 0600). Paper is the backup that matters.
- **`~/.klaxon/operator.key` (mode 0600).** Generated at `klaxon init`; it authenticates the witness
  admin surface (`/projects`, `/shares`, `/rotate`, `/revoke`). It is deliberately **not** the LKRP
  member credential, because that one ships to every runner as an input of `klaxon/get` — see
  `docs/PROTOCOL.md` § 2. Back it up somewhere that is not this repository: **lose it and you cannot
  `add`, `rotate` or `revoke` that project**, and there is no recovery path short of registering the
  project again under a new operator key.

  The upside of the split is worth stating: a full runner compromise leaks `KLAXON_MEMBER` and
  `KLAXON_PAY_KEY` and **does not** leak the operator key, so an attacker on the runner cannot ask
  the witness for share B directly.

## Witness down (Friday, 6 pm, mainnet hotfix)

Deploys fail closed — the action cannot get share B. Options, in order:

1. **Redeploy the witness** on any host: `fly deploy`, or a container with the same `WITNESS_MASTER`
   and the same Hedera operator key. The SQLite database is *mostly* convenience state (release
   counters, cursor, workflow cache) — but not entirely: **revocation lives only there**
   (`docs/THREAT-MODEL.md` § Revocation is announced, not anchored), so a fresh database comes up
   un-revoked. Check the topic for an uncleared `revoke` before you let releases resume.

   **There is no command that re-registers an existing project against a fresh database.**
   `klaxon init --skip-ring-init` is *not* it: `init` always creates a **new** HCS topic before it
   calls `/projects`, so it would fork the project onto a topic the audit history does not follow.
   Until a `klaxon project register` exists, recovery means an operator-signed `POST /projects`
   carrying the original `topic_id` — the same body `init` sends, with the existing values from
   `~/.klaxon/config.json`. Restoring the SQLite volume is much less trouble; keep it backed up.
2. **`klaxon emergency NAME`** on the laptop with `WITNESS_MASTER` from paper: derives B, restores
   the Key Ring over the network, pays the commitment on Hedera from the laptop's account (memo = the
   emergency hash), publishes the `emergency` record to the project topic with the laptop's key, then
   decrypts. It prints once. It is loud on purpose — `verify` shows it as an `emergency` release,
   paired with its payment. `--no-pay` skips the trace and should be treated as an incident in itself.

Neither path bypasses the record. Both need Ledger's Key Ring API
(`trustchain.api.live.ledger.com`) to be reachable — a liveness dependency disclosed in the threat
model. The floor beneath that is `wallet-cli ring init` on the device, which rebuilds a trustchain
from hardware — but note it rebuilds a *new* one: it does not recover the old trustchain's keys, so
every existing `.enc` stays undecryptable. See the `destroyTrustchain` disclosure in
`docs/THREAT-MODEL.md`.

## Runner compromise

Assume `KLAXON_MEMBER` and `KLAXON_PAY_KEY` leaked; assume the operator key did **not** (it never
left the laptop). The attacker holds share A for everything, can pay for releases — each of which is
on the record and policy-checked — and, per the threat model, can `addMember` or `destroyTrustchain`
with no device. Do, in order:

1. `klaxon revoke --reason "…"` — stops releases immediately, no device.
2. Rotate every secret `klaxon-verify` names as released in the window. Treat *any* release under the
   compromised credential as full compromise of that generation: share B is deterministic and the
   attacker may hold it.
3. `wallet-cli ring destroy` then `wallet-cli ring init` on the device — new trustchain; the old
   member credential is dead, including any member the attacker enrolled. Everything encrypted under
   the old trustchain is now unrecoverable, which is why step 2 comes first.
4. `klaxon export-member` → replace the `KLAXON_MEMBER` GitHub secret.
5. Drain and replace the `KLAXON_PAY` account; update `vars.KLAXON_PAY_ACCOUNT` and re-register it so
   check 1 binds on the new one.
6. `klaxon unrevoke` from the device.

A leaked pay key costs at most its balance; keep it at a few ℏ.

## Self-hosted runners

Registering a runner changes nothing in the protocol — `runner_environment` is logged and ignored.
For filming, a self-hosted runner on the laptop removes queue latency; ship the repo with
`runs-on: ubuntu-latest` and delete the runner after. On a public repository keep "Require approval
for all outside collaborators" on and never register a runner to a repository holding real secrets.

## Ledger housekeeping

`ring init` once; the device then lives in a drawer. It is needed again only for `policy commit`,
`unrevoke`, `removeMember`, and creating a replacement trustchain. Keep **Blind signing** enabled in
the Ethereum app until an ERC-7730 descriptor for `KlaxonRegistry` is merged; the prompt shows the
registry address, `0 ETH`, and the calldata. Note that `wallet-cli send` has no `--network` — the
network rides on the session label `account discover` assigned, which `klaxon` reads out of
`account discover --output json` rather than hardcoding.
