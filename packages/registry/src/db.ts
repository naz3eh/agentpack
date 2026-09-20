import Database from "better-sqlite3";
import crypto from "node:crypto";

export interface PublisherRow {
  id: number;
  name: string;
  token_hash: string;
}

export interface VersionRow {
  name: string;
  version: string;
  manifest: string;
  sha256: string;
  size: number;
  created_at: string;
}

export interface PackageRow {
  name: string;
  publisher_id: number;
  description: string;
  latest: string;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function mintToken(): string {
  return "ap_" + crypto.randomBytes(24).toString("hex");
}

export class RegistryDb {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS publishers(
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS packages(
        name TEXT PRIMARY KEY,
        publisher_id INTEGER NOT NULL REFERENCES publishers(id),
        description TEXT NOT NULL,
        latest TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions(
        name TEXT NOT NULL REFERENCES packages(name),
        version TEXT NOT NULL,
        manifest TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(name, version)
      );
    `);
  }

  createPublisher(name: string): { name: string; token: string } {
    const token = mintToken();
    this.db
      .prepare("INSERT INTO publishers(name, token_hash) VALUES (?, ?)")
      .run(name, hashToken(token));
    return { name, token };
  }

  publisherForToken(token: string): PublisherRow | undefined {
    return this.db
      .prepare("SELECT * FROM publishers WHERE token_hash = ?")
      .get(hashToken(token)) as PublisherRow | undefined;
  }

  getPackage(name: string): PackageRow | undefined {
    return this.db
      .prepare("SELECT * FROM packages WHERE name = ?")
      .get(name) as PackageRow | undefined;
  }

  listPackages(): (PackageRow & { versions: number })[] {
    return this.db
      .prepare(
        `SELECT p.*, COUNT(v.version) AS versions
         FROM packages p LEFT JOIN versions v ON v.name = p.name
         GROUP BY p.name ORDER BY p.name`,
      )
      .all() as (PackageRow & { versions: number })[];
  }

  searchPackages(q: string): (PackageRow & { versions: number })[] {
    const needle = `%${q.toLowerCase()}%`;
    return this.db
      .prepare(
        `SELECT p.*, COUNT(v.version) AS versions
         FROM packages p LEFT JOIN versions v ON v.name = p.name
         WHERE lower(p.name) LIKE ? OR lower(p.description) LIKE ?
         GROUP BY p.name ORDER BY p.name`,
      )
      .all(needle, needle) as (PackageRow & { versions: number })[];
  }

  getVersion(name: string, version: string): VersionRow | undefined {
    return this.db
      .prepare("SELECT * FROM versions WHERE name = ? AND version = ?")
      .get(name, version) as VersionRow | undefined;
  }

  listVersions(name: string): VersionRow[] {
    return this.db
      .prepare("SELECT * FROM versions WHERE name = ? ORDER BY created_at, version")
      .all(name) as VersionRow[];
  }

  insertPackage(name: string, publisherId: number, description: string, latest: string): void {
    this.db
      .prepare("INSERT INTO packages(name, publisher_id, description, latest) VALUES (?, ?, ?, ?)")
      .run(name, publisherId, description, latest);
  }

  updatePackage(name: string, description: string, latest: string): void {
    this.db
      .prepare("UPDATE packages SET description = ?, latest = ? WHERE name = ?")
      .run(description, latest, name);
  }

  insertVersion(name: string, version: string, manifest: string, sha256: string, size: number): void {
    this.db
      .prepare("INSERT INTO versions(name, version, manifest, sha256, size) VALUES (?, ?, ?, ?, ?)")
      .run(name, version, manifest, sha256, size);
  }

  close(): void {
    this.db.close();
  }
}
