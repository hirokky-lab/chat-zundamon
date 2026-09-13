import type { GoogleService } from "./google-calendar-tasks";

export type GoogleSourceChoice = Readonly<{ id: string; title: string }>;
export type GoogleSourceChoiceStore = {
  get(service: GoogleService): GoogleSourceChoice | null;
  set(service: GoogleService, choice: GoogleSourceChoice | null): void;
};

export function createGoogleSourceChoiceStore(ownerId?: string): GoogleSourceChoiceStore {
  const memory: Partial<Record<GoogleService, GoogleSourceChoice | null>> = {};
  const key = (service: GoogleService) => `zundamon-ai-google-source:${ownerId}:${service}`;
  return {
    get(service) {
      if (service in memory) return memory[service] ?? null;
      try {
        const raw = ownerId ? localStorage.getItem(key(service)) : null;
        const value: unknown = raw ? JSON.parse(raw) : null;
        if (validChoice(value)) return memory[service] = value;
      } catch { /* A storage failure must not block an explicit selection. */ }
      return null;
    },
    set(service, choice) {
      if (choice !== null && !validChoice(choice)) throw new Error("Invalid Google source selection");
      memory[service] = choice;
      if (!ownerId) return;
      try {
        if (choice) localStorage.setItem(key(service), JSON.stringify(choice));
        else localStorage.removeItem(key(service));
      } catch { /* Keep this session usable if browser storage is unavailable. */ }
    },
  };
}

function validChoice(value: unknown): value is GoogleSourceChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).sort().join(",") === "id,title"
    && typeof item.id === "string" && item.id.length > 0 && item.id.length <= 1024
    && typeof item.title === "string" && item.title.length > 0 && item.title.length <= 120
    && !/[\u0000-\u001f\u007f]/u.test(item.id + item.title);
}
