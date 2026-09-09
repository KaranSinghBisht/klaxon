# The claim — stated precisely

KLAXON does **not** prevent a compromised job from reading a secret it was authorized to receive.

What it **guarantees**: no secret is released **for the first time** to any job without a release
commitment that

1. the runner itself paid to place on Hedera — the debit in the settled transfer must be the pay
   account registered for that project, so a payment by some other party does not buy a release,
2. names the secret, the environment, the run, and an ephemeral key only that runner holds, and
3. reached consensus before the second key share was released.

The witness cannot omit the commitment — the runner wrote it. The witness cannot forge one — it
requires GitHub's signature over the commitment hash and the runner's ephemeral signature. Nobody
can back-date it — Hedera consensus timestamps it.

A worm in the install phase, outside the environment that holds secrets, **pays to be refused** — the
attempt is on the record and the project is revoked before share B ever moves.

A worm inside the authorized job can still read the secret after release. The record says exactly
which secret, which environment, which run. **You rotate that one. Not sixty.**

## Why "for the first time"

Share B is derived, not random: `B = HKDF(WITNESS_MASTER, "klaxon/b/v1", project_id/secret/gen)`.
Every release of the same generation returns the same 32 bytes, and share A in the repository does
not change within a generation. So anything that captures both once can decrypt that generation
offline from then on — no payment, no token, no witness, no new record. The log shows the first
release and nothing after it.

That is a real limit, not a footnote: **one observed release under a compromised runner is full
compromise of that generation**, and rotation to generation N+1 with a genuinely new upstream
credential is the only remediation. The guarantee KLAXON makes is that the first release cannot
happen quietly — which is what turns "sixty secrets, unknown blast radius" into "this one, this run,
rotate it".

## What KLAXON does not do

Prevent a compromised authorized job from reading what it was authorized to receive; stop an attacker
replaying a share B it already captured (see above); protect against simultaneous compromise of a
runner *and* the witness; protect a share A captured under generation N once generation N+1 exists
(it is inert); protect the operator's laptop at `add` time; survive a leaked member credential being
used to `destroyTrustchain`, which needs no device and makes every share A unrecoverable
(`docs/THREAT-MODEL.md`); operate while Ledger's Key Ring backend is unreachable (a liveness
dependency, disclosed).
