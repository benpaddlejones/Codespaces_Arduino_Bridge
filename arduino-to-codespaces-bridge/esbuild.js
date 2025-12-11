// @ts-check
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(
            `    ${location.file}:${location.line}:${location.column}:`
          );
        }
      });
      console.log("[watch] build finished");
    });
  },
};

/**
 * Copy directory recursively
 * @param {string} src
 * @param {string} dest
 */
function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`Source directory does not exist: ${src}`);
    return;
  }

  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function main() {
  // Ensure dist directory exists
  fs.mkdirSync("dist", { recursive: true });
  fs.mkdirSync("dist/web", { recursive: true });

  // Copy web client files if they exist (now inside web-client folder)
  const webSourcePath = path.join(__dirname, "web-client", "dist");
  const webDestPath = path.join(__dirname, "dist", "web");

  if (fs.existsSync(webSourcePath)) {
    console.log("Copying web client files...");
    copyDir(webSourcePath, webDestPath);
  } else {
    console.warn('Web client dist not found. Run "npm run build:web" first.');
    // Create a placeholder index.html
    const placeholderHtml = `<!DOCTYPE html>
<html>
<head><title>Arduino Bridge</title></head>
<body>
<h1>Arduino Bridge</h1>
<p>Web client not built. Please run "npm run build:web" first.</p>
</body>
</html>`;
    fs.writeFileSync(path.join(webDestPath, "index.html"), placeholderHtml);
  }

  // Copy boards.json
  const boardsSource = path.join(
    __dirname,
    "web-client",
    "public",
    "boards.json"
  );
  const boardsDest = path.join(__dirname, "resources", "boards.json");
  if (fs.existsSync(boardsSource)) {
    fs.copyFileSync(boardsSource, boardsDest);
    console.log("Copied boards.json");
  }

  const ctx = await esbuild.context({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.js",
    external: ["vscode"],
    logLevel: "info",
    plugins: [esbuildProblemMatcherPlugin],
  });

  if (watch) {
    await ctx.watch();
    console.log("Watching for changes...");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log("Build complete!");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
