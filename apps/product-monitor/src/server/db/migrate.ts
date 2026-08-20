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
  sale_status TEXT NOT NULL DEFAULT 'available',
  sale_status_message_id TEXT,
  sale_status_text TEXT,
  sale_status_updated_at INTEGER,
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
  source_url TEXT,
  sequence INTEGER NOT NULL,
  local_path TEXT,
  checksum TEXT,
  download_status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS product_media_product_sequence_unique
ON product_media(product_id, sequence);
CREATE UNIQUE INDEX IF NOT EXISTS product_media_downloaded_checksum_unique
ON product_media(product_id, checksum)
WHERE download_status = 'downloaded' AND checksum IS NOT NULL;
CREATE TABLE IF NOT EXISTS product_reactions (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  target_message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  icon TEXT NOT NULL,
  active INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(product_id, target_message_id, user_id)
);
CREATE TABLE IF NOT EXISTS product_message_links (
  message_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orphan_media (
  message_id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  source_url TEXT,
  sent_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orphan_media_sent_at ON orphan_media(sent_at);
CREATE INDEX IF NOT EXISTS product_message_links_product
ON product_message_links(product_id);
CREATE TABLE IF NOT EXISTS product_sale_events (
  message_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  target_message_id TEXT NOT NULL,
  status TEXT NOT NULL,
  raw_content TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
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
    database.transaction(() => {
        database.exec(schema);
        const mediaColumns = database.prepare("PRAGMA table_info(product_media)").all() as Array<{ name: string }>;
        if (!mediaColumns.some((column) => column.name === "source_url")) {
            database.exec("ALTER TABLE product_media ADD COLUMN source_url TEXT");
        }
        const productColumns = database.prepare("PRAGMA table_info(products)").all() as Array<{ name: string }>;
        const additions = [
            ["sale_status", "TEXT NOT NULL DEFAULT 'available'"],
            ["sale_status_message_id", "TEXT"],
            ["sale_status_text", "TEXT"],
            ["sale_status_updated_at", "INTEGER"],
        ] as const;
        for (const [name, definition] of additions) {
            if (!productColumns.some((column) => column.name === name)) {
                database.exec(`ALTER TABLE products ADD COLUMN ${name} ${definition}`);
            }
        }
        database.exec(`
            UPDATE products
            SET sale_status = 'closed'
            WHERE sale_status IN ('reserved', 'partially_sold', 'sold');
            UPDATE product_sale_events
            SET status = 'closed'
            WHERE status IN ('reserved', 'partially_sold', 'sold');
        `);
    })();
};
