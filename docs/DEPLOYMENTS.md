# Deployments

## Sepolia (chain 11155111) — 2026-09-10

Deployer (throwaway EOA, never the Ledger): `0x2014025433307dfBDeb2dBf45E74C5cAA7A8D6cB`

| Contract | Address | Notes |
|---|---|---|
| `KlaxonRegistry` | [`0xd93f10104d4069B26c8ee883c3eAb3AAaaD56885`](https://sepolia.etherscan.io/address/0xd93f10104d4069B26c8ee883c3eAb3AAaaD56885) | deploy block **11674139** = witness `KLAXON_REGISTRY_DEPLOY_BLOCK` |
| `DemoUSD` (dUSD) | [`0xC5bDbF010feC9371ccB0fC658E490a065c16740d`](https://sepolia.etherscan.io/address/0xC5bDbF010feC9371ccB0fC658E490a065c16740d) | 6-decimal demo stablecoin |
| `TokenTreasury` | [`0x29fEf4715D87d08a5a137F0E00F7A69287A830eA`](https://sepolia.etherscan.io/address/0x29fEf4715D87d08a5a137F0E00F7A69287A830eA) | holds **12,400 dUSD**; `withdraw()` drains it on camera |

The Ledger owner for `register` / `commitPolicy` / `unrevoke`: `0x9F6372be92C0fD060c5e16605ffB28f5Afc0505C`.

## Base mainnet — pending (ERC-7730 descriptor, D13)

## Hedera testnet — 2026-09-10

| Role | Account | Type |
|---|---|---|
| witness (HCS submit + x402 payee) | `0.0.10455530` | ECDSA |
| runner-pay (x402 payer) | `0.0.10455753` | ECDSA |
