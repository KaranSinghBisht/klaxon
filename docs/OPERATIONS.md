# Operations

What an operator does after `init`, what breaks, and what recovers it. Everything here assumes the two properties in `docs/THREAT-MODEL.md`; nothing here weakens them.

## Day-to-day

| Task | Command | Device? |
|---|---|---|
| Add a secret | `printf '%s' "$VALUE" \| klaxon add NAME` | no |
| Change a secret's value | `printf '%s' "$NEW" \| klaxon rotate NAME` — generation N+1; the witness retires N | no |
| Change who may receive what | edit `klaxon.policy.json`, then `klaxon policy commit` — hashes the **exact committed bytes** and device-signs the hash onto Sepolia | **yes** |
| Stop all releases now | `klaxon revoke --reason "…"` — member-signed, no device | no |
| Resume after a revoke | `klaxon unrevoke` — device-signs `Registry.unrevoke(project, epoch+1)`; the witness clears when it sees the event (3 confirmations; ≈ 1 min) | **yes** |
| Audit | `npx klaxon-verify --topic 0.0.X --witness 0.0.Y --registry 0x…` from **any** machine — it never talks to the witness | no |

`rotate` means the **upstream credential changes** — a new deployer key, a new API token. Re-encrypting the same value invalidates nothing; a captured share A under generation N is inert only because generation N+1 holds a different data key *and* the old secret is dead.

## When the phone buzzes

A policy refusal means something asked for a secret it was not allowed: wrong environment, an install step in the deploy job, an unpinned action, a secret outside the policy, a stale generation, a replayed commitment. The project is already revoked. Tap the notification — it opens the attacker's own payment on HashScan.

1. Read the record: `klaxon-verify --since <today>` lists every release in the window. **Rotate those secrets — only those.**
2. Find the cause in the run the alarm names (`run_id` is in the message).
3. `klaxon unrevoke` from the device once the cause is fixed.

An **infra** alarm (mirror node, GitHub, RPC, Ledger's API unreachable) never revokes. The job failed closed; retry it.

## The single piece of witness state that matters

`WITNESS_MASTER` — 32 bytes. Share B for every secret is *derived* from it (`HKDF(master, project/secret/gen)`), never stored. **Write it on paper before the first `klaxon add`.** With it, the repo, and the Key Ring, every secret is recoverable with zero witness state. Without it, nothing the witness holds helps you — by design, it holds nothing that decrypts alone.

## Witness down (Friday, 6 pm, mainnet hotfix)

Deploys fail closed — the action cannot get share B. Options, in order:

1. **Redeploy the witness** on any host: `fly deploy` or `docker run` with the same `WITNESS_MASTER` and the same Hedera operator key. The SQLite database is convenience state (release counters, cursor, cache); a fresh one re-learns projects on the next `/projects` call. Re-run `klaxon init --register-only` per project if you lost the database.
2. **`klaxon emergency NAME`** on the laptop with `WITNESS_MASTER` from paper: derives B, restores the Key Ring over the network, pays the commitment on Hedera from the laptop's account (memo = the emergency hash), publishes the `emergency` record to the project topic with the laptop's key, then decrypts. It prints once. It is loud on purpose — `verify` shows it as an `emergency` release, paired with its payment.

Neither path bypasses the record. Both need Ledger's Key Ring API (`trustchain.api.live.ledger.com`) to be reachable — a liveness dependency disclosed in the threat model. The floor beneath that is `ring destroy` + `ring init` on the device, which rebuilds the trustchain from hardware.

## Runner compromise

Assume `KLAXON_MEMBER` and `KLAXON_PAY_KEY` leaked. The attacker holds share A for everything and can pay for releases — each of which is on the record and policy-checked. Do, in order: `klaxon revoke` → rotate every secret named by `verify` in the window → `wallet-cli ring destroy` and `ring init` on the device (new trustchain; old member credential is dead) → `klaxon export-member` → replace the GitHub secret → drain and replace `KLAXON_PAY` → `klaxon unrevoke`. A leaked pay key costs at most its balance; keep it at a few ℏ.

## Self-hosted runners

Registering a runner changes nothing in the protocol — `runner_environment` is logged and ignored. For filming, a self-hosted runner on the laptop removes queue latency; ship the repo with `runs-on: ubuntu-latest` and delete the runner after. On a public repository keep "Require approval for all outside collaborators" on and never register a runner to a repository holding real secrets.

## Ledger housekeeping

`ring init` once; the device then lives in a drawer. It is needed again only for `policy commit`, `unrevoke`, and re-keying the trustchain. Keep **Blind signing** enabled in the Ethereum app until the ERC-7730 descriptor for `KlaxonRegistry` is merged; the prompt shows the registry address, `0 ETH`, and the calldata.
