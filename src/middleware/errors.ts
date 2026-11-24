import { NextFunction, Request, Response } from "express";

// Throw this from a handler to return { "error": message } with a status code.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Express 4 does not catch rejected promises, so wrap async handlers with this.
export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ error: "Not found" });
}

// Postgres error codes: 23505 unique violation, 23503 foreign key, 23514 check, 22P02 bad uuid/enum
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err?.code === "23505") return res.status(409).json({ error: "Already exists" });
  if (err?.code === "23503") return res.status(400).json({ error: "Referenced record does not exist" });
  if (err?.code === "23514" || err?.code === "22P02") return res.status(400).json({ error: "Invalid value" });
  if (err?.name === "MulterError") return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
