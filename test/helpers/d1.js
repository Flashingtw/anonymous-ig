import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

class D1PreparedStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  first(columnName) {
    const row = this.database.prepare(this.sql).get(...this.values);
    if (columnName !== undefined) {
      return row?.[columnName] ?? null;
    }
    return row ?? null;
  }

  all() {
    return {
      success: true,
      results: this.database.prepare(this.sql).all(...this.values),
      meta: {}
    };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid)
      }
    };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new D1PreparedStatement(this.database, sql);
  }

  batch(statements) {
    const results = [];
    this.database.exec("BEGIN IMMEDIATE;");

    try {
      for (const statement of statements) {
        const rows = this.database
          .prepare(statement.sql)
          .all(...statement.values);
        const changes = this.database
          .prepare("SELECT changes() AS changes")
          .get().changes;
        results.push({
          success: true,
          results: rows,
          meta: { changes: Number(changes) }
        });
      }
      this.database.exec("COMMIT;");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }
}

export function createTestDatabase({ access = true, team = true, images = false } = {}) {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");

  for (const migration of [
    "../../migrations/0001_create_submissions.sql",
    "../../migrations/0002_create_admin_auth.sql",
    "../../migrations/0004_add_local_admin_auth.sql"
  ]) {
    database.exec(readFileSync(new URL(migration, import.meta.url), "utf8"));
  }

  if (access) {
    database.exec(readFileSync(new URL("../../migrations/0005_add_access_email.sql", import.meta.url), "utf8"));
    if (team) database.exec(readFileSync(new URL("../../migrations/0006_access_only_admins.sql", import.meta.url), "utf8"));
  }

  if (images) database.exec(readFileSync(new URL("../../migrations/0007_image_drafts.sql", import.meta.url), "utf8"));
  return {
    DB: new TestD1Database(database),
    raw: database,
    close() {
      database.close();
    }
  };
}
