import type { FastifyInstance } from "fastify";

export type BrowserConfig = {
  supabaseUrl: string;
  supabasePublishableKey: string;
  photoAnalysisEnabled: boolean;
  integratedUiEnabled: boolean;
  prismEchoEnabled: boolean;
};

export function registerBrowserConfigRoute(
  app: FastifyInstance,
  config: BrowserConfig,
): void {
  app.get("/api/browser-config", async (_request, reply) => {
    return reply
      .header("Cache-Control", "no-store")
      .send({
        supabaseUrl: config.supabaseUrl,
        supabasePublishableKey: config.supabasePublishableKey,
        photoAnalysisEnabled: config.photoAnalysisEnabled,
        integratedUiEnabled: config.integratedUiEnabled,
        prismEchoEnabled: config.prismEchoEnabled,
      });
  });
}
