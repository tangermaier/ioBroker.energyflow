// Copies the 3D scene build (src-scene/build) into www/, which web.0 serves as /energyflow/.
import { cpSync, rmSync } from "node:fs";

rmSync("www", { recursive: true, force: true });
cpSync("src-scene/build", "www", { recursive: true });
console.log("Copied scene build to www/");
