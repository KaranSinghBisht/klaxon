# Sources

Every statistic and incident cited in the README, the video, and the docs. Each row was re-checked
against the linked page on 2026-09-09; where the original attribution was wrong, the row now names
the source that actually says the number.

| Claim | Source |
|---|---|
| H1 2026: ~76% of all crypto funds stolen came from infrastructure and **operational** compromises, from ~15% of incidents | TRM Labs, July 1 2026 — *"Infrastructure and operational compromises accounted for approximately 76% of all funds stolen, despite representing only about 15% of incidents."* https://www.trmlabs.com/resources/blog/h1-2026-crypto-hacks-reach-record-high-as-losses-fall-below-usd-1-billion |
| ~40% of the $16.69B lost to crypto hacks all-time traces to stolen private keys, not smart-contract bugs | CoinDesk, June 29 2026 — https://www.coindesk.com/tech/2026/06/29/private-keys-not-smart-contracts-caused-40-of-crypto-s-usd16-billion-hack-losses-here-s-whats-being-done · underlying data: DeFiLlama. **Note:** CoinDesk rate-limits automated fetches (HTTP 429); confirm by hand before quoting. One secondary source states $16.66B rather than $16.69B. |
| Shai-Hulud 2.0 (Nov–Dec 2025): ~700 compromised npm packages; the worm created 25,000+ malicious repositories across ~500 GitHub users | Wiz, Nov 24 2025 — *"currently at ~700 in total"*, *"25,000+ malicious repos across ~500 GitHub users"* — https://www.wiz.io/blog/shai-hulud-2-0-ongoing-supply-chain-attack · Microsoft's incident guidance (no package counts): https://www.microsoft.com/en-us/security/blog/2025/12/09/shai-hulud-2-0-guidance-for-detecting-investigating-and-defending-against-the-supply-chain-attack/ |
| Trust Wallet: $8.5M drained after a leaked API key was used to publish a trojanized Chrome extension outside the normal release process | SecurityWeek, Dec 31 2025 — *"approximately $8.5 million in assets impacted"*, 2,520 drained addresses — https://www.securityweek.com/shai-hulud-supply-chain-attack-led-to-8-5-million-trust-wallet-heist/ ; The Hacker News — https://thehackernews.com/2025/12/trust-wallet-chrome-extension-hack.html |
| Mini Shai-Hulud (May 2026): 170+ npm packages and 2 PyPI packages, across 404 malicious versions | Microsoft Security Blog — the May 11 2026 update block appended to the Dec 9 2025 post: *"…compromising 170+ npm packages and 2 PyPI packages across 404 malicious versions."* https://www.microsoft.com/en-us/security/blog/2025/12/09/shai-hulud-2-0-guidance-for-detecting-investigating-and-defending-against-the-supply-chain-attack/ · independent count (170+ as a **combined** npm+PyPI total): OX Security, May 12 2026 — https://www.ox.security/blog/shai-hulud-here-we-go-again-170-packages-hit-across-npm-pypi/ |
| npm trusted publishing via OIDC generally available | GitHub Changelog, July 31 2025 — https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/ |
| Ledger N3XT Build & Show (June 2026): 50 submissions from 38 universities across 8 countries; "CI/CD & DevOps signing" drew **1** | Ledger, June 23 2026 — *"It drew 50 submissions from 38 universities and blockchain clubs across 8 countries, with 46 public GitHub repositories."* https://www.ledger.com/blog-ledger-n3xt-agent-stack-build-show |
| The Key Ring (`ring`) command group shipped in wallet-cli 2.0.0 on July 10 2026 | wallet-cli CHANGELOG — *"the `2.0.0` release marks the addition of the `earn` and `ring` command groups"* — https://github.com/LedgerHQ/ledger-live/blob/develop/apps/wallet-cli/CHANGELOG.md · merged as PR #19477, https://github.com/LedgerHQ/ledger-live/pull/19477 |
| 88% of organizations reported confirmed or suspected AI-agent security incidents in the last year | Gravitee, *State of AI Agent Security 2026*, Feb 4 2026 (n=919) — https://www.gravitee.io/blog/state-of-ai-agent-security-2026-report-when-adoption-outpaces-control |
| Only 6% of security budgets address agentic-AI risk | Arkose Labs, *2026 Agentic AI Security Report*, via VentureBeat, April 17 2026 — https://venturebeat.com/security/most-enterprises-cant-stop-stage-three-ai-agent-threats-venturebeat-survey-finds |
| Node 20 is removed from GitHub Actions runners on **2026-09-23** (Node 24 became the default on 2026-06-16) | GitHub Changelog, Sept 19 2025, as revised Aug 25 2026 — *"This will only work until we upgrade the runner and remove Node20 on September 23rd, 2026."* https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/ |

## Corrections made on 2026-09-09

Recorded because a source table that quietly changes is worth less than one that shows its working.

- **The Shai-Hulud 2.0 figures were attributed to the wrong publisher and were wrong.** "600–800 npm
  packages, 25,000+ repositories compromised" does not appear on the Microsoft post that was cited;
  that post gives no package or repository counts at all. The figures are Wiz's, and two of the three
  numbers change on re-reading: **~700** packages, not a 600–800 range, and **25,000+ repositories
  created by the worm**, not existing repositories compromised. That is a materially different — and
  smaller — claim, and the corrected version is what is now in the table.
- **The "88% / 6%" row cited Kiteworks, which says neither number.** That page's figure is 65%, from
  a different survey. The two statistics are real but belong to Gravitee and Arkose Labs
  respectively; they are now two separate rows with their own sources.
- **The Node 20 removal date was wrong** — 2026-09-16 in earlier drafts; GitHub's changelog says
  **September 23rd, 2026** after its August 2026 revision.
- **The TRM wording was wrong** — the source says "infrastructure and **operational** compromises",
  not "credential compromise". The table now quotes it.
- **Mini Shai-Hulud had no link because the post it needed does not exist.** There is no standalone
  May 2026 Microsoft post with these numbers; the claim lives in an update block appended to the
  December 2025 post, which is now the link. (A genuinely separate May 20 2026 Microsoft post on
  Mini Shai-Hulud exists but is `@antv`-scoped and gives no totals — do not cite it for this.)
