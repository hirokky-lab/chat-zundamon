const ZUNDAMON_PWA_VERSION = "20260913-chat-zundamon-name-2";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
