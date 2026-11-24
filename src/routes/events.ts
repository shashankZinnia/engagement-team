import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { admin } from "../middleware/auth";
import { HttpError, wrap } from "../middleware/errors";
import { validate } from "../middleware/validate";
import { idParam } from "./common";

export const events = Router();

const createEvent = z.object({
  partner_id: z.string().uuid().optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }).optional(),
  capacity: z.number().int().positive().optional(),
  waitlist_fee: z.number().min(0).default(0),
  currency: z.string().length(3).default("INR"),
  needs_host: z.boolean().default(false),
});

// POST /events (admin) | tables: events, event_stats (stats row is created by a DB trigger)
events.post(
  "/events",
  ...admin,
  validate("body", createEvent),
  wrap(async (req, res) => {
    const b = req.body;
    const { rows } = await pool.query(
      `INSERT INTO events (partner_id, title, description, starts_at, ends_at, capacity,
                           waitlist_fee, currency, needs_host, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10) RETURNING *`,
      [b.partner_id ?? null, b.title, b.description ?? null, b.starts_at, b.ends_at ?? null,
       b.capacity ?? null, b.waitlist_fee, b.currency.toUpperCase(), b.needs_host, req.user!.id]
    );
    res.status(201).json(rows[0]);
  })
);

// PATCH /events/:id/publish (admin) | tables: events
events.patch(
  "/events/:id/publish",
  ...admin,
  validate("params", idParam),
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE events SET status = 'published' WHERE id = $1 AND status = 'draft' RETURNING *`,
      [req.params.id]
    );
    if (rows.length > 0) return res.json(rows[0]);
    const exists = await pool.query("SELECT status FROM events WHERE id = $1", [req.params.id]);
    if (exists.rows.length === 0) throw new HttpError(404, "Event not found");
    throw new HttpError(409, `Event is already ${exists.rows[0].status}`);
  })
);

// GET /events | tables: events, partners, event_media, event_stats
// Only the cover media ID is returned. Bytes are fetched separately from GET /media/:id.
events.get(
  "/events",
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT e.id, e.title, e.description, e.starts_at, e.ends_at, e.capacity,
              e.waitlist_fee, e.currency, e.needs_host, e.status,
              p.name AS partner_name, p.city AS partner_city,
              em.media_id AS cover_media_id,
              s.interest_count, s.waitlist_count, s.host_applicant_count, s.rank_score::float8 AS rank_score
       FROM events e
       LEFT JOIN partners p      ON p.id = e.partner_id
       LEFT JOIN event_media em  ON em.event_id = e.id AND em.is_cover
       LEFT JOIN event_stats s   ON s.event_id = e.id
       WHERE e.status = 'published'
       ORDER BY e.starts_at`
    );
    res.json(rows);
  })
);

// GET /events/:id | tables: events, partners, event_media, event_hosts, users, user_profiles, event_stats
events.get(
  "/events/:id",
  validate("params", idParam),
  wrap(async (req, res) => {
    const id = req.params.id;
    const ev = await pool.query(
      `SELECT e.*, row_to_json(p) AS partner, row_to_json(s) AS stats
       FROM events e
       LEFT JOIN partners p    ON p.id = e.partner_id
       LEFT JOIN event_stats s ON s.event_id = e.id
       WHERE e.id = $1`,
      [id]
    );
    if (ev.rows.length === 0) throw new HttpError(404, "Event not found");

    const media = await pool.query(
      `SELECT media_id, is_cover, sort_order FROM event_media WHERE event_id = $1 ORDER BY sort_order`,
      [id]
    );
    const hosts = await pool.query(
      `SELECT u.id AS user_id, pr.full_name, pr.bio, pr.instagram_handle, h.assigned_at
       FROM event_hosts h
       JOIN users u          ON u.id = h.user_id
       JOIN user_profiles pr ON pr.user_id = u.id
       WHERE h.event_id = $1
       ORDER BY h.assigned_at`,
      [id]
    );
    res.json({ ...ev.rows[0], media: media.rows, hosts: hosts.rows });
  })
);
