/**
 * Internal DB surface for the CLI. Re-exported through a small index so the
 * command layer never reaches into `./db/*` directly.
 */
export { type ConnectDbOptions, type DbHandle, connectDb } from "./connect.js";
export {
  fetchAllProjects,
  fetchAllSources,
  fetchSourcesById,
  fetchSourcesByProject,
  insertProject,
  insertSource,
  updateProject,
  updateSource,
} from "./projects.js";
