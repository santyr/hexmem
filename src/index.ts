import { dispatchRuntimeMode, resolveRuntimeMode } from "./runtime.js";
import { startHttpServer } from "./http.js";
import { startStdioServer } from "./stdio.js";

const mode = resolveRuntimeMode(process.argv.slice(2));
await dispatchRuntimeMode(mode, { startHttpServer, startStdioServer });
