import { NextFunction, Request, Response } from "express";
import { ZodTypeAny } from "zod";
import { HttpError } from "./errors";

// Parse and replace req.body / req.query / req.params with the validated value.
export const validate =
  (part: "body" | "query" | "params", schema: ZodTypeAny) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req[part]);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || part}: ${i.message}`).join("; ");
      return next(new HttpError(400, msg));
    }
    // Express 5 makes req.query a read-only getter, so redefine the property instead of assigning.
    Object.defineProperty(req, part, { value: parsed.data, writable: true, configurable: true, enumerable: true });
    next();
  };
