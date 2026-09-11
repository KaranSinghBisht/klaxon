# Witness on AWS (one EC2 box)

The witness needs three things — always-on, a persistent disk (`node:sqlite`), and public HTTPS.
On AWS that's cleanest as a single small instance running the container behind Caddy, which does
automatic HTTPS against an **sslip.io** hostname so you never buy or configure a domain. `/data`
lives on the instance's EBS volume.

**Cost:** a `t4g.small` (2 GB, Graviton) is ~\$12/mo on-demand, so a hackathon-through-judging week is
a couple of dollars. `t4g.micro` (1 GB) is half that and enough.

## 0. Re-auth and pick a region

```
aws login                      # your session is expired
```

Your default region is `ap-south-1` (Mumbai) — that's far from GitHub's US-East runners and adds
latency to the money-shot 402. Prefer **`us-east-1`** for the demo (`--region us-east-1` below, or
`aws configure set region us-east-1`).

## 1. Provision (driven for you once you're re-authed)

A security group (22 from your IP; 80 + 443 from anywhere), a `t4g.small` on Amazon Linux 2023 with
`bootstrap.sh` as user-data, a 20 GB root EBS, and an Elastic IP. The Elastic IP is what makes the
`sslip.io` host — and therefore the witness URL — stable across reboots.

`SITE_ADDRESS` / `KLAXON_PUBLIC_URL` = `https://<elastic-ip-with-dashes>.sslip.io`
(e.g. IP `13.234.56.78` → `13-234-56-78.sslip.io`).

## 2. Ship the image and config

The image is private, so it's built locally and loaded on the box (no registry needed):

```
docker build --platform linux/arm64 -f packages/witness/Dockerfile -t klaxon-witness:latest .
docker save klaxon-witness:latest | gzip > /tmp/klaxon-witness.tgz
scp -i <key.pem> /tmp/klaxon-witness.tgz deploy/aws/{docker-compose.yml,Caddyfile} \
    ec2-user@<eip>:/opt/klaxon/
# witness.env with the four secrets filled in — never commit it:
scp -i <key.pem> deploy/aws/witness.env ec2-user@<eip>:/opt/klaxon/
```

Build `--platform linux/arm64` for a `t4g` (Graviton); use `linux/amd64` for a `t3`.

## 3. Start it

```
ssh -i <key.pem> ec2-user@<eip>
cd /opt/klaxon
gunzip -c klaxon-witness.tgz | docker load
export SITE_ADDRESS=<eip-with-dashes>.sslip.io
docker compose up -d
```

## 4. Confirm

```
curl -s https://<eip-with-dashes>.sslip.io/health
```

`{"db":...,"mirror":...,"facilitator":...}` all healthy → the witness is live, and that URL is the
`--witness` you hand `klaxon init`.

## Secrets to fill in `witness.env`

- `WITNESS_MASTER` — `openssl rand -hex 32`, **written on paper first** (losing it makes every `.enc`
  unrecoverable).
- `HEDERA_OPERATOR_KEY` — the witness account `0.0.10455530`'s `0x` ECDSA key.
- `NTFY_DEFAULT_TOPIC` — `klaxon-<32 hex>`; subscribe your phone's ntfy app to that exact string.
- `HEDERA_OPERATOR_ID` is already `0.0.10455530` in the example.
