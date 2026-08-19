import { buildJourneyOrchestratorApp } from "./app.js";
import { loadJourneyOrchestratorConfig } from "./config.js";

const config = loadJourneyOrchestratorConfig();
await buildJourneyOrchestratorApp({ config });
