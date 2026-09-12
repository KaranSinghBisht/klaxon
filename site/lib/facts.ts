/**
 * Every figure on this site comes from here, and every one of them is real: a transaction that
 * settled, a workflow run that a hosted GitHub runner executed, an address with bytecode at it.
 * Nothing on the page is illustrative. If a number cannot be clicked through to the thing that
 * produced it, it does not belong in this file.
 */

export const WITNESS = "https://44-198-37-65.sslip.io";
export const REPO = "https://github.com/KaranSinghBisht/klaxon";
export const DEMO_REPO = "https://github.com/KaranSinghBisht/klaxon-demo";

export const CHAIN = {
  topic: "0.0.10503843",
  witnessAccount: "0.0.10455530",
  payAccount: "0.0.10455753",
  registry: "0xd93f10104d4069B26c8ee883c3eAb3AAaaD56885",
  facilitator: "api.testnet.blocky402.com",
  priceTinybar: "100000",
  priceHbar: "0.001",
} as const;

export const hashscanTx = (id: string) =>
  `https://hashscan.io/testnet/transaction/${encodeURIComponent(id)}`;
export const hashscanTopic = (id: string) => `https://hashscan.io/testnet/topic/${id}`;
export const etherscan = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`;
export const runUrl = (id: string) => `${DEMO_REPO}/actions/runs/${id}`;

/** The legitimate release: a deploy job asked, paid, and was served. */
export const RELEASED = {
  run: "34714849283",
  commitment: "983d552fd431c42ac86b1c0fbd908ed604ec4068c3c7d905c3a0617f070c200c",
  payTx: "0.0.7162784@1789242038.784103687",
  hcs: "13",
  treasury: "0xDD9a276d4b15A2E60C141C2CF543551A0F58b3Af",
} as const;

/** The refusal: everything stolen, the real release step run, paid for, and denied. */
export const REFUSED = {
  run: "34710270418",
  commitment: "eba93fa7c13104a39a27e1199e4edfa629b49e91ad78a3c800337fc70b8a8e97",
  payTx: "0.0.7162784@1789236489.310651251",
  hcs: "6",
  check: 4,
  reason: "requested by a job with no environment",
} as const;

/** The baseline: an ordinary pipeline, an ordinary secret, gone in seconds. */
export const STOLEN = {
  run: "34713176144",
  varsRead: 147,
  interesting: 1,
  treasury: "0xa3Ddb8470b184042c17E9858d1b406D908Fa2812",
  owner: "0x0CD00642a211f0841c4bB572BFACA1Ced3fAc36C",
} as const;

export const PROTECTED_OWNER = "0x2014025433307dfBDeb2dBf45E74C5cAA7A8D6cB";

/** What one release actually costs the witness, measured off the mirror node. */
export const COST = {
  revenue: 100_000,
  submits: 3_072_929,
  recordQuery: 133_908,
  get total() {
    return this.submits + this.recordQuery;
  },
  get ratio() {
    return Math.round(this.total / this.revenue);
  },
} as const;

export const short = (s: string, head = 10, tail = 6) =>
  s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
