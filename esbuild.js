const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    outfile: "dist/extension.js",
    
    // ─── ADD THESE CONSTRAINTS FOR NODE RUNTIMES ───
    platform: "node",        // Prevents esbuild from assuming web browser defaults
    format: "cjs",          // VS Code extensions load via CommonJS modules
    target: "node18",       // Match the target Node environment of your VS Code runtime
    
    // Mark backend system engines as external so esbuild leaves them unbundled
    external: [
      "vscode", 
      "@devicefarmer/adbkit", 
      "adbkit", 
      "ws"
    ],
    // ───────────────────────────────────────────────

    logLevel: "silent",
    plugins: [
      /* any default vs-code scaffolding plugins here */
    ],
  });

  if (watch) {
    await ctx.watch();
    console.log("[watch] build started & watching files...");
	console.log("[watch] build finished");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
