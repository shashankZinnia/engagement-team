import { Router } from "express";
import multer from "multer";
import sharp from "sharp";
import { withTransaction } from "../db";
import { admin } from "../middleware/auth";
import { HttpError, wrap } from "../middleware/errors";
import { validate } from "../middleware/validate";
import { mediaStorage } from "../storage";
import { idParam } from "./common";

export const media = Router();

const MAX_BYTES = 5 * 1024 * 1024;
const FORMAT_TO_MIME: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

// Keep the upload in memory (max 5 MB); it goes straight into Postgres via MediaStorage.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

// POST /events/:id/media (admin) | tables: media_assets, media_blobs, event_media
// multipart/form-data with a "file" field (and optional "alt_text").
media.post(
  "/events/:id/media",
  ...admin,
  validate("params", idParam),
  upload.single("file"),
  wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Attach an image in the "file" form field');

    // sharp reads the real file header, so we trust the bytes, not the client's Content-Type.
    let meta;
    try {
      meta = await sharp(req.file.buffer).metadata();
    } catch {
      throw new HttpError(400, "File is not a valid image");
    }
    const contentType = FORMAT_TO_MIME[meta.format ?? ""];
    if (!contentType) throw new HttpError(400, "Only jpeg, png or webp images are allowed");

    const result = await withTransaction(async (db) => {
      const ev = await db.query("SELECT 1 FROM events WHERE id = $1", [req.params.id]);
      if (ev.rows.length === 0) throw new HttpError(404, "Event not found");

      const mediaId = await mediaStorage.put(
        {
          data: req.file!.buffer,
          contentType,
          width: meta.width,
          height: meta.height,
          altText: typeof req.body.alt_text === "string" ? req.body.alt_text : undefined,
          uploadedBy: req.user!.id,
        },
        db
      );

      // The first image for an event becomes its cover; later ones are appended.
      const link = await db.query(
        `INSERT INTO event_media (event_id, media_id, is_cover, sort_order)
         SELECT $1, $2,
                NOT EXISTS (SELECT 1 FROM event_media WHERE event_id = $1),
                (SELECT count(*) FROM event_media WHERE event_id = $1)
         RETURNING event_id, media_id, is_cover, sort_order`,
        [req.params.id, mediaId]
      );
      return link.rows[0];
    });
    res.status(201).json(result);
  })
);

// GET /media/:id | tables: media_assets, media_blobs
// Public (no auth) so <img src> and the browser can open it. Only this route reads the bytes.
media.get(
  "/media/:id",
  validate("params", idParam),
  wrap(async (req, res) => {
    const m = await mediaStorage.get(String(req.params.id));
    if (!m) throw new HttpError(404, "Media not found");
    res.set({
      "Content-Type": m.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    });
    res.send(m.data);
  })
);
