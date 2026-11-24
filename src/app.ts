import express from "express";
import { errorHandler, notFound } from "./middleware/errors";
import { routes } from "./routes";

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(routes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
