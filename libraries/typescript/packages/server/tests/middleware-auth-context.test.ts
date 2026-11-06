/**
 * MCP middleware and the operation callback share one Hono `Context` per HTTP
 * request, but each must keep its own `ctx.auth` shape: middleware receives
 * the SDK `AuthInfo` and callbacks receive the mapped `OAuthAuth`. Running the
 * callback must not change what middleware or `:complete` observers see.
 *
 * Exercised over `server.fetch` on the stateless 2026-07-28 envelope.
 */
import { describe, expect, it } from "vitest";

import { MCPServer } from "../src/index.js";
import { oauthCustomProvider, type OAuthMetadata } from "../src/oauth/index.js";

const resource = "https://shop.example.test/mcp";

interface TestUser {
  id: string;
}

const payload = { sub: "user-1" };

function server() {
  return new MCPServer({
    name: "shop",
    version: "1.0.0",
    logging: { enabled: false },
    oauth: oauthCustomProvider<TestUser>({
      resource,
      createTokenVerifier: (boundResource) => ({
        verifyAccessToken: async (token) => ({
          token,
          clientId: "client-1",
          scopes: ["shop"],
          expiresAt: Date.now() / 1000 + 600,
          resource: boundResource,
        }),
      }),
      oauthMetadata: { issuer: "https://issuer.example.test" } as OAuthMetadata,
      mapAuthInfo: () => ({
        user: { id: "user-1" },
        payload,
        permissions: [],
      }),
    }),
  });
}

const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function post(method: string, params: Record<string, unknown>): Request {
  const subject = params["name"] ?? params["uri"];
  return new Request(resource, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(typeof subject === "string" && { "mcp-name": subject }),
      authorization: "Bearer token",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: { ...params, _meta: ENVELOPE },
    }),
  });
}

async function ok(response: Response): Promise<void> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { error?: unknown };
  expect(body.error).toBeUndefined();
}

/** What a middleware or observer saw in `ctx.auth`. */
function authView(auth: unknown) {
  const info = auth as
    | { token?: string; extra?: { user?: unknown; payload?: unknown } }
    | undefined;
  return {
    token: info?.token,
    user: info?.extra?.user,
    payload: info?.extra?.payload,
  };
}

const sdkAuth = { token: "token", user: { id: "user-1" }, payload };

describe("MCP middleware ctx.auth", () => {
  it("stays the SDK AuthInfo after a tool callback runs", async () => {
    const app = server();
    const seen: Record<string, unknown> = {};
    app.use("mcp:tools/call", async (ctx, next) => {
      seen["before"] = authView(ctx.auth);
      const result = await next();
      seen["after"] = authView(ctx.auth);
      return result;
    });
    app.on("mcp:tools/call", (ctx) => {
      seen["observerBefore"] = authView(ctx.auth);
    });
    app.on("mcp:tools/call:complete", (ctx) => {
      seen["observerComplete"] = authView(ctx.auth);
    });
    app.tool({ name: "whoami" }, async (_args, ctx) => {
      seen["callback"] = ctx.auth;
      return { content: [{ type: "text", text: ctx.auth.user.id }] };
    });

    await ok(await app.fetch(post("tools/call", { name: "whoami" })));

    expect(seen["before"]).toEqual(sdkAuth);
    expect(seen["after"]).toEqual(sdkAuth);
    expect(seen["observerBefore"]).toEqual(sdkAuth);
    expect(seen["observerComplete"]).toEqual(sdkAuth);
    expect(seen["callback"]).toMatchObject({
      user: { id: "user-1" },
      accessToken: "token",
    });
  });

  it("shares the mapped payload object between middleware and callback", async () => {
    const app = server();
    let middlewarePayload: unknown;
    let callbackPayload: unknown;
    app.use("mcp:tools/call", async (ctx, next) => {
      const result = await next();
      middlewarePayload = authView(ctx.auth).payload;
      return result;
    });
    app.tool({ name: "whoami" }, async (_args, ctx) => {
      callbackPayload = ctx.auth.payload;
      return { content: [{ type: "text", text: "ok" }] };
    });

    await ok(await app.fetch(post("tools/call", { name: "whoami" })));

    expect(middlewarePayload).toBe(payload);
    expect(callbackPayload).toBe(payload);
  });

  it("stays the SDK AuthInfo after resource and prompt callbacks run", async () => {
    const app = server();
    const after: Record<string, unknown> = {};
    app.use("mcp:resources/read", async (ctx, next) => {
      const result = await next();
      after["resources/read"] = authView(ctx.auth);
      return result;
    });
    app.use("mcp:prompts/get", async (ctx, next) => {
      const result = await next();
      after["prompts/get"] = authView(ctx.auth);
      return result;
    });
    app.resource(
      { name: "profile", uri: "app://profile" },
      async (uri, ctx) => ({
        contents: [{ uri: uri.href, text: ctx.auth.user.id }],
      })
    );
    app.prompt({ name: "greet" }, async (_args, ctx) => ({
      messages: [
        {
          role: "user",
          content: { type: "text", text: `hi ${ctx.auth.user.id}` },
        },
      ],
    }));

    await ok(await app.fetch(post("resources/read", { uri: "app://profile" })));
    await ok(await app.fetch(post("prompts/get", { name: "greet" })));

    expect(after["resources/read"]).toEqual(sdkAuth);
    expect(after["prompts/get"]).toEqual(sdkAuth);
  });
});

describe("MCP middleware and callback context separation", () => {
  it("keeps middleware-only fields out of the callback context", async () => {
    const app = server();
    let callbackFields: Record<string, unknown> = {};
    app.use("mcp:tools/call", async (ctx, next) => {
      ctx.state.set("seen", true);
      return next();
    });
    app.tool({ name: "whoami" }, async (_args, ctx) => {
      const fields = ctx as unknown as Record<string, unknown>;
      callbackFields = {
        method: fields["method"],
        params: fields["params"],
        state: fields["state"],
      };
      return { content: [{ type: "text", text: "ok" }] };
    });

    await ok(await app.fetch(post("tools/call", { name: "whoami" })));

    expect(callbackFields).toEqual({
      method: undefined,
      params: undefined,
      state: undefined,
    });
  });

  it("still exposes the shared Hono context to middleware and callbacks", async () => {
    const app = server();
    const seen: Record<string, unknown> = {};
    app.use(async (c, next) => {
      c.set("requestId" as never, "req-1" as never);
      await next();
    });
    app.use("mcp:tools/call", async (ctx, next) => {
      seen["middlewareVar"] = (ctx.get as (key: string) => unknown)(
        "requestId"
      );
      seen["middlewarePath"] = ctx.req?.path;
      const result = await next();
      seen["middlewareVarAfter"] = (ctx.get as (key: string) => unknown)(
        "requestId"
      );
      return result;
    });
    app.tool({ name: "whoami" }, async (_args, ctx) => {
      seen["callbackVar"] = (ctx.get as (key: string) => unknown)("requestId");
      seen["callbackPath"] = ctx.req?.path;
      return { content: [{ type: "text", text: "ok" }] };
    });

    await ok(await app.fetch(post("tools/call", { name: "whoami" })));

    expect(seen).toEqual({
      middlewareVar: "req-1",
      middlewarePath: "/mcp",
      middlewareVarAfter: "req-1",
      callbackVar: "req-1",
      callbackPath: "/mcp",
    });
  });
});
