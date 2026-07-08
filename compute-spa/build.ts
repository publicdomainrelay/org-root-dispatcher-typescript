const DIST = import.meta.dirname + "/dist";

try { await Deno.mkdir(DIST, { recursive: true }); } catch { /* exists */ }

const bundleCmd = new Deno.Command("deno", {
  args: [
    "bundle", "--platform", "browser", "--minify",
    "--sourcemap=external", "--outdir", DIST,
    "components/compute-app.js",
  ],
  stdout: "inherit", stderr: "inherit",
});
const bundleStatus = await bundleCmd.output();
if (!bundleStatus.success) Deno.exit(bundleStatus.code);

for (const f of ["styles.css", "oauth-client-metadata.json"]) {
  await Deno.copyFile(`${import.meta.dirname}/${f}`, `${DIST}/${f}`);
}

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="origin-when-cross-origin">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Request compute VMs, view saved VMs, and access terminals via the publicdomainrelay market.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="./styles.css">
  <title>Compute — publicdomainrelay</title>
</head>
<body>
  <compute-app></compute-app>
  <script type="module" src="./compute-app.js?v=${Date.now()}"></script>
</body>
</html>
`;
await Deno.writeTextFile(`${DIST}/index.html`, html);

console.log("Build complete → dist/");
