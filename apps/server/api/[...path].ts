import type { IncomingMessage, ServerResponse } from "node:http";
import { buildHostedApp } from "../src/app.js";

const app = buildHostedApp();
const ready = app.ready();

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  await ready;
  app.server.emit("request", request, response);
}
