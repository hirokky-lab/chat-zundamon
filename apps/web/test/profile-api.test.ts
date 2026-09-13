import { describe, expect, it, vi } from "vitest";
import type { Profile } from "@yui/domain";
import { createProfileApi } from "../src/api";

const profile: Profile = {
  displayName: "大輝",
  addressingStyle: "san",
  updatedAt: "2026-08-08T03:00:00.000Z",
};

describe("profile API", () => {
  it("gets a missing profile as null", async () => {
    const fetch = vi.fn(async () => Response.json({ profile: null }));

    await expect(createProfileApi(fetch).get()).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/profile");
  });

  it("saves both profile fields and returns the fully validated server profile", async () => {
    const fetch = vi.fn(async () => Response.json({ profile }));

    await expect(createProfileApi(fetch).save({ displayName: "大輝", addressingStyle: "san" })).resolves.toEqual(profile);
    expect(fetch).toHaveBeenCalledWith("/api/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "大輝", addressingStyle: "san" }),
    });
  });

  it("rejects a failed profile response without reading its body", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetch = vi.fn(async () => new Response("private error", {
      status: 502,
      headers: { "Content-Type": "text/plain" },
    }));
    const response = await fetch("/unused");
    Object.defineProperty(response, "body", { value: { cancel } });

    await expect(createProfileApi(async () => response).get())
      .rejects.toMatchObject({ name: "YuiRequestError", kind: "upstream", status: 502 });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a malformed successful profile response", async () => {
    await expect(createProfileApi(async () => Response.json({ profile: { displayName: 42 } })).get())
      .rejects.toThrow("Yui response was invalid");
  });

  it.each([
    ["missing addressing style", { displayName: "大輝", updatedAt: "2026-08-08T03:00:00.000Z" }],
    ["unknown addressing style", { displayName: "大輝", addressingStyle: "sama", updatedAt: "2026-08-08T03:00:00.000Z" }],
    ["noncanonical timestamp", { displayName: "大輝", addressingStyle: "san", updatedAt: "not-a-time" }],
  ])("rejects a profile with %s", async (_name, malformed) => {
    await expect(createProfileApi(async () => Response.json({ profile: malformed })).get())
      .rejects.toThrow("Yui response was invalid");
  });
});
