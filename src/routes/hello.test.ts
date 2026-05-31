import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleHello } from "./hello.js";

describe("handleHello", () => {
  it("returns a HelloResponse object", () => {
    const result = handleHello();
    assert.ok(typeof result === "object" && result !== null);
    assert.equal(typeof result.message, "string");
  });

  it('returns message "Hello, World!"', () => {
    const result = handleHello();
    assert.equal(result.message, "Hello, World!");
  });
});
