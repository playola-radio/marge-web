import { assert } from "chai";
import { getSequelize } from "./index.js";

it("returns null when DATABASE_URL is unset (relay boots without a DB)", () => {
  delete process.env.DATABASE_URL;
  assert.isNull(getSequelize());
});
