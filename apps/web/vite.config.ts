import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import { shouldIncludeLive2dMaterial } from "./src/live2d/avatar-feature";

export default defineConfig(({ mode, command }) => {
  // Derive the deployment marker from the build platform, never a VITE_* override.
  const deploymentEnv = process.env.VERCEL_ENV ?? "";
  const env = { ...loadEnv(mode, import.meta.dirname, "VITE_"), ...process.env, VITE_YUI_DEPLOYMENT_ENV: deploymentEnv };
  const includeMaterial = shouldIncludeLive2dMaterial(mode, env);
  return {
    define: {
      "import.meta.env.VITE_YUI_DEPLOYMENT_ENV": JSON.stringify(deploymentEnv),
      "import.meta.env.VITE_YUI_LIVE2D_AVATAR_ENABLED": JSON.stringify(command === "build" && !includeMaterial ? "false" : env.VITE_YUI_LIVE2D_AVATAR_ENABLED ?? "false"),
    },
    plugins: [{
      name: "inline-wallpaper-bootstrap",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          for (const name of ["wallpaper-bootstrap", "wallpaper-viewport"]) {
            const script = readFileSync(resolve(import.meta.dirname, `public/${name}.js`), "utf8");
            html = html.replace(`<script src="/${name}.js"></script>`, `<script>${script}</script>`);
          }
          return html;
        },
      },
    }, {
      name: "exclude-local-avatar-material",
      apply: "build",
      closeBundle() {
        // Owner Preview delivery still requires protection for every static path.
        if (!includeMaterial) rmSync(resolve(import.meta.dirname, "dist/live2d"), { recursive: true, force: true });
      },
    }],
    server: {
      host: "127.0.0.1",
      port: 4383,
      strictPort: true,
      proxy: {
        "/api": "http://127.0.0.1:4384",
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: "./test/setup.ts",
      // Browser fixtures also start Vite; bound workers to avoid cold-start contention.
      maxWorkers: 2,
    },
  };
});
