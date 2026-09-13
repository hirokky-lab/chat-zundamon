import type { IncomingMessage, ServerResponse } from "node:http";

/** A request body may be complete while the caller is still waiting for its reply. */
export function responseCancellation(request: IncomingMessage, response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const cleanup = () => {
    request.off("aborted", abort);
    response.off("close", close);
    response.off("finish", cleanup);
  };
  const close = () => {
    if (!response.writableEnded) abort();
    cleanup();
  };
  request.once("aborted", abort);
  response.once("close", close);
  response.once("finish", cleanup);
  if (request.aborted || response.destroyed) abort();
  return controller.signal;
}
