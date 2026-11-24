import { Router } from "express";
import { z } from "zod";
import { pool, withTransaction } from "../db";
import { admin, requireUser } from "../middleware/auth";
import { HttpError, wrap } from "../middleware/errors";
import { validate } from "../middleware/validate";
import { idParam } from "./common";

export const hosts = Router();

// GET /hosts/events | tables: events, event_stats, partners
hosts.get(
  "/hosts/events",
  wrap(async (_req, res) => {
    const { rows } = await pool.query(
      `SELECT e.id, e.title, e.description, e.starts_at, e.ends_at,
              p.name AS partner_name, p.city AS partner_city,
              s.host_applicant_count
       FROM events e
       JOIN event_stats s     ON s.event_id = e.id
       LEFT JOIN partners p   ON p.id = e.partner_id
       WHERE e.status = 'published' AND e.needs_host AND e.starts_at > now()
       ORDER BY e.starts_at`
    );
    res.json(rows);
  })
);

const apply = z.object({ pitch: z.string().min(1).optional() });

// POST /events/:id/host-applications | tables: events, host_applications
hosts.post(
  "/events/:id/host-applications",
  requireUser,
  validate("params", idParam),
  validate("body", apply),
  wrap(async (req, res) => {
    const ev = await pool.query("SELECT status, needs_host FROM events WHERE id = $1", [req.params.id]);
    if (ev.rows.length === 0) throw new HttpError(404, "Event not found");
    if (ev.rows[0].status !== "published" || !ev.rows[0].needs_host)
      throw new HttpError(409, "Event is not looking for a host");

    // A duplicate (event_id, user_id) hits the UNIQUE constraint; the error handler maps that to 409.
    const { rows } = await pool.query(
      `INSERT INTO host_applications (event_id, user_id, pitch) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, req.user!.id, req.body.pitch ?? null]
    );
    res.status(201).json(rows[0]);
  })
);

// GET /admin/events/:id/host-applications (admin)
// tables: host_applications, users, user_profiles
hosts.get(
  "/admin/events/:id/host-applications",
  ...admin,
  validate("params", idParam),
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT a.id AS application_id, a.status, a.pitch, a.created_at,
              u.id AS user_id, u.email, p.full_name, p.bio, p.city, p.instagram_handle
       FROM host_applications a
       JOIN users u          ON u.id = a.user_id
       JOIN user_profiles p  ON p.user_id = u.id
       WHERE a.event_id = $1
       ORDER BY a.created_at`,
      [req.params.id]
    );
    res.json(rows);
  })
);

const review = z.object({ status: z.enum(["approved", "rejected"]) });

// PATCH /admin/host-applications/:id (admin) | tables: host_applications, event_hosts, audit_log
hosts.patch(
  "/admin/host-applications/:id",
  ...admin,
  validate("params", idParam),
  validate("body", review),
  wrap(async (req, res) => {
    const { status } = req.body as z.infer<typeof review>;
    const updated = await withTransaction(async (db) => {
      const found = await db.query(
        "SELECT id, event_id, user_id, status FROM host_applications WHERE id = $1 FOR UPDATE",
        [req.params.id]
      );
      if (found.rows.length === 0) throw new HttpError(404, "Application not found");
      const app = found.rows[0];
      if (app.status !== "pending") throw new HttpError(409, `Application is already ${app.status}`);

      const u = await db.query(
        `UPDATE host_applications SET status = $2, reviewed_by = $3, reviewed_at = now()
         WHERE id = $1 RETURNING *`,
        [app.id, status, req.user!.id]
      );
      if (status === "approved") {
        await db.query(
          `INSERT INTO event_hosts (event_id, user_id, application_id) VALUES ($1, $2, $3)`,
          [app.event_id, app.user_id, app.id]
        );
      }
      await db.query(
        `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, metadata)
         VALUES ($1, $2, 'host_application', $3, $4)`,
        [req.user!.id, `host_application.${status}`, app.id, JSON.stringify({ event_id: app.event_id, user_id: app.user_id })]
      );
      return u.rows[0];
    });
    res.json(updated);
  })
);
