import { expect, test, type Page, type Route } from "playwright/test";

declare global {
  interface Window {
    __YUI_E2E_REALTIME_CLIENT__?: (dispatch: (action: {
      type: string;
      turn?: { role: "user" | "assistant"; text: string };
    }) => void) => {
      start(): Promise<void>;
      stop(): void;
      usageContext(): { sessionId: string; startedAt: string; endedAt: string };
      consumeMemoryBatch?(): {
        sessionId: string;
        sourceOccurredAt: string;
        explicitMemoryIntent: boolean;
        turns: Array<{ role: "user" | "assistant"; text: string }>;
      } | null;
    };
    __YUI_E2E_TRACE__?: string[];
    __YUI_E2E_CALL_CONTROL__?: {
      attempts(): number;
      connect(attempt: number): void;
      stops(): number;
    };
  }
}

type Profile = {
  displayName: string;
  addressingStyle: "san" | "none";
  updatedAt: string;
};

type ChatRequest = {
  kind: "opening" | "reply";
  clientMessageId: string;
  turns: Array<{ role: "user" | "assistant"; text: string }>;
};

type Viewport = { width: number; height: number };

type FakeModelOutput = {
  bubbles: string[];
  profileUpdate: {
    displayName: string | null;
    addressingStyle: Profile["addressingStyle"] | null;
  } | null;
};

const now = "2026-08-09T03:00:00.000Z";

function replyJson(clientMessageId: string, output: FakeModelOutput, authoritativeProfile?: Profile) {
  const replyGroupId = `${clientMessageId}:assistant`;
  return {
    reply: {
      replyGroupId,
      bubbles: output.bubbles.map((text, sequence) => ({
        id: `${replyGroupId}:${sequence}`,
        text,
        createdAt: now,
        sequence,
      })),
      ...(authoritativeProfile ? { profile: authoritativeProfile } : {}),
    },
  };
}

function fakeModelOutput(lastText: string | undefined, profile: Profile | null): FakeModelOutput {
  if (lastText === "最近どう？") {
    return { bubbles: ["まあまあかな", "大輝さんは今日はどうだった？"], profileUpdate: null };
  }
  if (lastText === "これから大輝って呼んで") {
    return {
      bubbles: ["うん、大輝って呼ぶね"],
      profileUpdate: { displayName: "大輝", addressingStyle: "none" },
    };
  }
  if (lastText === "今日は社長って呼んで") {
    return { bubbles: ["今日だけね、社長"], profileUpdate: null };
  }
  if (lastText === "今日は暑いね") {
    return {
      bubbles: ["ほんとに暑いね", "外に出たら一気に汗かきそう", "水分だけは忘れないでね"],
      profileUpdate: null,
    };
  }
  if (lastText === "呼び方を確認したい") {
    const addressedName = profile?.addressingStyle === "none"
      ? profile.displayName
      : `${profile?.displayName ?? ""}さん`;
    return { bubbles: [`${addressedName}、呼び捨てで話すね`], profileUpdate: null };
  }
  if (lastText === "新しい返信を待っています") {
    return {
      bubbles: ["待たせたね", "ここまで読んでたんだ", "続きは一番下に置いておくね"],
      profileUpdate: null,
    };
  }
  if (lastText === "音声入力からの一文です") {
    return { bubbles: ["音声入力も一通として届いたよ"], profileUpdate: null };
  }
  return { bubbles: ["うん、聞こえたよ"], profileUpdate: null };
}

async function writePastHistory(page: Page) {
  await page.evaluate(async () => {
    const request = indexedDB.open("yui-local");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("state", "readwrite");
    const store = transaction.objectStore("state");
    const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const get = store.get("current");
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    const filler = Array.from({ length: 18 }, (_, index) => {
      const day = index < 9 ? "06" : "07";
      const hour = String(9 + (index % 9)).padStart(2, "0");
      const createdAt = `2026-08-${day}T${hour}:00:00.000Z`;
      const userText = index === 3
        ? "図書館で昔の雑誌を見つけた"
        : `過去のメッセージ ${index + 1}。スクロール確認のための少し長い文章です。`;
      const assistantText = index === 14
        ? "図書館の話、また聞きたいな"
        : `ユイの過去の返事 ${index + 1}。同じ部屋に履歴が続いています。`;
      return [
        { id: `past-user-${index}`, type: "message", role: "user", text: userText, createdAt, delivery: "sent" },
        { id: `past-yui-${index}`, type: "message", role: "assistant", text: assistantText, createdAt, delivery: "sent" },
      ];
    }).flat();
    snapshot.timeline = [...filler, ...(snapshot.timeline as Array<Record<string, unknown>>)];
    store.put(snapshot, "current");
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
}

async function waitForPersistedMessage(page: Page, text: string) {
  await expect.poll(() => page.evaluate(async (expectedText) => {
    const request = indexedDB.open("yui-local");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("state", "readonly");
    const get = transaction.objectStore("state").get("current");
    const snapshot = await new Promise<Record<string, unknown>>((resolve, reject) => {
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
    });
    database.close();
    return (snapshot.timeline as Array<{ text?: string }>).some((item) => item.text === expectedText);
  }, text)).toBe(true);
}

async function revealFirstBubble(page: Page, text: string) {
  await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  await page.clock.runFor(399);
  await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

async function expectMobileFrame(page: Page, width: number, height: number) {
  const geometry = await page.evaluate(() => {
    const frame = document.querySelector<HTMLElement>(".chat-screen")!;
    const scrollArea = document.querySelector<HTMLElement>(".chat-scroll-area")!;
    const frameRect = frame.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      frameLeft: frameRect.left,
      frameRight: frameRect.right,
      frameHeight: frameRect.height,
      internalScrollDistance: scrollArea.scrollHeight - scrollArea.clientHeight,
    };
  });
  expect(geometry.viewportWidth).toBe(width);
  expect(geometry.viewportHeight).toBe(height);
  expect(geometry.documentWidth).toBeLessThanOrEqual(width);
  expect(geometry.frameLeft).toBeGreaterThanOrEqual(0);
  expect(geometry.frameRight).toBeLessThanOrEqual(width);
  expect(geometry.frameHeight).toBe(height);
  expect(geometry.internalScrollDistance).toBeGreaterThan(96);
}

async function expectTimelineDateAndTimes(page: Page) {
  await expect(page.getByText("8月9日（日）", { exact: true })).toHaveCount(1);
  await expect(page.getByText(/8月9日（日）\s+12:00/u)).toHaveCount(0);

  const userRow = page.locator("li.chat-message.is-user", { hasText: "最近どう？" });
  const assistantRow = page.locator("li.chat-message.is-assistant", { hasText: "まあまあかな" });
  await expect(userRow.locator("time.chat-message-time")).toHaveText("12:00");
  await expect(assistantRow.locator("time.chat-message-time")).toHaveText("12:00");
  expect(await userRow.locator(".chat-message-row").evaluate((row) =>
    [...row.children].map((child) => child.tagName),
  )).toEqual(["TIME", "P"]);
  expect(await assistantRow.locator(".chat-message-row").evaluate((row) =>
    [...row.children].map((child) => child.tagName),
  )).toEqual(["P", "TIME"]);
}

async function expectHeaderGeometryAndFocus(page: Page, width: number) {
  const geometry = await page.locator(".chat-header").evaluate((header) => {
    const frameRect = document.querySelector<HTMLElement>(".chat-screen")!.getBoundingClientRect();
    const titleRect = header.querySelector("h1")!.getBoundingClientRect();
    const controls = [...header.querySelectorAll<HTMLButtonElement>("button")].map((button) => {
      const rect = button.getBoundingClientRect();
      return { label: button.getAttribute("aria-label"), width: rect.width, height: rect.height, left: rect.left, right: rect.right };
    });
    return {
      titleCenterDelta: Math.abs((titleRect.left + titleRect.right) / 2 - (frameRect.left + frameRect.right) / 2),
      controls,
    };
  });
  expect(geometry.controls).toHaveLength(3);
  expect(geometry.controls.map((control) => control.label)).toEqual(["設定を開く", "履歴を検索", "ユイに電話する"]);
  expect(geometry.titleCenterDelta).toBeLessThanOrEqual(1);
  for (const control of geometry.controls) {
    expect(control.width).toBeGreaterThanOrEqual(44);
    expect(control.height).toBeGreaterThanOrEqual(44);
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(width);
  }

  for (const label of ["設定を開く", "履歴を検索", "ユイに電話する"]) {
    const target = page.getByRole("button", { name: label });
    await target.focus();
    const focus = await target.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        active: document.activeElement === element,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        outlineColor: style.outlineColor,
      };
    });
    expect(focus.active).toBe(true);
    expect(focus.outlineStyle).toBe("solid");
    expect(focus.outlineWidth).toBeGreaterThanOrEqual(3);
    expect(focus.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
  }

  const composer = page.getByRole("textbox", { name: "メッセージ" });
  await composer.focus();
  const composerFocus = await composer.evaluate((element) => {
    const shell = element.closest<HTMLElement>(".composer-shell");
    if (!shell) throw new Error("composer shell missing");
    const rect = shell.getBoundingClientRect();
    const style = getComputedStyle(shell);
    return {
      active: document.activeElement === element,
      left: rect.left,
      right: rect.right,
      borderColor: style.borderColor,
      boxShadow: style.boxShadow,
    };
  });
  expect(composerFocus.active).toBe(true);
  expect(composerFocus.left).toBeGreaterThanOrEqual(14);
  expect(composerFocus.right).toBeLessThanOrEqual(width - 14);
  expect(composerFocus.borderColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(composerFocus.boxShadow).not.toBe("none");
}

async function expectFourLineComposer(page: Page, height: number) {
  const composer = page.getByRole("textbox", { name: "メッセージ" });
  await composer.fill("一行目\n二行目\n三行目");
  await composer.press("Shift+Enter");
  await composer.type("四行目");
  await expect(composer).toHaveValue("一行目\n二行目\n三行目\n四行目");
  const geometry = await composer.evaluate((textarea) => {
    const rect = textarea.getBoundingClientRect();
    const style = getComputedStyle(textarea);
    return {
      lineCount: textarea.value.split("\n").length,
      top: rect.top,
      bottom: rect.bottom,
      scrollHeight: textarea.scrollHeight,
      maxHeight: Number.parseFloat(style.maxHeight),
    };
  });
  expect(geometry.lineCount).toBe(4);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(height);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.maxHeight);
  await composer.fill("");
}

async function finishProgrammaticScroll(page: Page) {
  await page.clock.runFor(2_000);
  await page.clock.resume();
}

async function expectSearchTouchTargets(page: Page) {
  const searchbox = page.getByRole("searchbox", { name: "チャット履歴を検索" });
  await expect(searchbox).toBeFocused();
  const focus = await searchbox.evaluate((element) => {
    const style = getComputedStyle(element);
    const colorProbe = document.createElement("span");
    colorProbe.style.color = "var(--yui-primary)";
    document.body.append(colorProbe);
    const expectedBorderColor = getComputedStyle(colorProbe).color;
    colorProbe.remove();
    return {
      borderColor: style.borderColor,
      expectedBorderColor,
      boxShadow: style.boxShadow,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(focus.borderColor).toBe(focus.expectedBorderColor);
  expect(focus.boxShadow).toBe("none");
  expect(focus.outlineWidth).toBe(0);
  const targets = await page.locator(".chat-search button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  expect(targets).toHaveLength(3);
  for (const target of targets) {
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
  }
}

async function openFakePwaChat(page: Page) {
  let profile: Profile | null = null;
  await page.route("**/api/profile", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", json: { profile } });
      return;
    }
    const input = route.request().postDataJSON() as Pick<Profile, "displayName" | "addressingStyle">;
    profile = { ...input, updatedAt: now };
    await route.fulfill({ contentType: "application/json", json: { profile } });
  });
  await page.addInitScript(() => {
    type Dispatch = Parameters<NonNullable<Window["__YUI_E2E_REALTIME_CLIENT__"]>>[0];
    const dispatches: Dispatch[] = [];
    let stopCount = 0;
    window.__YUI_E2E_CALL_CONTROL__ = {
      attempts: () => dispatches.length,
      connect: (attempt) => dispatches[attempt]?.({ type: "connected" }),
      stops: () => stopCount,
    };
    window.__YUI_E2E_REALTIME_CLIENT__ = (dispatch) => {
      const attempt = dispatches.push(dispatch) - 1;
      return {
        async start() {},
        stop() {
          stopCount += 1;
          dispatches[attempt]?.({ type: "stopped" });
        },
        usageContext() {
          return {
            sessionId: `fake-pwa-call-${attempt + 1}`,
            startedAt: "2026-08-11T03:00:00.000Z",
            endedAt: "2026-08-11T03:01:00.000Z",
          };
        },
      };
    };
  });

  await page.goto("/");
  await page.getByLabel("あなたの名前").fill("大輝");
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByRole("button", { name: "ユイに電話する" })).toBeVisible();
}

async function connectFakePwaCall(page: Page, attempt: number) {
  await expect.poll(() => page.evaluate(() => window.__YUI_E2E_CALL_CONTROL__?.attempts())).toBe(attempt + 1);
  await page.evaluate((attemptIndex) => window.__YUI_E2E_CALL_CONTROL__?.connect(attemptIndex), attempt);
  await expect(page.getByRole("button", { name: "今日はここまで" })).toBeVisible();
  await expect(page.getByText("マイク使用中", { exact: true })).toBeVisible();
}

async function endFakePwaCall(page: Page) {
  await page.getByRole("button", { name: "今日はここまで" }).click();
  await expect(page.getByRole("button", { name: "ユイに電話する" })).toBeVisible();
  await expect(page.getByText("ユイと1分話しました", { exact: true })).toHaveCount(1);
}

async function runEndlessRoomJourney(page: Page, viewport: Viewport): Promise<void> {
  let profile: Profile | null = null;
  const chatBodies: ChatRequest[] = [];
  const profileWrites: Array<{ displayName: string; addressingStyle: "san" | "none" }> = [];
  const routeTrace: string[] = [];
  const unexpectedApiRequests: string[] = [];
  const ttsRequests: string[] = [];
  let releaseFollowReply: (() => void) | undefined;

  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/tts/")) ttsRequests.push(request.url());
  });

  await page.route("**/api/**", async (route: Route) => {
    unexpectedApiRequests.push(`${route.request().method()} ${route.request().url()}`);
    await route.abort("blockedbyclient");
  });
  await page.route("**/api/profile", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ contentType: "application/json", json: { profile } });
      return;
    }
    const input = route.request().postDataJSON() as { displayName: string; addressingStyle: "san" | "none" };
    profileWrites.push(input);
    profile = { ...input, updatedAt: now };
    await route.fulfill({ contentType: "application/json", json: { profile } });
  });
  await page.route("**/api/chat/responses", async (route) => {
    const body = route.request().postDataJSON() as ChatRequest;
    chatBodies.push(body);
    const lastText = body.turns.at(-1)?.text;
    if (lastText === "新しい返信を待っています") {
      await new Promise<void>((resolve) => { releaseFollowReply = resolve; });
    }
    const modelOutput = fakeModelOutput(lastText, profile);
    let authoritativeProfile: Profile | undefined;
    if (modelOutput.profileUpdate && profile) {
      profile = {
        displayName: modelOutput.profileUpdate.displayName ?? profile.displayName,
        addressingStyle: modelOutput.profileUpdate.addressingStyle ?? profile.addressingStyle,
        updatedAt: now,
      };
      authoritativeProfile = profile;
    }
    await route.fulfill({
      contentType: "application/json",
      json: replyJson(body.clientMessageId, modelOutput, authoritativeProfile),
    });
  });
  await page.route("**/api/chat/transcriptions", async (route) => {
    routeTrace.push("transcription");
    await route.fulfill({ contentType: "application/json", json: { text: "音声入力からの一文です" } });
  });
  await page.route("**/api/memories", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { memories: [] } });
  });
  await page.route("**/api/memory/process", async (route) => {
    const body = route.request().postDataJSON() as { sourceMessageId: string };
    await route.fulfill({ status: 202, contentType: "application/json", json: { sourceMessageId: body.sourceMessageId, state: "completed", appliedCount: 0 } });
  });
  await page.route("**/api/memory-settings", async (route) => {
    await route.fulfill({ contentType: "application/json", json: { settings: { automaticMemoryEnabled: true, recallMemoryEnabled: true, voiceMemoryEnabled: true, updatedAt: null } } });
  });
  await page.route("**/api/realtime/calls", async (route) => {
    routeTrace.push("realtime");
    await route.fulfill({ status: 201, body: "fake-answer" });
  });
  await page.addInitScript(() => {
    const trace: string[] = [];
    window.__YUI_E2E_TRACE__ = trace;

    const fakeTrack = { stop() { trace.push("media-track-stopped"); } };
    let mediaAttempts = 0;
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        async getUserMedia() {
          mediaAttempts += 1;
          trace.push(`get-user-media:${mediaAttempts}`);
          if (mediaAttempts === 1) throw new DOMException("permission denied", "NotAllowedError");
          return { getTracks: () => [fakeTrack] };
        },
      },
    });

    class FakeMediaRecorder {
      static isTypeSupported(type: string) { return type === "audio/webm"; }
      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;
      start() { this.state = "recording"; trace.push("media-recorder-start"); }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["fake audio"], { type: "audio/webm" }) } as BlobEvent);
        this.onstop?.(new Event("stop"));
        trace.push("media-recorder-stop");
      }
    }
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });

    type Dispatch = (action: { type: string; turn?: { role: "user" | "assistant"; text: string } }) => void;
    let dispatch: Dispatch | undefined;
    window.__YUI_E2E_REALTIME_CLIENT__ = (nextDispatch) => {
      dispatch = nextDispatch;
      return {
        async start() {
          trace.push("microphone");
          await fetch("/api/realtime/calls", { method: "POST", body: "fake-offer" });
          trace.push("realtime", "marin-remote-audio");
          dispatch?.({ type: "connected" });
          dispatch?.({ type: "transcript", turn: { role: "user", text: "今日は公園を歩いた" } });
          dispatch?.({ type: "speaking" });
          dispatch?.({ type: "transcript", turn: { role: "assistant", text: "散歩の話、覚えておくね" } });
          dispatch?.({ type: "listening" });
        },
        stop() { dispatch?.({ type: "stopped" }); },
        usageContext() {
          return {
            sessionId: "fake-call",
            startedAt: "2026-08-09T03:05:00.000Z",
            endedAt: "2026-08-09T03:06:00.000Z",
          };
        },
      };
    };
  });

  await page.setViewportSize(viewport);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "YUI" })).toBeVisible({ timeout: 10_000 });
  await page.clock.install({ time: now });
  const initialPauseTime = await page.evaluate(() => Date.now() + 100);
  await page.clock.pauseAt(initialPauseTime);

  await page.getByLabel("あなたの名前").fill("大輝");
  await page.getByLabel("あなたの名前").press("Enter");
  await expect(page.getByRole("status", { name: "ユイが入力中" })).toBeVisible();
  await expect(page.getByText("大輝さん、はじめまして", { exact: true })).toHaveCount(0);
  await page.clock.runFor(1_799);
  await expect(page.getByRole("status", { name: "ユイが入力中" })).toBeVisible();
  await expect(page.getByText("大輝さん、はじめまして", { exact: true })).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(page.getByText("大輝さん、はじめまして", { exact: true })).toBeVisible();
  await expect(page.getByRole("status", { name: "ユイが入力中" })).toHaveCount(0);
  await expect(page.getByText("これからよろしくね", { exact: true })).toHaveCount(0);
  await page.clock.runFor(599);
  await expect(page.getByText("これからよろしくね", { exact: true })).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(page.getByText("これからよろしくね", { exact: true })).toBeVisible();
  expect(profileWrites).toEqual([{ displayName: "大輝", addressingStyle: "san" }]);

  const composer = page.getByRole("textbox", { name: "メッセージ" });
  await test.step("keeps plain Enter as a newline and sends that newline only through the arrow", async () => {
    const chatsBeforeEnter = chatBodies.length;
    await composer.fill("");
    await composer.press("Enter");
    await expect(composer).toHaveValue("\n");
    expect(chatBodies).toHaveLength(chatsBeforeEnter);

    await composer.fill("Enterは");
    await composer.press("Enter");
    await expect(composer).toHaveValue("Enterは\n");
    expect(chatBodies).toHaveLength(chatsBeforeEnter);
    await composer.type("改行になる");
    const newlineResponse = page.waitForResponse("**/api/chat/responses");
    await page.getByRole("button", { name: "メッセージを送信" }).click();
    await newlineResponse;
    expect(chatBodies).toHaveLength(chatsBeforeEnter + 1);
    expect(chatBodies.at(-1)?.turns.at(-1)?.text).toBe("Enterは\n改行になる");
    await waitForPersistedMessage(page, "うん、聞こえたよ");
    await revealFirstBubble(page, "うん、聞こえたよ");
  });

  await composer.fill("最近どう？");
  const casualResponse = page.waitForResponse("**/api/chat/responses");
  await page.getByRole("button", { name: "メッセージを送信" }).click();
  await casualResponse;
  await waitForPersistedMessage(page, "まあまあかな");
  await revealFirstBubble(page, "まあまあかな");
  await expect(page.getByText("大輝さんは今日はどうだった？", { exact: true })).toHaveCount(0);
  await page.clock.runFor(349);
  await expect(page.getByText("大輝さんは今日はどうだった？", { exact: true })).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(page.getByText("大輝さんは今日はどうだった？", { exact: true })).toBeVisible();
  await expectTimelineDateAndTimes(page);

  await composer.fill("これから大輝って呼んで");
  const lastingProfileResponse = page.waitForResponse("**/api/chat/responses");
  await page.getByRole("button", { name: "メッセージを送信" }).click();
  await lastingProfileResponse;
  await revealFirstBubble(page, "うん、大輝って呼ぶね");
  await page.getByRole("button", { name: "設定を開く" }).click();
  await expect(page.getByRole("heading", { name: "設定" })).toBeVisible();
  await expect(page.getByLabel("あなたの名前")).toHaveValue("大輝");
  await page.getByRole("button", { name: "チャットに戻る" }).click();

  await composer.fill("今日は社長って呼んで");
  const temporaryNicknameResponse = page.waitForResponse("**/api/chat/responses");
  await page.getByRole("button", { name: "メッセージを送信" }).click();
  await temporaryNicknameResponse;
  await revealFirstBubble(page, "今日だけね、社長");
  await page.getByRole("button", { name: "設定を開く" }).click();
  await expect(page.getByLabel("あなたの名前")).toHaveValue("大輝");
  await expect(page.getByLabel("あなたの名前")).not.toHaveValue("社長");
  await page.getByRole("button", { name: "チャットに戻る" }).click();
  expect(profileWrites).toEqual([{ displayName: "大輝", addressingStyle: "san" }]);

  const pauseTime = await page.evaluate(() => Date.now() + 1_000);
  await page.clock.pauseAt(pauseTime);
  const chatsBeforeComposition = chatBodies.length;
  await composer.fill("今日は暑いね");
  await composer.dispatchEvent("compositionstart");
  await composer.press("Enter");
  expect(chatBodies).toHaveLength(chatsBeforeComposition);
  await composer.dispatchEvent("compositionend");
  await composer.fill("今日は暑いね");
  const groupedResponse = page.waitForResponse("**/api/chat/responses");
  await page.getByRole("button", { name: "メッセージを送信" }).click();
  await groupedResponse;
  await expect.poll(() => chatBodies.length).toBe(chatsBeforeComposition + 1);
  expect(chatBodies.at(-1)?.turns.at(-1)?.text).toBe("今日は暑いね");
  await waitForPersistedMessage(page, "ほんとに暑いね");
  await revealFirstBubble(page, "ほんとに暑いね");
  await expect(page.getByText("外に出たら一気に汗かきそう", { exact: true })).toHaveCount(0);
  await expect(page.getByText("水分だけは忘れないでね", { exact: true })).toHaveCount(0);
  await page.clock.runFor(349);
  await expect(page.getByText("外に出たら一気に汗かきそう", { exact: true })).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(page.getByText("外に出たら一気に汗かきそう", { exact: true })).toBeVisible();
  await expect(page.getByText("水分だけは忘れないでね", { exact: true })).toHaveCount(0);
  await page.clock.runFor(349);
  await expect(page.getByText("水分だけは忘れないでね", { exact: true })).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(page.getByText("水分だけは忘れないでね", { exact: true })).toBeVisible();
  await expect(page.getByText("今日は暑いね", { exact: true })).toHaveCount(1);
  await page.clock.resume();

  await composer.fill("呼び方を確認したい");
  await page.getByRole("button", { name: "メッセージを送信" }).click();
  await expect(page.getByText("大輝、呼び捨てで話すね", { exact: true })).toBeVisible();
  await expect(page.getByText("大輝さん、呼び捨てで話すね", { exact: true })).toHaveCount(0);

  await writePastHistory(page);
  await page.reload();
  await expect(page.getByText("図書館で昔の雑誌を見つけた", { exact: true })).toHaveCount(1);
  await expect(page.getByText("図書館の話、また聞きたいな", { exact: true })).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "YUI" })).toBeVisible();
  await expect(page.getByLabel("あなたの名前")).toHaveCount(0);
  await expectMobileFrame(page, viewport.width, viewport.height);
  await expectHeaderGeometryAndFocus(page, viewport.width);
  const chatsBeforeFourLines = chatBodies.length;
  await expectFourLineComposer(page, viewport.height);
  expect(chatBodies).toHaveLength(chatsBeforeFourLines);

  const scrollArea = page.getByTestId("chat-scroll-area");
  await page.getByTestId("message-past-user-11").evaluate((element) => element.scrollIntoView({ block: "center" }));
  const anchorBeforeSearch = await scrollArea.evaluate((container) => {
    const containerRect = container.getBoundingClientRect();
    const candidates = [...container.querySelectorAll<HTMLElement>("[data-testid^='message-']")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom >= containerRect.top && rect.top <= containerRect.bottom;
      })
      .map((element) => ({ id: element.dataset.testid!, distance: Math.abs(element.getBoundingClientRect().top - containerRect.top) }));
    return candidates.sort((left, right) => left.distance - right.distance)[0]!.id;
  });
  await page.getByRole("button", { name: "履歴を検索" }).click();
  await expectSearchTouchTargets(page);
  await page.getByRole("searchbox", { name: "チャット履歴を検索" }).fill("最近どう？");
  await expect(page.locator(".chat-search output")).toHaveText("1 / 1");
  await page.getByRole("searchbox", { name: "チャット履歴を検索" }).fill("12:00");
  await expect(page.locator(".chat-search output")).toHaveText("0 / 0");
  await page.getByRole("searchbox", { name: "チャット履歴を検索" }).fill("図書館");
  await expect(page.locator(".chat-search output")).toHaveText(/^[12] \/ 2$/u);
  const initialResult = await page.locator(".chat-search output").textContent();
  if (initialResult === "1 / 2") await page.getByRole("button", { name: "次の検索結果" }).click();
  else await page.getByRole("button", { name: "前の検索結果" }).click();
  await expect(page.locator(".chat-search output")).not.toHaveText(initialResult ?? "");
  await page.getByRole("searchbox", { name: "チャット履歴を検索" }).fill("該当しない言葉");
  await expect(page.locator(".chat-search output")).toHaveText("0 / 0");
  await page.getByRole("button", { name: "検索を閉じる" }).click();
  await finishProgrammaticScroll(page);
  await expect.poll(async () => page.getByTestId(anchorBeforeSearch).evaluate((element) => {
    const container = element.closest("[data-testid='chat-scroll-area']")!;
    const containerRect = container.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    return rect.bottom >= containerRect.top && rect.top <= containerRect.bottom;
  }), { timeout: 3_000 }).toBe(true);
  await scrollArea.dispatchEvent("scroll");

  await scrollArea.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect(page.getByRole("button", { name: "最新のメッセージへ移動" })).toHaveCount(0);
  await composer.fill("新しい返信を待っています");
  await page.getByRole("button", { name: "メッセージを送信" }).click();
  await expect.poll(() => typeof releaseFollowReply).toBe("function");
  await expect(page.getByText("新しい返信を待っています", { exact: true })).toBeVisible();
  await scrollArea.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(async () => scrollArea.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(24);
  await scrollArea.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 180);
    element.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(async () => scrollArea.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThan(96);
  const scrollTopBeforeReply = await scrollArea.evaluate((element) => element.scrollTop);
  releaseFollowReply?.();
  await expect(page.getByText("続きは一番下に置いておくね", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "最新のメッセージへ移動" })).toHaveCount(1);
  const unreadPlacement = await page.getByRole("button", { name: "最新のメッセージへ移動" }).evaluate((button) => {
    const buttonRect = button.getBoundingClientRect();
    const composerRect = document.querySelector<HTMLElement>(".chat-composer")!.getBoundingClientRect();
    return { buttonBottom: buttonRect.bottom, composerTop: composerRect.top };
  });
  expect(unreadPlacement.buttonBottom).toBeLessThanOrEqual(unreadPlacement.composerTop);
  await expect.poll(async () => scrollArea.evaluate(
    (element, previousScrollTop) => Math.abs(element.scrollTop - previousScrollTop),
    scrollTopBeforeReply,
  )).toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "最新のメッセージへ移動" }).click();
  await expect.poll(async () => scrollArea.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(24);
  await expect(page.getByRole("button", { name: "最新のメッセージへ移動" })).toHaveCount(0);

  await page.getByRole("button", { name: "音声入力を開始" }).click();
  await expect(page.getByRole("status")).toContainText("iPhoneの設定でYUIのマイクを許可して、もう一度お試しください。");
  await page.getByRole("button", { name: "もう一度試す" }).click();
  await expect(page.getByRole("button", { name: "音声入力を停止" })).toBeVisible();
  await page.getByRole("button", { name: "録音を送信" }).click();
  await expect.poll(() => chatBodies.filter((body) => body.turns.at(-1)?.text === "音声入力からの一文です").length).toBe(1);
  await expect(page.getByText("音声入力からの一文です", { exact: true })).toHaveCount(1);
  await expect(page.getByText("音声入力も一通として届いたよ", { exact: true })).toBeVisible();
  expect(routeTrace.filter((entry) => entry === "transcription")).toHaveLength(1);

  await page.getByRole("button", { name: "ユイに電話する" }).click();
  await expect(page.getByRole("button", { name: "今日はここまで" })).toBeVisible();
  await expect(page.getByText("散歩の話、覚えておくね", { exact: true })).toBeVisible();
  await page.getByText("文字起こし", { exact: true }).click();
  await expect(page.getByText("あなた：今日は公園を歩いた", { exact: true })).toBeVisible();
  await expect(page.getByText("ユイ：散歩の話、覚えておくね", { exact: true })).toBeVisible();
  expect(routeTrace.at(-1)).toBe("realtime");
  expect(await page.evaluate(() => window.__YUI_E2E_TRACE__?.slice(-3))).toEqual(["microphone", "realtime", "marin-remote-audio"]);
  await page.getByRole("button", { name: "今日はここまで" }).click();
  await expect(page.getByText("ユイと1分話しました")).toHaveCount(1);
  await expectMobileFrame(page, viewport.width, viewport.height);

  expect(chatBodies.filter((body) => body.kind === "opening")).toHaveLength(0);
  expect(ttsRequests).toEqual([]);
  expect(unexpectedApiRequests).toEqual([]);
}

for (const viewport of [
  { width: 320, height: 700 },
  { width: 390, height: 844 },
]) {
  test(`covers YUI's complete endless-room journey at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await runEndlessRoomJourney(page, viewport);
  });
}

test("PWA call shows preparation before connecting and returns to chat after ending", async ({ page }) => {
  await openFakePwaChat(page);

  await page.getByRole("button", { name: "ユイに電話する" }).click();
  await expect(page.getByRole("status", { name: "ユイとの通話を接続中" })).toBeVisible();
  await connectFakePwaCall(page, 0);
  await endFakePwaCall(page);
});

test("PWA call times out at twelve seconds and succeeds on retry", async ({ page }) => {
  await openFakePwaChat(page);
  await page.clock.install({ time: now });

  await page.getByRole("button", { name: "ユイに電話する" }).click();
  await expect(page.getByRole("status", { name: "ユイとの通話を接続中" })).toBeVisible();
  await page.clock.runFor(12_000);
  await expect(page.getByRole("button", { name: "通話をもう一度試す" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__YUI_E2E_CALL_CONTROL__?.stops())).toBe(1);
  await page.getByRole("button", { name: "通話をもう一度試す" }).click();
  await expect(page.getByRole("status", { name: "ユイとの通話を接続中" })).toBeVisible();
  await connectFakePwaCall(page, 1);
  await endFakePwaCall(page);
});

test("private hosted journey keeps one user's YUI data isolated and preserves only a draft across expiry", async ({ page }) => {
  test.skip(
    !process.env.VITE_SUPABASE_URL ||
      !process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      !process.env.VITE_YUI_API_BASE_URL,
    "Hosted browser values are required because Vite selects the hosted app at server startup",
  );
  const hostedNow = "2026-08-10T06:30:00.000Z";
  const profiles = new Map<string, Profile>();
  const snapshots = new Map<string, Record<string, unknown>>();
  let expireNextProfileWrite = false;
  const cors = { "access-control-allow-origin": `http://127.0.0.1:${process.env.YUI_E2E_PORT ?? "4311"}` };

  const tokenFor = (email: string) => email === "owner@example.com" ? "token-owner" : "token-other";
  await page.route("https://supabase.yui.invalid/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/otp")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    if (pathname.endsWith("/verify") || pathname.endsWith("/token")) {
      const body = request.postDataJSON() as { email?: string } | null;
      const email = body?.email ?? "owner@example.com";
      const token = tokenFor(email);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          access_token: token,
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: `refresh-${token}`,
          user: { id: token === "token-owner" ? "user-owner" : "user-other", email, aud: "authenticated", role: "authenticated" },
        },
      });
      return;
    }
    if (pathname.endsWith("/logout")) {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await page.route("https://api.yui.invalid/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const token = request.headers().authorization?.replace("Bearer ", "") ?? "";
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    if (token !== "token-owner") {
      await route.fulfill({ status: 401, contentType: "application/json", headers: cors, json: { error: "Unauthorized" } });
      return;
    }
    if (pathname === "/api/profile" && request.method() === "PUT" && expireNextProfileWrite) {
      expireNextProfileWrite = false;
      await route.fulfill({ status: 401, contentType: "application/json", headers: cors, json: { error: "Unauthorized" } });
      return;
    }
    if (pathname === "/api/profile" && request.method() === "GET") {
      await route.fulfill({ contentType: "application/json", headers: cors, json: { profile: profiles.get(token) ?? null } });
      return;
    }
    if (pathname === "/api/profile" && request.method() === "PUT") {
      const input = request.postDataJSON() as { displayName: string; addressingStyle: "san" | "none" };
      const saved = { ...input, updatedAt: hostedNow };
      profiles.set(token, saved);
      await route.fulfill({ contentType: "application/json", headers: cors, json: { profile: saved } });
      return;
    }
    if (pathname === "/api/chat-state" && request.method() === "GET") {
      await route.fulfill({ contentType: "application/json", headers: cors, json: { snapshot: snapshots.get(token) ?? { timeline: [], lastOpeningAt: null, lastConversationAt: null, version: 2, revision: 0, updatedAt: hostedNow } } });
      return;
    }
    if (pathname === "/api/chat-state" && request.method() === "PUT") {
      const input = request.postDataJSON() as { expectedRevision: number; snapshot: Record<string, unknown> };
      const saved = { ...input.snapshot, revision: input.expectedRevision + 1, updatedAt: hostedNow };
      snapshots.set(token, saved);
      await route.fulfill({ contentType: "application/json", headers: cors, json: { snapshot: saved } });
      return;
    }
    if (pathname === "/api/chat/responses") {
      const input = request.postDataJSON() as { clientMessageId: string };
      const replyGroupId = `${input.clientMessageId}:assistant`;
      await route.fulfill({ contentType: "application/json", headers: cors, json: { reply: { replyGroupId, bubbles: [{ id: `${replyGroupId}:0`, text: "クラウドで覚えたよ", createdAt: hostedNow, sequence: 0 }] } } });
      return;
    }
    if (pathname === "/api/memories") {
      await route.fulfill({ contentType: "application/json", headers: cors, json: { memories: [] } });
      return;
    }
    if (pathname === "/api/memory/process") {
      const input = request.postDataJSON() as { sourceMessageId: string };
      await route.fulfill({ status: 202, contentType: "application/json", headers: cors, json: { sourceMessageId: input.sourceMessageId, state: "completed", appliedCount: 0 } });
      return;
    }
    if (pathname === "/api/memory-settings") {
      await route.fulfill({ contentType: "application/json", headers: cors, json: { settings: { automaticMemoryEnabled: true, recallMemoryEnabled: true, voiceMemoryEnabled: true, updatedAt: null } } });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", headers: cors, json: { error: "not_found" } });
  });

  const login = async (email: string) => {
    await page.getByLabel("メールアドレス").fill(email);
    await page.getByLabel("パスワード").fill("fake-owner-password");
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
  };

  await page.goto("/");
  await login("owner@example.com");
  await page.getByLabel("あなたの名前").fill("大輝");
  await page.getByRole("button", { name: "はじめる" }).click();
  await expect(page.getByRole("button", { name: "設定を開く" })).toBeVisible();
  await page.getByRole("textbox", { name: "メッセージ" }).fill("同期確認");
  await page.getByRole("button", { name: "メッセージを送信" }).click();
  await expect(page.getByText("クラウドで覚えたよ", { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByText("クラウドで覚えたよ", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "メッセージ" }).fill("消さない下書き");
  expireNextProfileWrite = true;
  await page.getByRole("button", { name: "設定を開く" }).click();
  await page.getByLabel("あなたの名前").fill("期限切れテスト");
  await page.getByRole("button", { name: "保存する" }).click();
  await expect(page.getByLabel("メールアドレス")).toBeVisible();

  await login("owner@example.com");
  await expect(page.getByRole("textbox", { name: "メッセージ" })).toHaveValue("消さない下書き");
  await page.getByRole("button", { name: "設定を開く" }).click();
  await page.getByRole("button", { name: "ログアウト" }).click();
  await login("other@example.com");
  await expect(page.getByLabel("メールアドレス")).toBeVisible();
  await expect(page.getByText("クラウドで覚えたよ", { exact: true })).toHaveCount(0);
});

test("private hosted owner completes the stateful memory journey without duplicate storage or cost", async ({ page }) => {
  test.skip(
    !process.env.VITE_SUPABASE_URL ||
      !process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      !process.env.VITE_YUI_API_BASE_URL,
    "Hosted browser values are required because Vite selects the hosted app at server startup",
  );
  const hostedNow = "2026-08-10T06:30:00.000Z";
  const ownerToken = "token-owner";
  const normalMemoryId = "10000000-0000-4000-8000-000000000001";
  const sensitiveMemoryId = "10000000-0000-4000-8000-000000000002";
  const tombstoneId = "20000000-0000-4000-8000-000000000001";
  const normalInitialContent = "朝は紅茶が好き";
  const normalEditedContent = "朝はカフェラテが好き";
  const sensitiveContent = "偏頭痛で通院している";
  type HostedMemory = {
    id: string;
    kind: "preference" | "shared";
    scope: "shared";
    content: string;
    normalizedContent: string;
    status: "active";
    origin: "extracted" | "explicit";
    sensitivity: "normal" | "sensitive";
    importance: 3;
    sourceMessageId: string | null;
    sourceOccurredAt: string | null;
    validFrom: null;
    validUntil: null;
    expiresAt: null;
    pinned: boolean;
    supersedesId: null;
    createdAt: string;
    updatedAt: string;
  };
  const makeMemory = (input: Pick<HostedMemory, "id" | "content" | "sensitivity" | "origin" | "sourceMessageId">): HostedMemory => ({
    ...input,
    kind: input.sensitivity === "sensitive" ? "shared" : "preference",
    scope: "shared",
    normalizedContent: input.content.replace(/\s/gu, ""),
    status: "active",
    importance: 3,
    sourceOccurredAt: hostedNow,
    validFrom: null,
    validUntil: null,
    expiresAt: null,
    pinned: input.origin === "explicit",
    supersedesId: null,
    createdAt: hostedNow,
    updatedAt: hostedNow,
  });

  const profiles = new Map<string, Profile>();
  const snapshots = new Map<string, Record<string, unknown>>();
  const processAttempts = new Map<string, number>();
  const processedSourceIds = new Set<string>();
  const chargedSourceIds = new Set<string>();
  const settingsPatchKeys: string[] = [];
  const retrievedMemoryContents: string[][] = [];
  const realtimeMemoryValues: Array<string | null> = [];
  const chatSourceIds = new Map<string, string>();
  let activeMemory: HostedMemory | null = null;
  const sensitiveMemory = makeMemory({
    id: sensitiveMemoryId,
    content: sensitiveContent,
    sensitivity: "sensitive",
    origin: "explicit",
    sourceMessageId: null,
  });
  let tombstone: { id: string; memoryId: string | null; createdAt: string } | null = null;
  let settings = {
    automaticMemoryEnabled: true,
    recallMemoryEnabled: true,
    voiceMemoryEnabled: true,
    updatedAt: hostedNow,
  };
  let firstMemorySourceId: string | null = null;
  let memoryWrites = 0;
  let realtimeMemoryReads = 0;
  let sensitiveRetrievalCount = 0;
  let secretRejections = 0;
  const cors = { "access-control-allow-origin": `http://127.0.0.1:${process.env.YUI_E2E_PORT ?? "4311"}` };

  await page.addInitScript(() => {
    let callSequence = 0;
    window.__YUI_E2E_REALTIME_CLIENT__ = (dispatch) => {
      const sessionId = `fake-hosted-call-${++callSequence}`;
      let memoryBatchConsumed = false;
      return {
      async start() {
        const response = await fetch("https://api.yui.invalid/api/e2e/realtime-memory", {
          headers: { authorization: "Bearer token-owner" },
        });
        const payload = await response.json() as { memory: string | null };
        dispatch({ type: "connected" });
        dispatch({ type: "transcript", turn: { role: "user", text: "逐語保存しない電話の発言" } });
        dispatch({ type: "transcript", turn: { role: "assistant", text: payload.memory ? `電話でも${payload.memory}だね` : "電話では記憶を使っていないよ" } });
      },
      stop() { dispatch({ type: "stopped" }); },
      usageContext() { return { sessionId, startedAt: "2026-08-10T06:31:00.000Z", endedAt: "2026-08-10T06:32:00.000Z" }; },
      consumeMemoryBatch() {
        if (memoryBatchConsumed) return null;
        memoryBatchConsumed = true;
        return {
          sessionId,
          sourceOccurredAt: "2026-08-10T06:31:00.000Z",
          explicitMemoryIntent: false,
          turns: [
            { role: "user", text: "逐語保存しない電話の発言" },
            { role: "assistant", text: "短い電話の返事" },
          ],
        };
      },
    };
    };
  });

  await page.route("https://supabase.yui.invalid/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/token") || pathname.endsWith("/verify")) {
      const body = request.postDataJSON() as { email?: string } | null;
      const email = body?.email ?? "owner@example.com";
      const token = email === "owner@example.com" ? ownerToken : "token-other";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        json: {
          access_token: token,
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          refresh_token: `refresh-${token}`,
          user: { id: token === ownerToken ? "user-owner" : "user-other", email, aud: "authenticated", role: "authenticated" },
        },
      });
      return;
    }
    if (pathname.endsWith("/logout")) {
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  const fulfill = (route: Route, json: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", headers: cors, json });
  await page.route("https://api.yui.invalid/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const token = request.headers().authorization?.replace("Bearer ", "") ?? "";
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers: cors });
      return;
    }
    if (token !== ownerToken) {
      await fulfill(route, { error: "Unauthorized" }, 401);
      return;
    }
    if (pathname === "/api/profile" && request.method() === "GET") {
      await fulfill(route, { profile: profiles.get(token) ?? null });
      return;
    }
    if (pathname === "/api/profile" && request.method() === "PUT") {
      const input = request.postDataJSON() as Pick<Profile, "displayName" | "addressingStyle">;
      const saved = { ...input, updatedAt: hostedNow };
      profiles.set(token, saved);
      await fulfill(route, { profile: saved });
      return;
    }
    if (pathname === "/api/chat-state" && request.method() === "GET") {
      await fulfill(route, { snapshot: snapshots.get(token) ?? { timeline: [], draft: "", lastOpeningAt: null, lastConversationAt: null, version: 2, revision: 0, updatedAt: hostedNow } });
      return;
    }
    if (pathname === "/api/chat-state" && request.method() === "PUT") {
      const input = request.postDataJSON() as { expectedRevision: number; snapshot: Record<string, unknown> };
      const saved = { ...input.snapshot, revision: input.expectedRevision + 1, updatedAt: hostedNow };
      snapshots.set(token, saved);
      await fulfill(route, { snapshot: saved });
      return;
    }
    if (pathname === "/api/chat/responses") {
      const input = request.postDataJSON() as ChatRequest;
      const lastText = input.turns.at(-1)?.text ?? "";
      chatSourceIds.set(lastText, input.clientMessageId);
      const memories: string[] = [];
      let text = "クラウドで受け取ったよ";
      if (lastText === "記憶を確認") {
        if (settings.recallMemoryEnabled && activeMemory) {
          memories.push(activeMemory.content);
          text = `次は${activeMemory.content}だね`;
        } else {
          text = "今は記憶を使わずに話すね";
        }
      } else if (lastText === "健康の記憶を確認") {
        if (settings.recallMemoryEnabled) {
          memories.push(sensitiveMemory.content);
          text = "健康の話なら、関連する記憶を確認できたよ";
        } else {
          text = "今は記憶を使わずに話すね";
        }
      } else if (lastText === "今は何時？") {
        text = "いまの時刻だけ確認しよう";
      }
      sensitiveRetrievalCount += memories.filter((content) => content === sensitiveContent).length;
      retrievedMemoryContents.push(memories);
      await fulfill(route, replyJson(input.clientMessageId, { bubbles: [text], profileUpdate: null }));
      return;
    }
    if (pathname === "/api/memory/process") {
      const input = request.postDataJSON() as { sourceMessageId: string; turns: Array<{ text: string }> };
      const attempts = (processAttempts.get(input.sourceMessageId) ?? 0) + 1;
      processAttempts.set(input.sourceMessageId, attempts);
      if (input.sourceMessageId === "secret-source") {
        secretRejections += 1;
        processedSourceIds.add(input.sourceMessageId);
        await fulfill(route, { sourceMessageId: input.sourceMessageId, state: "completed", appliedCount: 0 }, 202);
        return;
      }
      if (!firstMemorySourceId) firstMemorySourceId = input.sourceMessageId;
      if (input.sourceMessageId === firstMemorySourceId && attempts === 1) {
        await fulfill(route, { sourceMessageId: input.sourceMessageId, state: "pending", appliedCount: 0 }, 202);
        return;
      }
      if (processedSourceIds.has(input.sourceMessageId) || tombstone || !settings.automaticMemoryEnabled || input.sourceMessageId !== firstMemorySourceId) {
        processedSourceIds.add(input.sourceMessageId);
        await fulfill(route, { sourceMessageId: input.sourceMessageId, state: "completed", appliedCount: 0 }, 202);
        return;
      }
      activeMemory = makeMemory({
        id: normalMemoryId,
        content: normalInitialContent,
        sensitivity: "normal",
        origin: "extracted",
        sourceMessageId: input.sourceMessageId,
      });
      processedSourceIds.add(input.sourceMessageId);
      chargedSourceIds.add(input.sourceMessageId);
      memoryWrites += 1;
      await fulfill(route, { sourceMessageId: input.sourceMessageId, state: "completed", appliedCount: 1 }, 202);
      return;
    }
    if (pathname === "/api/memories" && request.method() === "GET") {
      await fulfill(route, { memories: [...(activeMemory ? [activeMemory] : []), sensitiveMemory] });
      return;
    }
    if (pathname === `/api/memories/${normalMemoryId}` && request.method() === "PATCH" && activeMemory) {
      const patch = request.postDataJSON() as { content?: string; pinned?: boolean };
      activeMemory = {
        ...activeMemory,
        ...(patch.content ? { content: patch.content, normalizedContent: patch.content.replace(/\s/gu, "") } : {}),
        ...(typeof patch.pinned === "boolean" ? { pinned: patch.pinned } : {}),
        updatedAt: "2026-08-10T06:33:00.000Z",
      };
      await fulfill(route, { memory: activeMemory });
      return;
    }
    if (pathname === `/api/memories/${normalMemoryId}/forget` && request.method() === "POST" && activeMemory) {
      const body = request.postDataJSON() as { blockRelearning: boolean };
      activeMemory = null;
      if (body.blockRelearning) tombstone = { id: tombstoneId, memoryId: normalMemoryId, createdAt: hostedNow };
      await fulfill(route, {});
      return;
    }
    if (pathname === "/api/memory-tombstones" && request.method() === "GET") {
      await fulfill(route, { tombstones: tombstone ? [tombstone] : [] });
      return;
    }
    if (pathname === "/api/memory-settings" && request.method() === "GET") {
      await fulfill(route, { settings });
      return;
    }
    if (pathname === "/api/memory-settings" && request.method() === "PATCH") {
      const patch = request.postDataJSON() as Partial<typeof settings>;
      const keys = Object.keys(patch).filter((key) => key !== "updatedAt");
      settingsPatchKeys.push(...keys);
      settings = { ...settings, ...patch, updatedAt: "2026-08-10T06:34:00.000Z" };
      await fulfill(route, { settings });
      return;
    }
    if (pathname === "/api/e2e/realtime-memory" && request.method() === "GET") {
      realtimeMemoryReads += 1;
      const memory = settings.recallMemoryEnabled ? activeMemory?.content ?? null : null;
      realtimeMemoryValues.push(memory);
      await fulfill(route, { memory });
      return;
    }
    await fulfill(route, { error: "not_found" }, 404);
  });

  const login = async () => {
    await page.getByLabel("メールアドレス").fill("owner@example.com");
    await page.getByLabel("パスワード").fill("fake-owner-password");
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
  };
  const openMemories = async () => {
    await page.getByRole("button", { name: "設定を開く" }).click();
    await page.getByRole("button", { name: "覚えたことを開く" }).click();
    await expect(page.getByRole("heading", { name: "覚えたこと" })).toBeVisible();
  };
  const closeMemories = async () => {
    await page.getByRole("button", { name: "設定に戻る" }).click();
    await page.getByRole("button", { name: "チャットに戻る" }).click();
  };
  const send = async (text: string) => {
    await page.getByRole("textbox", { name: "メッセージ" }).fill(text);
    await page.getByRole("button", { name: "メッセージを送信" }).click();
  };
  const expectNoHorizontalOverflow = async (width: number, height: number) => {
    await page.setViewportSize({ width, height });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  };

  await expectNoHorizontalOverflow(320, 700);
  await page.goto("/");
  await login();
  await page.getByLabel("あなたの名前").fill("大輝");
  await page.getByRole("button", { name: "はじめる" }).click();
  await send("同期確認");
  await expect(page.getByText("クラウドで受け取ったよ", { exact: true })).toBeVisible();
  await expect.poll(() => firstMemorySourceId ? processAttempts.get(firstMemorySourceId) ?? 0 : 0).toBe(1);
  expect(memoryWrites).toBe(0);

  await page.reload();
  await expect(page.getByText("クラウドで受け取ったよ", { exact: true })).toBeVisible();
  await expect.poll(() => memoryWrites).toBe(1);
  expect(firstMemorySourceId).not.toBeNull();
  expect(processAttempts.get(firstMemorySourceId!)).toBe(2);
  expect(chargedSourceIds.size).toBe(1);

  await openMemories();
  await expect(page.getByRole("heading", { name: "最近覚えた" })).toBeVisible();
  await expect(page.getByText(normalInitialContent, { exact: true })).toBeVisible();
  await expect(page.getByText("敏感な内容は非表示です", { exact: true })).toBeVisible();
  await page.evaluate(async (occurredAt) => {
    const response = await fetch("https://api.yui.invalid/api/memory/process", {
      method: "POST",
      headers: { authorization: "Bearer token-owner", "content-type": "application/json" },
      body: JSON.stringify({
        sourceMessageId: "secret-source",
        sourceOccurredAt: occurredAt,
        turns: [{ role: "user", text: String.fromCharCode(65, 80, 73, 95, 75, 69, 89, 61) + "synthetic", provenance: "authoritative_source" }],
      }),
    });
    return response.json();
  }, hostedNow);
  expect(secretRejections).toBe(1);
  expect(memoryWrites).toBe(1);
  await page.getByRole("button", { name: `${normalInitialContent}の内容を編集` }).click();
  await page.getByRole("textbox", { name: "記憶の内容" }).fill(normalEditedContent);
  await page.getByRole("button", { name: "編集を保存" }).click();
  await expect(page.getByText(normalEditedContent, { exact: true })).toBeVisible();
  await closeMemories();
  await send("記憶を確認");
  await expect(page.getByText(`次は${normalEditedContent}だね`, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "ユイに電話する" }).click();
  await expect(page.getByText(`電話でも${normalEditedContent}だね`, { exact: true })).toBeVisible();
  expect(realtimeMemoryReads).toBe(1);
  await page.getByRole("button", { name: "今日はここまで" }).click();
  await expect(page.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
  await expect(page.getByText("逐語保存しない電話の発言", { exact: true })).toHaveCount(0);
  await expect(page.getByText(`電話でも${normalEditedContent}だね`, { exact: true })).toHaveCount(0);

  const voiceAttemptCount = () => [...processAttempts.keys()].filter((sourceId) => sourceId.startsWith("voice:")).length;
  await expect.poll(voiceAttemptCount).toBe(1);

  // Automatic-memory OFF is tested while voice and recall remain ON.
  await openMemories();
  await page.getByRole("switch", { name: "会話から自動で覚える" }).click();
  expect(settings).toMatchObject({ automaticMemoryEnabled: false, voiceMemoryEnabled: true, recallMemoryEnabled: true });
  expect(activeMemory?.content).toBe(normalEditedContent);
  await closeMemories();
  await send("自動停止中の記憶を確認");
  await expect(page.getByText("クラウドで受け取ったよ", { exact: true }).last()).toBeVisible();
  const automaticStoppedSource = chatSourceIds.get("自動停止中の記憶を確認")!;
  await page.waitForTimeout(200);
  expect(processAttempts.has(automaticStoppedSource)).toBe(false);
  const voiceAttemptsBeforeAutomaticStopCall = voiceAttemptCount();
  await page.getByRole("button", { name: "ユイに電話する" }).click();
  await expect(page.getByText(`電話でも${normalEditedContent}だね`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "今日はここまで" }).click();
  await expect.poll(voiceAttemptCount).toBe(voiceAttemptsBeforeAutomaticStopCall + 1);
  expect(activeMemory?.content).toBe(normalEditedContent);
  await openMemories();
  await page.getByRole("switch", { name: "会話から自動で覚える" }).click();

  // Voice-memory OFF is tested while automatic memory and recall remain ON.
  await page.getByRole("switch", { name: "電話から自動で覚える" }).click();
  expect(settings).toMatchObject({ automaticMemoryEnabled: true, voiceMemoryEnabled: false, recallMemoryEnabled: true });
  expect(activeMemory?.content).toBe(normalEditedContent);
  await closeMemories();
  await send("電話停止中の記憶を確認");
  await expect.poll(() => chatSourceIds.get("電話停止中の記憶を確認") ?? "").not.toBe("");
  const voiceStoppedChatSource = chatSourceIds.get("電話停止中の記憶を確認")!;
  await expect.poll(() => processAttempts.get(voiceStoppedChatSource) ?? 0).toBe(1);
  const voiceAttemptsBeforeStoppedCall = voiceAttemptCount();
  await page.getByRole("button", { name: "ユイに電話する" }).click();
  await expect(page.getByText(`電話でも${normalEditedContent}だね`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "今日はここまで" }).click();
  await expect(page.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
  await page.waitForTimeout(200);
  expect(voiceAttemptCount()).toBe(voiceAttemptsBeforeStoppedCall);
  expect(activeMemory?.content).toBe(normalEditedContent);
  await openMemories();
  await page.getByRole("switch", { name: "電話から自動で覚える" }).click();

  // Recall OFF is tested while automatic memory and voice memory remain ON.
  await page.getByRole("switch", { name: "会話で記憶を使う" }).click();
  expect(settings).toMatchObject({ automaticMemoryEnabled: true, voiceMemoryEnabled: true, recallMemoryEnabled: false });
  expect(activeMemory?.content).toBe(normalEditedContent);
  await closeMemories();
  await send("記憶を確認");
  await expect(page.getByText("今は記憶を使わずに話すね", { exact: true })).toBeVisible();
  const recallStoppedChatSource = chatSourceIds.get("記憶を確認")!;
  await expect.poll(() => processAttempts.get(recallStoppedChatSource) ?? 0).toBe(1);
  const voiceAttemptsBeforeRecallStopCall = voiceAttemptCount();
  await page.getByRole("button", { name: "ユイに電話する" }).click();
  await expect(page.getByText("電話では記憶を使っていないよ", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "今日はここまで" }).click();
  await expect.poll(voiceAttemptCount).toBe(voiceAttemptsBeforeRecallStopCall + 1);
  expect(activeMemory?.content).toBe(normalEditedContent);
  await openMemories();
  await page.getByRole("switch", { name: "会話で記憶を使う" }).click();
  expect(settings).toMatchObject({ automaticMemoryEnabled: true, voiceMemoryEnabled: true, recallMemoryEnabled: true });
  expect(settingsPatchKeys).toEqual([
    "automaticMemoryEnabled", "automaticMemoryEnabled",
    "voiceMemoryEnabled", "voiceMemoryEnabled",
    "recallMemoryEnabled", "recallMemoryEnabled",
  ]);
  await closeMemories();

  await send("健康の記憶を確認");
  await expect(page.getByText("健康の話なら、関連する記憶を確認できたよ", { exact: true })).toBeVisible();
  expect(retrievedMemoryContents.at(-1)).toEqual([sensitiveContent]);
  await send("今は何時？");
  await expect(page.getByText("いまの時刻だけ確認しよう", { exact: true })).toBeVisible();
  await expect(page.getByText(sensitiveContent, { exact: true })).toHaveCount(0);
  expect(sensitiveRetrievalCount).toBe(1);
  expect(retrievedMemoryContents.at(-1)).toEqual([]);

  await openMemories();
  await page.getByRole("button", { name: `${normalEditedContent}を忘れる` }).click();
  const forgetDialog = page.getByRole("dialog", { name: "この記憶を忘れますか" });
  await expect(forgetDialog.getByRole("checkbox")).toBeChecked();
  await forgetDialog.getByRole("button", { name: "忘れる" }).click();
  await expect(page.getByRole("heading", { name: "再び覚えてよいもの" })).toBeVisible();
  await expect(page.getByText(normalEditedContent, { exact: true })).toHaveCount(0);
  expect(activeMemory).toBeNull();
  await closeMemories();

  const replaySource = async () => page.evaluate(async ({ sourceMessageId, occurredAt }) => {
    const response = await fetch("https://api.yui.invalid/api/memory/process", {
      method: "POST",
      headers: { authorization: "Bearer token-owner", "content-type": "application/json" },
      body: JSON.stringify({
        sourceMessageId,
        sourceOccurredAt: occurredAt,
        turns: [{ role: "user", text: "同期確認", provenance: "authoritative_source" }],
      }),
    });
    return response.json();
  }, { sourceMessageId: firstMemorySourceId!, occurredAt: hostedNow });
  await replaySource();
  await replaySource();
  await page.evaluate(async (occurredAt) => {
    await fetch("https://api.yui.invalid/api/memory/process", {
      method: "POST",
      headers: { authorization: "Bearer token-owner", "content-type": "application/json" },
      body: JSON.stringify({
        sourceMessageId: "reconstructed-source",
        sourceOccurredAt: occurredAt,
        turns: [{ role: "user", text: "同期確認", provenance: "authoritative_source" }],
      }),
    });
  }, hostedNow);
  await page.reload();
  await expect(page.getByRole("button", { name: "設定を開く" })).toBeVisible();
  expect(activeMemory).toBeNull();
  expect(memoryWrites).toBe(1);
  expect(chargedSourceIds.size).toBe(1);
  expect(processAttempts.get(firstMemorySourceId!)).toBe(4);
  expect(processAttempts.get("reconstructed-source")).toBe(1);
  await expect(page.getByText("逐語保存しない電話の発言", { exact: true })).toHaveCount(0);
  await send("記憶を確認");
  await expect(page.getByText("今は記憶を使わずに話すね", { exact: true }).last()).toBeVisible();
  expect(retrievedMemoryContents.at(-1)).toEqual([]);
  await page.getByRole("button", { name: "ユイに電話する" }).click();
  await expect(page.getByText("電話では記憶を使っていないよ", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "今日はここまで" }).click();
  await expect(page.getByRole("textbox", { name: "メッセージ" })).toBeVisible();
  expect(realtimeMemoryValues.at(-1)).toBeNull();
  expect(activeMemory).toBeNull();
  expect(memoryWrites).toBe(1);
  expect(chargedSourceIds.size).toBe(1);

  await expect(page.getByText("覚えておくことがあります", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: /キャラクター/u })).toHaveCount(0);
  await expect(page.getByText(sensitiveContent, { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(320, 700);
  await expectNoHorizontalOverflow(390, 844);
});
