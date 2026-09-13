import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { App, HostedApp } from "../src/App";
import { renderYuiStartup } from "../src/startup-render";

const authClient = {
  getSession: async () => null,
  signInWithPassword: async () => { throw new Error("unused"); },
  requestOtp: async () => undefined,
  verifyOtp: async () => { throw new Error("unused"); },
  updatePassword: async () => undefined,
  signOut: async () => undefined,
  onSessionChange: () => () => undefined,
};

function renderRoot() {
  const render = vi.fn<(node: ReactNode) => void>();
  return { root: { render }, render };
}

describe("YUI startup rendering", () => {
  it("renders the real HostedApp boundary after same-origin config succeeds", async () => {
    const { root, render } = renderRoot();
    const createBrowserAuthClient = vi.fn(() => authClient);
    const loadAuth = vi.fn(async () => ({ createBrowserAuthClient }));

    await renderYuiStartup({
      root,
      env: { VITE_ZUNDAMON_API_BASE_URL: "/" },
      fetchImpl: async () => Response.json({
        supabaseUrl: "https://project.supabase.co",
        supabasePublishableKey: "publishable",
        photoAnalysisEnabled: true,
        prismEchoEnabled: true,
        integratedUiEnabled: true,
      }),
      loadAuth,
      integratedUiEnabled: false,
    });

    const element = render.mock.calls[0]?.[0] as ReactElement;
    expect(element.type).toBe(HostedApp);
    expect(element.props.apiBaseUrl).toBe("");
    expect(element.props.authClient).toBe(authClient);
    expect(element.props.photoAnalysisEnabled).toBe(true);
    expect(element.props.prismEchoEnabled).toBe(true);
    expect(element.props.integratedUiEnabled).toBe(true);
    expect(element.props.live2dAvatarEnabled).toBeUndefined();
    expect(element.props.live2dModel).toBeUndefined();
    expect(createBrowserAuthClient).toHaveBeenCalledWith("https://project.supabase.co", "publishable");
  });

  it("keeps Live2D disabled at the hosted boundary even when local build flags are present", async () => {
    const { root, render } = renderRoot();
    await renderYuiStartup({
      root,
      env: { VITE_ZUNDAMON_API_BASE_URL: "/", VITE_YUI_LIVE2D_AVATAR_ENABLED: "true", VITE_YUI_LIVE2D_BRIDGE_SHA256: "a".repeat(64) },
      fetchImpl: async () => Response.json({ supabaseUrl: "https://project.supabase.co", supabasePublishableKey: "publishable", photoAnalysisEnabled: false, prismEchoEnabled: false, integratedUiEnabled: false }),
      loadAuth: async () => ({ createBrowserAuthClient: () => authClient }),
      integratedUiEnabled: false,
    });

    const element = render.mock.calls[0]?.[0] as ReactElement;
    expect(element.type).toBe(HostedApp);
    expect(element.props.live2dAvatarEnabled).toBeUndefined();
    expect(element.props.live2dModel).toBeUndefined();
  });

  it.each(["preview", "production", undefined])("admits the pinned hosted model only on Preview (%s)", async deployment => {
    const { root, render } = renderRoot();
    await renderYuiStartup({ root, env: {
      VITE_ZUNDAMON_API_BASE_URL: "/", VITE_YUI_DEPLOYMENT_ENV: deployment,
      VITE_YUI_LIVE2D_AVATAR_ENABLED: "true", VITE_YUI_LIVE2D_MODEL: "zundamon",
      VITE_YUI_LIVE2D_BRIDGE_SHA256: "a".repeat(64),
    }, fetchImpl: async () => Response.json({ supabaseUrl: "https://project.supabase.co", supabasePublishableKey: "publishable", photoAnalysisEnabled: false, prismEchoEnabled: false, integratedUiEnabled: true }),
    loadAuth: async () => ({ createBrowserAuthClient: () => authClient }), integratedUiEnabled: true });
    const element = render.mock.calls[0][0] as ReactElement;
    expect(element.type).toBe(HostedApp);
    expect(element.props.live2dAvatarEnabled).toBe(deployment === "preview" ? true : undefined);
    expect(element.props.live2dModel?.id).toBe(deployment === "preview" ? "live2d-official-zundamon-2026-08-25" : undefined);
  });

  it("renders an accessible fixed failure instead of the local App", async () => {
    const { root, render } = renderRoot();
    const loadAuth = vi.fn();

    await renderYuiStartup({
      root,
      env: { VITE_ZUNDAMON_API_BASE_URL: "/" },
      fetchImpl: async () => Response.json({ unknown: "schema" }),
      loadAuth,
      integratedUiEnabled: false,
    });

    const element = render.mock.calls[0]?.[0] as ReactElement;
    expect(element.type).toBe("main");
    expect(element.props).toMatchObject({ role: "alert", children: "Chatずんだもんを起動できませんでした。" });
    expect(element.type).not.toBe(App);
    expect(loadAuth).not.toHaveBeenCalled();
  });

  it("renders the local App only when every hosted marker is absent", async () => {
    const { root, render } = renderRoot();
    const loadAuth = vi.fn();

    await renderYuiStartup({ root, env: {}, loadAuth, integratedUiEnabled: false });

    const element = render.mock.calls[0]?.[0] as ReactElement;
    expect(element.type).toBe(App);
    expect(element.props.proactiveMessagingEnabled).toBe(false);
    expect(element.props.causalCueEnabled).toBe(false);
    expect(loadAuth).not.toHaveBeenCalled();
  });

  it("enables local Prism Echo only for the exact true opt-in", async () => {
    const off = renderRoot();
    await renderYuiStartup({ root: off.root, env: { VITE_YUI_PRISM_ECHO_ENABLED: "TRUE" }, integratedUiEnabled: false });
    expect((off.render.mock.calls[0]?.[0] as ReactElement).props.causalCueEnabled).toBe(false);

    const on = renderRoot();
    await renderYuiStartup({ root: on.root, env: { VITE_YUI_PRISM_ECHO_ENABLED: "true" }, integratedUiEnabled: false });
    expect((on.render.mock.calls[0]?.[0] as ReactElement).props.causalCueEnabled).toBe(true);
  });

  it("wires the local fixture experience only behind the explicit feature flag", async () => {
    const { root, render } = renderRoot();
    await renderYuiStartup({ root, env: { VITE_YUI_PROACTIVE_MESSAGING_ENABLED: "true" }, integratedUiEnabled: false });
    const element = render.mock.calls[0]?.[0] as ReactElement;
    expect(element.type).toBe(App);
    expect(element.props.proactiveMessagingEnabled).toBe(true);
    expect(element.props.proactiveApi).toBeDefined();
    expect(element.props.notificationPreferenceStore).toBeDefined();
  });

  it("threads an exact initially-off Live2D feature only with a pinned bridge hash", async () => {
    const off = renderRoot();
    await renderYuiStartup({ root: off.root, env: { VITE_YUI_LIVE2D_AVATAR_ENABLED: "TRUE", VITE_YUI_LIVE2D_BRIDGE_SHA256: "a".repeat(64) }, integratedUiEnabled: false });
    const offElement = off.render.mock.calls[0]?.[0] as ReactElement;
    expect(offElement.props.live2dAvatarEnabled).toBe(false);
    expect(offElement.props.live2dModel).toBeUndefined();

    const on = renderRoot();
    await renderYuiStartup({ root: on.root, env: { VITE_YUI_LIVE2D_AVATAR_ENABLED: "true", VITE_YUI_LIVE2D_BRIDGE_SHA256: "a".repeat(64) }, integratedUiEnabled: false });
    const onElement = on.render.mock.calls[0]?.[0] as ReactElement;
    expect(onElement.props.live2dAvatarEnabled).toBe(true);
    expect(onElement.props.live2dModel).toMatchObject({ id: "live2d-official-simple-2026-05-28", sdkVersion: "5-r.5" });
  });
  it("selects the pinned Zundamon manifest only for the explicit local model", async () => {
    const { root, render } = renderRoot();
    await renderYuiStartup({ root, env: { VITE_YUI_LIVE2D_AVATAR_ENABLED: "true", VITE_YUI_LIVE2D_MODEL: "zundamon", VITE_YUI_LIVE2D_BRIDGE_SHA256: "a".repeat(64) }, integratedUiEnabled: true });
    expect((render.mock.calls[0][0] as ReactElement).props.live2dModel.id).toBe("live2d-official-zundamon-2026-08-25");
  });

});

it('keeps the local Live2D avatar and email login when connecting the private local build', async () => {
  const {root,render} = renderRoot();
  const createBrowserAuthClient = vi.fn(() => authClient);
  await renderYuiStartup({root, integratedUiEnabled:true,
    env:{MODE:'local-live2d', VITE_ZUNDAMON_API_BASE_URL:'/',VITE_ZUNDAMON_GOOGLE_LOGIN_ENABLED:'false',
      VITE_YUI_LIVE2D_AVATAR_ENABLED:'true',VITE_YUI_LIVE2D_MODEL:'zundamon',VITE_YUI_LIVE2D_BRIDGE_SHA256:'a'.repeat(64)},
    fetchImpl:async () => Response.json({supabaseUrl:'https://project.supabase.co',supabasePublishableKey:'public',photoAnalysisEnabled:false,integratedUiEnabled:true,prismEchoEnabled:false}),
    loadAuth:async () => ({createBrowserAuthClient})});
  expect(createBrowserAuthClient).toHaveBeenCalledWith('https://project.supabase.co','public',{googleEnabled:false});
  expect((render.mock.calls[0][0] as ReactElement).props.live2dAvatarEnabled).toBe(true);
});
