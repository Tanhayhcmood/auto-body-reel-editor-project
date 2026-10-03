import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { createApiKeyAuthMiddleware } from "./api-key-auth";

interface MiddlewareResult {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
  nextCalled: boolean;
}

function runMiddleware(
  expectedKey: string | undefined,
  authorization: string | undefined,
): MiddlewareResult {
  const result: MiddlewareResult = {
    headers: {},
    nextCalled: false,
  };
  const request = {
    get(name: string) {
      return name.toLowerCase() === "authorization" ? authorization : undefined;
    },
  } as unknown as Request;
  const response = {
    status(statusCode: number) {
      result.statusCode = statusCode;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
    setHeader(name: string, value: string) {
      result.headers[name.toLowerCase()] = value;
      return this;
    },
  } as unknown as Response;

  createApiKeyAuthMiddleware(() => expectedKey)(
    request,
    response,
    () => {
      result.nextCalled = true;
    },
  );

  return result;
}

test("fails closed when the API access key is not configured", () => {
  const result = runMiddleware(undefined, "Bearer anything");

  assert.equal(result.statusCode, 503);
  assert.equal(result.nextCalled, false);
});

test("rejects requests without a bearer key", () => {
  const result = runMiddleware("expected-secret", undefined);

  assert.equal(result.statusCode, 401);
  assert.equal(result.headers["www-authenticate"], "Bearer");
  assert.equal(result.nextCalled, false);
});

test("rejects an incorrect bearer key", () => {
  const result = runMiddleware("expected-secret", "Bearer wrong-secret");

  assert.equal(result.statusCode, 401);
  assert.equal(result.nextCalled, false);
});

test("accepts the configured bearer key", () => {
  const result = runMiddleware("expected-secret", "Bearer expected-secret");

  assert.equal(result.statusCode, undefined);
  assert.equal(result.nextCalled, true);
});