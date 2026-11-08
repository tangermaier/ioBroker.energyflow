const path = require("path");
const { tests } = require("@iobroker/testing");

// Run tests to validate that io-package.json and package.json are consistent
// and that all required adapter metadata is present.
tests.packageFiles(path.join(__dirname, ".."));
