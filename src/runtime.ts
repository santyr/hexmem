export function resolveRuntimeMode(argv: string[]): "http" | "stdio" {
  return argv.includes("--stdio") ? "stdio" : "http";
}

export async function dispatchRuntimeMode(
  mode: "http" | "stdio",
  handlers: {
    startHttpServer: () => Promise<unknown>;
    startStdioServer: () => Promise<unknown>;
  },
): Promise<unknown> {
  if (mode === "stdio") {
    return handlers.startStdioServer();
  }
  return handlers.startHttpServer();
}

export async function runRuntime(
  argv: string[],
  handlers: {
    startHttpServer: () => Promise<unknown>;
    startStdioServer: () => Promise<unknown>;
  },
): Promise<unknown> {
  return dispatchRuntimeMode(resolveRuntimeMode(argv), handlers);
}
