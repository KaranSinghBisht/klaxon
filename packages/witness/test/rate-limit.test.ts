import { describe, expect, it } from "vitest";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";

describe("FixedWindowLimiter", () => {
  it("allows up to the limit, then refuses with a retry-after", () => {
    const t = 0;
    const rl = new FixedWindowLimiter({ limit: 3, windowMs: 60_000, now: () => t });

    expect(rl.take("a").allowed).toBe(true);
    expect(rl.take("a").allowed).toBe(true);
    expect(rl.take("a").allowed).toBe(true);

    const refused = rl.take("a");
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterS).toBe(60);
  });

  it("counts each caller separately", () => {
    const t = 0;
    const rl = new FixedWindowLimiter({ limit: 1, windowMs: 1_000, now: () => t });
    expect(rl.take("a").allowed).toBe(true);
    expect(rl.take("b").allowed).toBe(true);
    expect(rl.take("a").allowed).toBe(false);
  });

  it("lets the window roll over", () => {
    let t = 0;
    const rl = new FixedWindowLimiter({ limit: 1, windowMs: 1_000, now: () => t });
    expect(rl.take("a").allowed).toBe(true);
    expect(rl.take("a").allowed).toBe(false);
    t = 1_001;
    expect(rl.take("a").allowed).toBe(true);
  });

  it("drops expired windows instead of growing forever", () => {
    let t = 0;
    const rl = new FixedWindowLimiter({ limit: 1, windowMs: 10, now: () => t });
    for (let i = 0; i < 10_050; i++) {
      rl.take(`ip-${i}`);
      t += 1;
    }
    // Every window above is long expired; the sweep must have collected them.
    const held = (rl as unknown as { hits: Map<string, unknown> }).hits.size;
    expect(held).toBeLessThan(10_000);
  });
});
