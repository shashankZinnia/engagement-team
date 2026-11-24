import { Router } from "express";
import { z } from "zod";
import { pool } from "../db";
import { requireUser } from "../middleware/auth";
import { HttpError, wrap } from "../middleware/errors";
import { validate } from "../middleware/validate";
import { idParam } from "./common";

export const swipes = Router();

// GET /events/feed | tables: events, event_swipes, partners, event_media
// LEFT JOIN + "s.event_id IS NULL" keeps only events this user has NOT swiped on.
swipes.get(
  "/events/feed",
  requireUser,
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT e.id, e.title, e.description, e.starts_at, e.waitlist_fee, e.currency,
              p.name AS partner_name, p.city AS partner_city,
              em.media_id AS cover_media_id
       FROM events e
       LEFT JOIN event_swipes s  ON s.event_id = e.id AND s.user_id = $1
       LEFT JOIN partners p      ON p.id = e.partner_id
       LEFT JOIN event_media em  ON em.event_id = e.id AND em.is_cover
       WHERE e.status = 'published' AND e.starts_at > now() AND s.event_id IS NULL
       ORDER BY e.starts_at`,
      [req.user!.id]
    );
    res.json(rows);
  })
);

const topQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(10) });

// GET /events/top?limit=10 | tables: events, event_stats
swipes.get(
  "/events/top",
  validate("query", topQuery),
  wrap(async (req, res) => {
    const { limit } = req.query as unknown as z.infer<typeof topQuery>;
    const { rows } = await pool.query(
      `SELECT e.id, e.title, e.starts_at,
              s.interest_count, s.waitlist_count, s.rank_score::float8 AS rank_score
       FROM events e
       JOIN event_stats s ON s.event_id = e.id
       WHERE e.status = 'published'
       ORDER BY s.rank_score DESC, e.starts_at
       LIMIT $1`,
      [limit]
    );
    res.json(rows);
  })
);

const swipeBody = z.object({ direction: z.enum(["left", "right"]) });

// PUT /events/:id/swipe | tables: events, event_swipes (event_stats is updated by a DB trigger)
swipes.put(
  "/events/:id/swipe",
  requireUser,
  validate("params", idParam),
  validate("body", swipeBody),
  wrap(async (req, res) => {
    const ev = await pool.query("SELECT 1 FROM events WHERE id = $1 AND status = 'published'", [req.params.id]);
    if (ev.rows.length === 0) throw new HttpError(404, "Event not found");

    const { rows } = await pool.query(
      `INSERT INTO event_swipes (user_id, event_id, direction) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, event_id) DO UPDATE SET direction = EXCLUDED.direction
       RETURNING user_id, event_id, direction, updated_at`,
      [req.user!.id, req.params.id, req.body.direction]
    );
    res.json(rows[0]);
  })
);
