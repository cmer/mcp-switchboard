import { Hono } from "hono";
import type { Db } from "../../src/db/index.js";
import { defaultUserId, getUser } from "../../src/core/users.js";

/**
 * Mount a route group the way app.ts does behind `adminAuthMiddleware`: with a signed-in user on
 * the context. Defaults to the Default user, which is who single-user tests act as.
 */
export function mountAs(db: Db, routes: Hono, userId: number = defaultUserId(db)): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", getUser(db, userId)!);
    await next();
  });
  app.route("/", routes);
  return app;
}
