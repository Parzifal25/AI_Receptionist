import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Bundles the embeddable widget to public/widget.js. Runs before `next build`
 * so the widget ships with every deployment. IIFE + es2019 keeps it
 * compatible with effectively every browser that has Web Speech support.
 */
await build({
  entryPoints: [path.join(root, "widget/src/index.ts")],
  outfile: path.join(root, "public/widget.js"),
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2019",
  alias: { "@": path.join(root, "src") },
  banner: { js: "/* AI Receptionist widget — https://github.com/your-org/ai-receptionist */" },
  logLevel: "info",
});
