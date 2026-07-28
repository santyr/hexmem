import assert from "node:assert/strict";
import test from "node:test";

import { inferDomainsFromCwd } from "../src/tools/gateway.js";

test("CWD domain inference ships with no provider-specific defaults", () => {
  const prior = process.env.HEXMEM_CWD_DOMAIN_MAP;
  try {
    delete process.env.HEXMEM_CWD_DOMAIN_MAP;
    assert.deepEqual(inferDomainsFromCwd("/workspace/example/ProjectAlpha"), []);

    process.env.HEXMEM_CWD_DOMAIN_MAP = JSON.stringify({
      projectalpha: ["project", "technical"],
    });
    assert.deepEqual(
      inferDomainsFromCwd("/workspace/example/ProjectAlpha"),
      ["project", "technical"],
    );

    process.env.HEXMEM_CWD_DOMAIN_MAP = "{not-json";
    assert.deepEqual(inferDomainsFromCwd("/workspace/example/ProjectAlpha"), []);
  } finally {
    if (prior === undefined) delete process.env.HEXMEM_CWD_DOMAIN_MAP;
    else process.env.HEXMEM_CWD_DOMAIN_MAP = prior;
  }
});
