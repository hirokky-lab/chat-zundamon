import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../src/index";
import type { PhotoMessage } from "../src/index";

describe("domain package", () => {
  it("exports the product name", () => {
    expect(PRODUCT_NAME).toBe("Chatずんだもん");
  });

  it("exports the photo message contract from the package root", () => {
    const photo: PhotoMessage = {
      id: "11111111-1111-4111-8111-111111111111",
      type: "photo",
      role: "user",
      photoId: "22222222-2222-4222-8222-222222222222",
      caption: "これ見て",
      origin: "photo",
      createdAt: "2026-08-10T00:00:00.000Z",
      delivery: "sent",
    };
    expect(photo.type).toBe("photo");
  });
});
