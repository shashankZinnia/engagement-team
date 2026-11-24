import { Pool, PoolClient } from "pg";
import { pool } from "../db";

export interface PutInput {
  data: Buffer;
  contentType: string;
  width?: number;
  height?: number;
  altText?: string;
  uploadedBy?: string;
}

export interface StoredMedia {
  contentType: string;
  data: Buffer;
}

// Swap PostgresStorage for an S3Storage later; routes only talk to this interface.
// `db` lets the caller put() inside its own transaction.
export interface MediaStorage {
  put(input: PutInput, db?: Pool | PoolClient): Promise<string>; // returns media_assets.id
  get(id: string): Promise<StoredMedia | null>;
}

// tables: media_assets (metadata), media_blobs (bytes)
export class PostgresStorage implements MediaStorage {
  async put(input: PutInput, db: Pool | PoolClient = pool): Promise<string> {
    const asset = await db.query(
      `INSERT INTO media_assets (storage, content_type, size_bytes, width, height, alt_text, uploaded_by)
       VALUES ('db', $1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.contentType, input.data.length, input.width ?? null, input.height ?? null,
       input.altText ?? null, input.uploadedBy ?? null]
    );
    const id: string = asset.rows[0].id;
    await db.query("INSERT INTO media_blobs (media_id, data) VALUES ($1, $2)", [id, input.data]);
    return id;
  }

  async get(id: string): Promise<StoredMedia | null> {
    const { rows } = await pool.query(
      `SELECT a.content_type, b.data
       FROM media_assets a
       JOIN media_blobs b ON b.media_id = a.id
       WHERE a.id = $1`,
      [id]
    );
    if (rows.length === 0) return null;
    return { contentType: rows[0].content_type, data: rows[0].data };
  }
}

// TODO S3: return an S3Storage here once media_assets.storage = 's3' is in use.
export const mediaStorage: MediaStorage = new PostgresStorage();
