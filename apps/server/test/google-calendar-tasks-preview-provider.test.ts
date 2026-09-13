import { describe, expect, it, vi } from "vitest";
import { GoogleCalendarTasksDiagnosticError } from "../src/google-calendar-tasks-diagnostics";
import { createGoogleCalendarTasksPreviewGateway } from "../src/google-calendar-tasks-preview-provider";
import type { RequestUser } from "../src/request-user";

const owner: RequestUser = {
  userId: "00000000-0000-0000-0000-0000000000a1",
  email: "owner@example.test",
  accessToken: "owner-access-token",
};

function makeGateway(payload: unknown, status = 200) {
  const get = vi.fn(async () => ({
    status,
    contentLength: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    json: async () => payload,
  }));
  return {
    gateway: createGoogleCalendarTasksPreviewGateway({
      tokens: { getAccessToken: async () => "access-token" },
      transport: { get },
      now: () => new Date("2026-09-01T01:02:03.000Z"),
    }),
    get,
  };
}

describe("Google Calendar/Tasks ephemeral preview provider", () => {
  it("projects at most three upcoming Calendar titles and starts from one bounded GET", async () => {
    const { gateway, get } = makeGateway({
      items: [
        { status: "confirmed", summary: "朝会", start: { dateTime: "2026-09-01T10:00:00+09:00" } },
        { status: "tentative", start: { date: "2026-09-02" } },
        { status: "cancelled" },
      ],
    });

    await expect(gateway.preview({ owner, service: "calendar", sourceId: "primary" }, new AbortController().signal)).resolves.toEqual({
      service: "calendar",
      checkedAt: "2026-09-01T01:02:03.000Z",
      items: [
        { title: "朝会", start: { kind: "date_time", value: "2026-09-01T10:00:00+09:00" } },
        { title: "（タイトルなし）", start: { kind: "all_day", value: "2026-09-02" } },
      ],
    });
    const request = new URL(get.mock.calls[0]![0].url);
    expect(get).toHaveBeenCalledTimes(1);
    expect(request.searchParams.get("singleEvents")).toBe("true");
    expect(request.searchParams.get("orderBy")).toBe("startTime");
    expect(request.searchParams.get("showDeleted")).toBe("false");
    expect(request.searchParams.get("maxResults")).toBe("3");
    expect(request.searchParams.get("timeMin")).toBe("2026-09-01T01:02:03.000Z");
    expect(request.searchParams.get("fields")).toBe("items(status,summary,start(date,dateTime))");
  });

  it("normalizes omitted Calendar status as confirmed and trims safe provider titles", async () => {
    const { gateway } = makeGateway({
      items: [
        { summary: "  予定  ", start: { date: "2026-09-02" } },
        { status: "cancelled", summary: "表示しない", start: { date: "2026-09-03" } },
      ],
    });

    await expect(gateway.preview({ owner, service: "calendar", sourceId: "primary" }, new AbortController().signal)).resolves.toEqual({
      service: "calendar",
      checkedAt: "2026-09-01T01:02:03.000Z",
      items: [{ title: "予定", start: { kind: "all_day", value: "2026-09-02" } }],
    });
  });

  it("projects at most five incomplete Task titles and date-only due values", async () => {
    const { gateway, get } = makeGateway({
      items: [
        { status: "needsAction", title: "資料を確認", due: "2026-09-03T00:00:00.000Z" },
        { status: "needsAction" },
      ],
    });

    await expect(gateway.preview({ owner, service: "tasks" }, new AbortController().signal)).resolves.toEqual({
      service: "tasks",
      checkedAt: "2026-09-01T01:02:03.000Z",
      items: [
        { title: "資料を確認", due: "2026-09-03" },
        { title: "（タイトルなし）", due: null },
      ],
    });
    const request = new URL(get.mock.calls[0]![0].url);
    expect(request.searchParams.get("showCompleted")).toBe("false");
    expect(request.searchParams.get("showDeleted")).toBe("false");
    expect(request.searchParams.get("showHidden")).toBe("false");
    expect(request.searchParams.get("maxResults")).toBe("5");
    expect(request.searchParams.get("fields")).toBe("items(status,title,due)");
  });

  it("trims safe Task titles before projecting them", async () => {
    const { gateway } = makeGateway({ items: [{ status: "needsAction", title: "  確認  " }] });
    await expect(gateway.preview({ owner, service: "tasks" }, new AbortController().signal)).resolves.toMatchObject({
      items: [{ title: "確認", due: null }],
    });
  });

  it.each([
    ["calendar unknown top-level", "calendar", { items: [], nextPageToken: "private" }],
    ["calendar identifier", "calendar", { items: [{ status: "confirmed", summary: "予定", start: { date: "2026-09-02" }, id: "private" }] }],
    ["calendar nested privacy", "calendar", { items: [{ status: "confirmed", summary: "予定", start: { date: "2026-09-02", timeZone: "private" } }] }],
    ["calendar invalid status", "calendar", { items: [{ status: "unknown", start: { date: "2026-09-02" } }] }],
    ["calendar missing start", "calendar", { items: [{ status: "confirmed", summary: "予定" }] }],
    ["tasks notes", "tasks", { items: [{ status: "needsAction", title: "タスク", notes: "private" }] }],
    ["tasks completed despite filter", "tasks", { items: [{ status: "completed", title: "private" }] }],
    ["tasks identifier", "tasks", { items: [{ status: "needsAction", title: "タスク", id: "private" }] }],
    ["tasks malformed due", "tasks", { items: [{ status: "needsAction", due: "not-a-date" }] }],
  ] as const)("fails closed for %s without exposing values", async (_name, service, payload) => {
    const { gateway } = makeGateway(payload);

    await expect(gateway.preview({ owner, service }, new AbortController().signal)).rejects.toEqual(
      new GoogleCalendarTasksDiagnosticError("response_validation"),
    );
  });

  it("preserves fixed credential/refresh classifications and normalizes transport failures", async () => {
    for (const reason of ["credential", "refresh"] as const) {
      const gateway = createGoogleCalendarTasksPreviewGateway({
        tokens: { getAccessToken: async () => { throw new GoogleCalendarTasksDiagnosticError(reason); } },
        transport: { get: async () => { throw new Error("must not run"); } },
      });
      await expect(gateway.preview({ owner, service: "calendar", sourceId: "primary" }, new AbortController().signal))
        .rejects.toEqual(new GoogleCalendarTasksDiagnosticError(reason));
    }

    const gateway = createGoogleCalendarTasksPreviewGateway({
      tokens: { getAccessToken: async () => "access-token" },
      transport: { get: async () => { throw new Error("private transport detail"); } },
    });
    await expect(gateway.preview({ owner, service: "tasks" }, new AbortController().signal))
      .rejects.toEqual(new GoogleCalendarTasksDiagnosticError("provider_transport"));
  });
});


describe("source selection", () => {
  it.each(["calendar", "tasks"] as const)("encodes a non-default %s source without changing host", async service => {
    const { gateway, get } = makeGateway({ items: [] });
    await gateway.preview({ owner, service, sourceId: "work/a?b#c" }, new AbortController().signal);
    expect(get.mock.calls[0]![0].url).toContain("work%2Fa%3Fb%23c");
  });
  it("rejects invalid IDs before transport", async () => {
    const { gateway, get } = makeGateway({});
    await expect(gateway.preview({ owner, service: "tasks", sourceId: "bad\n" }, new AbortController().signal)).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
  });
  it("lists readable calendars with bounded projection", async () => {
    const { gateway, get } = makeGateway({ items: [{ id: "work", summary: "仕事", accessRole: "writer" }] });
    await expect(gateway.sources({ owner, service: "calendar" }, new AbortController().signal)).resolves.toMatchObject({ items: [{ id: "work", title: "仕事" }] });
    const url = new URL(get.mock.calls[0]![0].url);
    expect(url.pathname).toBe("/calendar/v3/users/me/calendarList");
    expect(url.searchParams.get("minAccessRole")).toBe("reader");
  });
  it.each([{ nextPageToken: "more", items: [] }, { items: Array.from({length:101}, (_,i)=>({id:String(i),title:"List"})) }, {items:[{id:"x", title:"X", notes:"secret"}]}])("rejects incomplete or unexpected sources", async payload => {
    const { gateway } = makeGateway(payload);
    await expect(gateway.sources({ owner, service: "tasks" }, new AbortController().signal)).rejects.toThrow();
  });
});

it("combines accessible calendars by default and retains their names",async()=>{
 const gateway=createGoogleCalendarTasksPreviewGateway({tokens:{getAccessToken:async()=>"fixture"},now:()=>new Date("2026-09-01T00:00:00Z"),transport:{get:async request=>({status:200,contentLength:-1,json:async()=>request.url.includes("calendarList")?{items:[{id:"work",summary:"仕事",accessRole:"owner"},{id:"private",summary:"プライベート",accessRole:"reader"}]}:{items:[{summary:"予定",start:{date:"2026-09-02"}}]}})}});
 const result=await gateway.preview({owner,service:"calendar"},new AbortController().signal);
 expect(result.service).toBe("calendar");if(result.service==="calendar")expect(result.items.map(item=>item.calendar?.title)).toEqual(["仕事","プライベート"]);
});
