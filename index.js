// opencode-tab-status — package entry (re-exports the OpenCode plugin entry).
// OpenCode loads plugins/opencode-tab-status.js; this file exists so the
// package also has a conventional main/exports entry.
export { StatusTab } from "./plugins/opencode-tab-status.js";
export { createStatus, resolveOptions } from "./src/status.js";
