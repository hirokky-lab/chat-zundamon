import { parseLocalChatSnapshot, type LocalChatSnapshot } from "@yui/domain";

const DATABASE_NAME = "zundamon-ai-local";
const DATABASE_VERSION = 1;
const STORE_NAME = "state";
const SNAPSHOT_KEY = "current";

export const EMPTY_LOCAL_CHAT: LocalChatSnapshot = {
  timeline: [],
  draft: "",
  pendingDisplayName: null,
  lastOpeningAt: null,
  lastConversationAt: null,
};

export type LocalStateStore = {
  load(): Promise<LocalChatSnapshot>;
  save(snapshot: LocalChatSnapshot): Promise<void>;
  getPersistenceWarning?(): string | null;
};

export type LocalStateStoreOptions = {
  indexedDB?: IDBFactory;
  databaseName?: string;
};

export type BrowserLocalState = {
  store: LocalStateStore;
  persistent: boolean;
};

function emptySnapshot(): LocalChatSnapshot {
  return {
    timeline: [],
    draft: "",
    pendingDisplayName: null,
    lastOpeningAt: null,
    lastConversationAt: null,
  };
}

function normalizeSnapshot(value: unknown): LocalChatSnapshot {
  return parseLocalChatSnapshot(value) ?? emptySnapshot();
}

function openDatabase(indexedDB: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(databaseName, DATABASE_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Unable to open local state"));
    request.onblocked = () => reject(new Error("Local state database is blocked"));
  });
}

export function createMemoryLocalStateStore(): LocalStateStore {
  let snapshot = emptySnapshot();

  return {
    async load() {
      return normalizeSnapshot(snapshot);
    },
    async save(nextSnapshot) {
      snapshot = normalizeSnapshot(nextSnapshot);
    },
  };
}

export function createIndexedDbLocalStateStore(options: LocalStateStoreOptions = {}): LocalStateStore {
  const indexedDB = options.indexedDB ?? globalThis.indexedDB;
  const databaseName = options.databaseName ?? DATABASE_NAME;

  async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    if (!indexedDB) throw new Error("IndexedDB is unavailable");

    const database = await openDatabase(indexedDB, databaseName);
    try {
      return await new Promise<T>((resolve, reject) => {
        let transaction: IDBTransaction;
        let request: IDBRequest<T>;
        try {
          transaction = database.transaction(STORE_NAME, mode);
          request = run(transaction.objectStore(STORE_NAME));
        } catch (error) {
          reject(error);
          return;
        }

        request.onerror = () => reject(request.error ?? new Error("Unable to access local state"));
        transaction.onerror = () => reject(transaction.error ?? new Error("Unable to access local state"));
        transaction.onabort = () => reject(transaction.error ?? new Error("Local state transaction aborted"));
        transaction.oncomplete = () => resolve(request.result);
      });
    } finally {
      database.close();
    }
  }

  return {
    async load() {
      const snapshot = await withStore("readonly", (store) => store.get(SNAPSHOT_KEY));
      return snapshot === undefined ? emptySnapshot() : normalizeSnapshot(snapshot);
    },
    async save(snapshot) {
      const normalizedSnapshot = normalizeSnapshot(snapshot);
      await withStore("readwrite", (store) => store.put(normalizedSnapshot, SNAPSHOT_KEY));
    },
  };
}

export async function createBrowserLocalStateStore(
  options: LocalStateStoreOptions = {},
): Promise<BrowserLocalState> {
  const indexedDB = options.indexedDB ?? globalThis.indexedDB;
  const temporaryStore = (): BrowserLocalState => ({store: {...createMemoryLocalStateStore(), getPersistenceWarning: () => "端末内に保存できません。下書きはこの画面を閉じると失われます。"}, persistent:false});
  if (!indexedDB) return temporaryStore();

  const store = createIndexedDbLocalStateStore({ ...options, indexedDB });
  try {
    await store.load();
    return { store, persistent: true };
  } catch {
    return temporaryStore();
  }
}
