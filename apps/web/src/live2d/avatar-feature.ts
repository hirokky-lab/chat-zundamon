export function isLive2dAvatarEnabled(value: string | undefined): boolean {
  return value === "true";
}

type AvatarBuildEnv = Record<string, string | undefined>;

export function isHostedZundamonEnabled(env: AvatarBuildEnv): boolean {
  return env.VITE_YUI_DEPLOYMENT_ENV === "preview"
    && isLive2dAvatarEnabled(env.VITE_YUI_LIVE2D_AVATAR_ENABLED)
    && env.VITE_YUI_LIVE2D_MODEL === "zundamon"
    && /^[a-f0-9]{64}$/.test(env.VITE_YUI_LIVE2D_BRIDGE_SHA256 ?? "");
}

export function shouldIncludeLive2dMaterial(mode: string, env: AvatarBuildEnv): boolean {
  if (mode === "local-live2d") return !env.VITE_YUI_DEPLOYMENT_ENV;
  return mode === "preview-live2d" && isHostedZundamonEnabled(env);
}
