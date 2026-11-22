import { assert } from "chai";
import { newToken, isValidToken } from "./index.js";

describe("ids", () => {
  it("generates unguessable base64url tokens", () => {
    const a = newToken();
    const b = newToken();
    assert.notStrictEqual(a, b);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/); // 32 bytes -> 43 base64url chars
  });

  it("validates good tokens and rejects bad input", () => {
    assert.isTrue(isValidToken(newToken()));
    assert.isFalse(isValidToken("short"));
    assert.isFalse(isValidToken("has spaces and !"));
    assert.isFalse(isValidToken(123));
    assert.isFalse(isValidToken(undefined));
  });
});
