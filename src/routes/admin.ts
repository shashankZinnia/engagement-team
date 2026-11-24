import { Router } from "express";
import { pool } from "../db";
import { admin } from "../middleware/auth";
import { wrap } from "../middleware/errors";

export const adminJobs = Router();

// POST /admin/jobs/refresh-rank (admin) | tables: event_stats (via refresh_event_rank_scores())
// TODO schedule this (pg_cron / EventBridge) instead of calling it by hand.
adminJobs.post(
  "/admin/jobs/refresh-rank",
  ...admin,
  wrap(async (_req, res) => {
    await pool.query("SELECT refresh_event_rank_scores()");
    res.json({ status: "ok" });
  })
);
