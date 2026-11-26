import { expect, test } from "bun:test";
import { ConfigError, readRuntimeChoice } from "../src/runtime/select.ts";
import { parseRef } from "../src/runtime/types.ts";

const ID = "01a1f6ab-7887-758f-95b1-7bff93e12f0e";

test("a bare UUID is no ref, and omo-host is never the runtime the lead opens on", () => {
  expect(parseRef(ID)).toBeUndefined();
  expect(() =>
    readRuntimeChoice({ env: { DORI_RUNTIME: "omo-host" }, configPath: "/nonexistent/config.json" }),
  ).toThrow(ConfigError);
});
