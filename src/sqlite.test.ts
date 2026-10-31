import { describe, expect, it } from "vitest";
import { RuntimeDatabase } from "./server/sqlite.js";

describe("runtime SQLite boundary", () => {
  it("rolls back all writes after failure and remains usable", () => {
    const db = new RuntimeDatabase(":memory:");
    try {
      db.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY) STRICT");
      expect(() => {
        db.transaction(() => {
          db.prepare("INSERT INTO entries VALUES (?)").run(1);
          db.prepare("INSERT INTO entries VALUES (?)").run(1);
        })();
      }).toThrow("UNIQUE constraint failed");
      expect(db.prepare("SELECT * FROM entries").all()).toEqual([]);
      expect(db.transaction(() => db.prepare("INSERT INTO entries VALUES (?)").run(2))().changes).toBe(1);
      expect(db.prepare("SELECT * FROM entries").all()).toEqual([{ id: 2 }]);
    } finally {
      db.close();
    }
    expect(db.open).toBe(false);
  });
});
