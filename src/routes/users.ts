import { Router } from "express";
import { z } from "zod";
import { pool, withTransaction } from "../db";
import { HttpError, wrap } from "../middleware/errors";
import { validate } from "../middleware/validate";
import { idParam } from "./common";

export const users = Router();

const createUser = z.object({
  email: z.string().email(),
  phone: z.string().min(5).optional(),
  full_name: z.string().min(1),
  bio: z.string().optional(),
  city: z.string().optional(),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").optional(),
  instagram_handle: z.string().optional(),
});

// POST /users | tables: users, user_profiles
// Role is always 'user' here; admins are created by the seed script.
users.post(
  "/users",
  validate("body", createUser),
  wrap(async (req, res) => {
    const b = req.body;
    const created = await withTransaction(async (db) => {
      const u = await db.query(
        `INSERT INTO users (email, phone) VALUES ($1, $2) RETURNING id, email, phone, role, created_at`,
        [b.email, b.phone ?? null]
      );
      await db.query(
        `INSERT INTO user_profiles (user_id, full_name, bio, city, date_of_birth, instagram_handle)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [u.rows[0].id, b.full_name, b.bio ?? null, b.city ?? null, b.date_of_birth ?? null, b.instagram_handle ?? null]
      );
      return u.rows[0];
    });
    res.status(201).json(created);
  })
);

// GET /users/:id | tables: users, user_profiles
users.get(
  "/users/:id",
  validate("params", idParam),
  wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.phone, u.role, u.created_at,
              p.full_name, p.bio, p.city, p.date_of_birth, p.instagram_handle, p.avatar_media_id
       FROM users u
       JOIN user_profiles p ON p.user_id = u.id
       WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [req.params.id]
    );
    if (rows.length === 0) throw new HttpError(404, "User not found");
    res.json(rows[0]);
  })
);
