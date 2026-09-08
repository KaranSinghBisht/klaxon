import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { submitKeyList } from "../src/hedera/topic.js";

const sdk = await import("@hashgraph/sdk");

const witness = sdk.PrivateKey.generateED25519().publicKey;
const laptop = sdk.PrivateKey.generateECDSA().publicKey;

describe("submitKeyList", () => {
  it("is a 1-of-2 KeyList over {witness, laptop} (PROTOCOL §7)", () => {
    const list = submitKeyList(sdk, witness.toStringDer(), laptop);
    expect(list).toBeInstanceOf(sdk.KeyList);
    expect(list.threshold).toBe(1);
    const keys = list.toArray().map((k) => k.toString());
    expect(keys).toHaveLength(2);
    expect(keys).toContain(witness.toString());
    expect(keys).toContain(laptop.toString());
  });

  it("keeps the witness first so the common case is the cheap one", () => {
    const list = submitKeyList(sdk, witness.toStringDer(), laptop);
    expect(list.toArray()[0]?.toString()).toBe(witness.toString());
  });

  it("survives a round trip through TopicCreateTransaction", () => {
    const tx = new sdk.TopicCreateTransaction()
      .setTopicMemo("klaxon:test")
      .setAdminKey(laptop)
      .setSubmitKey(submitKeyList(sdk, witness.toStringDer(), laptop));
    const submit = tx.submitKey as import("@hashgraph/sdk").KeyList;
    expect(submit.threshold).toBe(1);
    expect(submit.toArray()).toHaveLength(2);
    expect(tx.adminKey?.toString()).toBe(laptop.toString());
  });

  it("accepts a raw-hex manifest key as well as DER", () => {
    expect(submitKeyList(sdk, witness.toStringRaw(), laptop).toArray()[0]?.toString()).toBe(
      witness.toString(),
    );
  });

  it("names the manifest when submit_key is not a public key", () => {
    expect(() => submitKeyList(sdk, "not-a-key", laptop)).toThrowError(CliError);
    expect(() => submitKeyList(sdk, "not-a-key", laptop)).toThrowError(/manifest submit_key/);
  });
});
