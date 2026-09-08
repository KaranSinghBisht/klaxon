/**
 * Keys shared between `dist/index.js` and `dist/post.js`. The runner exposes saved state to this
 * action's own post step as `STATE_<name>` and to nothing else, so it is not the job-wide
 * environment exposure that `GITHUB_ENV` would be (B §1.4).
 */
export const STATE_COMMITMENT = "klaxon_commitment";
export const STATE_VALUE = "klaxon_value";
