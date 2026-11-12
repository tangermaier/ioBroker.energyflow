// Copies the built vis-2 widget bundle (src-widgets/build) into widgets/solarcockpit/, the
// location referenced by io-package.json's common.visWidgets.solarcockpitWidgets.url.
const fs = require("node:fs");
const path = require("node:path");

const src = path.join(__dirname, "..", "src-widgets", "build");
const dest = path.join(__dirname, "..", "widgets", "solarcockpit");

if (!fs.existsSync(src)) {
	console.error(`Widget build output not found at ${src} - run "npm run build:widgets" from src-widgets first`);
	process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });

console.log(`Copied widget build from ${src} to ${dest}`);
