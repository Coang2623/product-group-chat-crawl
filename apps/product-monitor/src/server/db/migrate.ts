import type Database from "better-sqlite3";

const schema = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  description_message_id TEXT NOT NULL UNIQUE,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  posted_at INTEGER NOT NULL,
  raw_content TEXT NOT NULL,
  product_name TEXT,
  brand TEXT,
  model TEXT,
  cpu TEXT,
  ram TEXT,
  storage TEXT,
  gpu TEXT,
  display TEXT,
  condition_text TEXT,
  price INTEGER,
  raw_price TEXT,
  notes TEXT,
  image_count INTEGER NOT NULL DEFAULT 0,
  cover_image_path TEXT,
  media_directory TEXT NOT NULL,
  heart_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  excel_sync_status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_receiving_product
ON products(status) WHERE status = 'receiving_images';
CREATE TABLE IF NOT EXISTS product_media (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL,
  local_path TEXT,
  checksum TEXT,
  download_status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS product_reactions (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  target_message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  icon TEXT NOT NULL,
  active INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(product_id, target_message_id, user_id)
);
CREATE TABLE IF NOT EXISTS excel_sync_jobs (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
`;

/** Enables SQLite guarantees and creates the durable product-monitor schema. */
export const migrate = (database: Database.Database): void => {
    database.pragma("foreign_keys = ON");
    database.transaction(() => database.exec(schema))();
};
