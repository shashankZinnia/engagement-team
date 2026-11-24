import { Router } from "express";
import { pool } from "../db";
import { wrap } from "../middleware/errors";
import { users } from "./users";
import { partners } from "./partners";
import { events } from "./events";
import { waitlist } from "./waitlist";
import { hosts } from "./hosts";
import { swipes } from "./swipes";
import { media } from "./media";
import { products } from "./products";
import { adminJobs } from "./admin";

export const routes = Router();

// GET /health  | tables: none
routes.get(
  "/health",
  wrap(async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "ok" });
  })
);

routes.use(users);
routes.use(partners);
// swipes holds /events/feed and /events/top, so it must come BEFORE events (/events/:id)
routes.use(swipes);
routes.use(events);
routes.use(waitlist);
routes.use(hosts);
routes.use(media);
routes.use(products);
routes.use(adminJobs);
