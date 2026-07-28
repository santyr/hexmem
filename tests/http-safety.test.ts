import assert from "node:assert/strict";
import test from "node:test";

import { startHttpServer } from "../src/http.js";

test("hexmem refuses unauthenticated non-loopback HTTP binding", async () => {
  await assert.rejects(
    startHttpServer({
      host: "0.0.0.0",
      port: 0,
      dbPath: "/tmp/not-opened.db",
    }),
    /non-loopback.*authentication/i,
  );
});
