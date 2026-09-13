import type { RequestUser } from "./request-user.js";

export type VoiceMemoryLease = {
  signal: AbortSignal;
  release(): void;
};

export class VoiceMemoryCoordinator {
  private readonly blockedUsers = new Set<string>();
  private readonly active = new Map<string, Set<AbortController>>();
  private readonly idleWaiters = new Map<string, Set<() => void>>();

  acquire(user: RequestUser, externalSignal?: AbortSignal): VoiceMemoryLease | null {
    if (this.blockedUsers.has(user.userId)) return null;
    const controller = new AbortController();
    const controllers = this.active.get(user.userId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.active.set(user.userId, controllers);
    let released = false;
    return {
      signal: externalSignal
        ? AbortSignal.any([externalSignal, controller.signal])
        : controller.signal,
      release: () => {
        if (released) return;
        released = true;
        controllers.delete(controller);
        if (controllers.size > 0) return;
        this.active.delete(user.userId);
        for (const resolve of this.idleWaiters.get(user.userId) ?? []) resolve();
        this.idleWaiters.delete(user.userId);
      },
    };
  }

  blockAndAbort(user: RequestUser): void {
    this.blockedUsers.add(user.userId);
    for (const controller of this.active.get(user.userId) ?? []) controller.abort();
  }

  unblock(user: RequestUser): void {
    this.blockedUsers.delete(user.userId);
  }

  hasActive(user: RequestUser): boolean {
    return (this.active.get(user.userId)?.size ?? 0) > 0;
  }

  async waitForLocalIdle(user: RequestUser): Promise<void> {
    if (!this.hasActive(user)) return;
    await new Promise<void>((resolve) => {
      const waiters = this.idleWaiters.get(user.userId) ?? new Set<() => void>();
      waiters.add(resolve);
      this.idleWaiters.set(user.userId, waiters);
    });
  }
}
