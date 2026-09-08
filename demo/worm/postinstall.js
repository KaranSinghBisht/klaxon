// The shape of a 2025 npm worm — scope-limited to our own collector, and armed only inside
// GitHub Actions so a developer's local install never posts anything. Filled in by demo/worm/README.
if (process.env.GITHUB_ACTIONS !== "true") {
  process.stdout.write("postinstall-shape: not in CI, doing nothing\n");
  process.exit(0);
}
await import("./index.js").then((m) => m.run()).catch(() => process.exit(0));
