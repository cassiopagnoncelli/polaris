import { buildArchiverApp } from "./app.js";
import { loadArchiverConfig } from "./config.js";

const config = loadArchiverConfig();
await buildArchiverApp({ config });
