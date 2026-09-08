# KLAXON

> **Stolen, but never quietly.**

Your CI secrets are split in two. Share A is encrypted under your **Ledger Key Ring** and lives in your repo. Share B is released by a witness only when **the runner itself has paid on Hedera** — a sub-cent x402 payment whose memo is the hash of a signed release commitment naming the secret, the environment, the run, and an ephemeral key only that runner holds. Neither share is useful alone.

**No secret can be decrypted without a commitment the runner wrote to a public ledger first.** The witness can't omit it. The witness can't forge it. Nobody can back-date it. When a supply-chain worm tries, it *pays to be refused*.

See [`docs/CLAIM.md`](docs/CLAIM.md) for exactly what is and isn't guaranteed.

_Built for ETHOnline 2026. Work in progress — see `planning/` for the full spec, build plan, and nine adversarial reviews._
