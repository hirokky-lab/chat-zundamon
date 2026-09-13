import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app";

describe("hosted realtime CORS", () => {
  it("allows the session and time-zone headers used by the browser call request", async () => {
    const app = buildApp({
      authVerifier: { verify: async () => null },
      allowedOrigin: "https://yui.example",
      extractor: { extract: async () => ({ candidates: [] }) },
      logger: false,
    });

    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/realtime/calls",
      headers: {
        origin: "https://yui.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type,x-yui-session-id,x-yui-time-zone",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-headers"]?.toLowerCase()).toContain("x-yui-session-id");
    expect(response.headers["access-control-allow-headers"]?.toLowerCase()).toContain("x-yui-time-zone");
  });
});
