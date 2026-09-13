import { buildHostedApp } from "./app.js";

const app = buildHostedApp();
await app.listen({ host: "0.0.0.0", port: Number(process.env.ZUNDAMON_PORT ?? 4384) });
