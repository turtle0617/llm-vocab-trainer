import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./pagination.js";

describe("pagination cursor", () => {
  it("round trips cards cursor state", () => {
    const cursor = {
      due: "2026-05-09T00:00:00.000Z",
      createdAt: "2026-05-08T00:00:00.000Z",
      cardId: "abc123"
    };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it("rejects invalid cursors", () => {
    expect(() => decodeCursor(Buffer.from("{}").toString("base64url"))).toThrow();
  });
});
