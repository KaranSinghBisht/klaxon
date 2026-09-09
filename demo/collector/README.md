# collector — the exfiltration sink

The attacker's machine in the demo. It listens for the worm's `POST /collect`, then paints
every variable it received in block type large enough to read from across the room. Interesting
names (`*KEY*`, `*SECRET*`, `*TOKEN*`, `DEPLOYER_*`, …) get a red banner; the rest are listed
small so the frame is not buried under `PATH`.

This is the **before** half of the film — the world KLAXON argues against. When the ordinary
repo runs, its `DEPLOYER_PRIVATE_KEY` lands here in giant type. When the KLAXON repo runs, the
worm posts a job environment with **no** secret in it, and nothing interesting shows up.

## Run it

```bash
pnpm --filter @klaxon-demo/collector start        # listens on :4000
COLLECTOR_WIDTH=100 PORT=4000 pnpm --filter @klaxon-demo/collector start
```

Then expose it so a hosted runner can reach it:

```bash
cloudflared tunnel --url http://localhost:4000
# put the printed https URL in demo/worm as COLLECTOR_URL
```

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `4000` | listen port |
| `HOST` | `0.0.0.0` | bind address |
| `COLLECTOR_WIDTH` | `120` | terminal columns to wrap block type at |

## Safety

No auth, no storage, no CI. It holds nothing and never runs inside GitHub Actions. The only
secret it is ever shown is the demo's own throwaway Sepolia key, which funds one testnet
treasury and is rotated after the shoot. The block font is hand-rolled (`src/bigtext.ts`) rather
than pulled from npm — an attacker tool that installed half the registry to draw letters would
be making KLAXON's own point for it.
