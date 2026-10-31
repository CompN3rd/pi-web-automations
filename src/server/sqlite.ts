import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** Small synchronous store boundary; SQLite files and schema stay unchanged. */
export class RuntimeDatabase {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
  }

  get open(): boolean { return this.database.isOpen; }

  close(): void { this.database.close(); }

  exec(sql: string): void { this.database.exec(sql); }

  prepare<Bindings extends SQLInputValue[] = SQLInputValue[], Row = Record<string, unknown>>(sql: string) {
    const statement = this.database.prepare(sql);
    return {
      // Like the previous driver's typed prepare(), row shapes come from the
      // store's fixed SQL/schema. node:sqlite has no generic row API. Confine
      // these assertions to this adapter; stored JSON is still parsed by store.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      all: (...bindings: Bindings): Row[] => statement.all(...bindings) as Row[],
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      get: (...bindings: Bindings): Row | undefined => statement.get(...bindings) as Row | undefined,
      run: (...bindings: Bindings) => statement.run(...bindings),
    };
  }

  transaction<T>(operation: () => T): () => T {
    return () => {
      // Acquire the write lock before read/check/write sequences so another
      // connection cannot invalidate revision, overlap or occurrence checks.
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    };
  }
}
