# AI usage disclosure

ETHGlobal asks entrants to document where and how AI tools were used. This project was built with
**Claude Code** (Anthropic) as the primary engineering assistant, and one cold review from
**OpenAI Codex**. This disclosure is itself written with Claude Code, under review.

**Research and selection (Sept 7–8):** Claude Code researched sponsor tracks, prior art (Ledger's
June 2026 N3XT hackathon, ERC-7715 delegation, npm trusted publishing), the 2026
credential-compromise data cited in `docs/SOURCES.md`, and Google's OAuth token model. Six candidate
projects were generated and ranked; the chosen one was rewritten three times (v1 → v2 → v3, in
`planning/`) as adversarial reviews found holes.

**Simulated adversarial review:** nine reviews in `planning/simulated-review/` were produced by
Claude Code subagents playing named personas (a security engineer, a Ledger panelist, an ETHGlobal
screener, a Hedera panelist, the first user) plus feasibility/compliance/coherence passes, and one
by Codex. **They are simulations, not real judge feedback.** Their findings — most importantly that
v2's central invariant did not hold — drove the v3 architecture.

**Implementation planning:** the build plan and its two appendices were produced by Claude Code
agents that checked every API against published packages and, where an endpoint was reachable
without hardware, against the live service (Blocky402 `/supported`, the Hedera mirror node, GitHub's
OIDC discovery document) and, for the Ledger Key Ring format, by extracting and reading the
wallet-cli 2.1.0 bundle. The one piece of genuinely captured runtime evidence in this repository is
`docs/evidence/oidc-probe.json` — a real GitHub Actions OIDC token's claims, from run 34204022296.

**Code:** written by Claude Code under human direction, package by package, with tests run at every
step. The human operator reviewed and committed the work. Commit history is unsquashed and every
commit carries a `Co-Authored-By` trailer naming the model that wrote it.

**What has not happened yet.** As of 2026-09-09 the physical Ledger has never been connected: no
`ring init`, no device signature, no trustchain. No contract is deployed on any chain, and no
account has been funded. Gate A (`scripts/gate-a.sh`), which proves headless Key Ring decryption,
has not run, and `packages/core/test/wallet-cli-interop.test.ts` is skipped for that reason. Every
device-dependent statement in `docs/LEDGER-FEEDBACK.md` is marked *pending Gate A*. When those steps
happen, they will be run by the human operator, on the operator's own hardware — no AI tool has or
will have access to the device or to funded keys.

Nothing in this repository was reused from any prior project. See
[`README.md` § Prior work & disclosure](../README.md#prior-work--disclosure) for related work and how
KLAXON differs from it.
