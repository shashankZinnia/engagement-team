import { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { pool } from "../db";
import { HttpError, wrap } from "./errors";

export interface AuthUser {
  id: string;
  email: string;
  role: "user" | "admin";
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// TODO real auth: replace this x-user-id stub with JWT/OAuth sessions.
// For now the caller is whoever the x-user-id header says they are.
export const requireUser = wrap(async (req: Request, _res: Response, next: NextFunction) => {
  const id = req.header("x-user-id");
  if (!id) throw new HttpError(401, "Missing x-user-id header");
  if (!z.string().uuid().safeParse(id).success) throw new HttpError(401, "Invalid x-user-id");

  // tables: users
  const { rows } = await pool.query(
    "SELECT id, email, role FROM users WHERE id = $1 AND deleted_at IS NULL",
    [id]
  );
  if (rows.length === 0) throw new HttpError(401, "Unknown user");
  req.user = rows[0];
  next();
});

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") return next(new HttpError(403, "Admin only"));
  next();
}

// Use as: router.post("/x", ...admin, handler)
export const admin = [requireUser, requireAdmin];
