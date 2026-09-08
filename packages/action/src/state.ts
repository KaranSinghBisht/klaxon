/**
 * Keys shared between `dist/index.js` and `dist/post.js`. Both hold public, on-the-record values —
 * the released plaintext is deliberately never written here. Runner masks are job-wide already, so
 * persisting the secret to buy a re-mask in the post step would be pure exposure.
 */
export const STATE_COMMITMENT = "klaxon_commitment";
export const STATE_PAY_TX = "klaxon_pay_tx";
