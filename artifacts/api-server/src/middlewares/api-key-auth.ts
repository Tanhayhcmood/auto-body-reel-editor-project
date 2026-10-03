import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

type ApiKeyProvider = () => string | undefined;

export function createApiKeyAuthMiddleware(
  getApiKey: ApiKeyProvider = () => process.env["API_ACCESS_KEY"],
): RequestHandler {
  return (request, response, next) => {
    const expectedKey = getApiKey()?.trim();
    if (!expectedKey) {
      response.status(503).json({ error: "API access is not configured." });
      return;
    }

    const authorization = request.get("authorization");
    const suppliedKey = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
    if (!suppliedKey) {
      response.setHeader("WWW-Authenticate", "Bearer");
      response.status(401).json({ error: "A valid API access key is required." });
      return;
    }

    const expected = Buffer.from(expectedKey, "utf8");
    const supplied = Buffer.from(suppliedKey, "utf8");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
      response.setHeader("WWW-Authenticate", "Bearer");
      response.status(401).json({ error: "A valid API access key is required." });
      return;
    }

    next();
  };
}

export default createApiKeyAuthMiddleware();