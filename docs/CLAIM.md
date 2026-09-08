# The claim — stated precisely

KLAXON does **not** prevent a compromised job from reading a secret it was authorized to receive.

What it **guarantees**: no secret is released to any job without a release commitment that

1. the runner itself paid to place on Hedera,
2. names the secret, the environment, the run, and an ephemeral key only that runner holds, and
3. reached consensus before the second key share was released.

The witness cannot omit the commitment — the runner wrote it. The witness cannot forge one — it requires GitHub's signature over the commitment hash and the runner's ephemeral signature. Nobody can back-date it — Hedera consensus timestamps it.

A worm in the install phase, outside the environment that holds secrets, **pays to be refused** — the attempt is on the record and the project is revoked before share B ever moves.

A worm inside the authorized job can still read the secret after release. The record says exactly which secret, which environment, which run. **You rotate that one. Not sixty.**

What KLAXON does **not** do: prevent a compromised authorized job from reading what it was authorized to receive; protect against simultaneous compromise of a runner *and* the witness; protect a share A captured under generation N once generation N+1 exists (it is inert); protect the operator's laptop at `add` time; operate while Ledger's Key Ring backend is unreachable (a liveness dependency, disclosed).
