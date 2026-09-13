import { useEffect, useRef, useState } from "react";
import { inspectVrm, type LocalVrm } from "./vrm-file";
import type { VrmCloud } from "./vrm-cloud";

export type CharacterPreference = {
  mode: "live2d" | "vrm";
  model?: LocalVrm;
  storage?: "local" | "server";
};
const initial: CharacterPreference = { mode: "live2d" };

export async function characterRecord(
  scope: string,
  value?: CharacterPreference,
): Promise<CharacterPreference> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("zundamon-ai-character-v1", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("preferences");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(
        "preferences",
        value ? "readwrite" : "readonly",
      );
      const request = value
        ? tx.objectStore("preferences").put(value, scope)
        : tx.objectStore("preferences").get(scope);
      tx.oncomplete = () => resolve(value ?? request.result ?? initial);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export function useCharacterPreference(scope: string, cloud?: VrmCloud) {
  const [preference, setPreference] = useState<CharacterPreference>(initial);
  const [ready, setReady] = useState(false),
    [saving, setSaving] = useState(false);
  const [serverReady, setServerReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0),
    busy = useRef(false);
  useEffect(() => {
    const id = ++generation.current;
    setReady(false);
    setServerReady(false);
    setPreference(initial);
    setError(null);
    busy.current = false;
    setSaving(false);
    void (async () => {
      let value = initial;
      try {
        value = await characterRecord(scope);
        if (value.model) inspectVrm(value.model.data);
        if (id === generation.current) setPreference(value);
      } catch {
        if (id === generation.current)
          setError("端末内の設定を読み込めませんでした。");
      }
      if (cloud) {
        try {
          // Explicit local selection stays local; a fresh device adopts the server.
          const remote =
            value.storage === "local" || (!value.storage && value.model)
              ? (await cloud.check(), null)
              : await cloud.load(
                  value.storage === "server" ? value.model : undefined,
                );
          if (id !== generation.current) return;
          setServerReady(true);
          if (remote) {
            setPreference(remote);
            await characterRecord(scope, remote).catch(() => undefined);
          }
        } catch {
          if (id === generation.current)
            setError(
              "サーバーのモデルを確認できませんでした。端末内の設定で表示しています。「サーバーから読み込む」で再試行できます。",
            );
        }
      }
      if (id === generation.current) setReady(true);
    })();
    return () => {
      generation.current++;
    };
  }, [scope, cloud]);

  async function operation(
    work: () => Promise<CharacterPreference>,
    failure: string,
  ) {
    if (!ready || busy.current) return false;
    const id = generation.current;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      const value = await work();
      if (id !== generation.current) return false;
      if (value.storage === "server") {
        // Cloud success remains success even if the optional browser cache is full.
        await characterRecord(scope, value).catch(() => {
          if (id === generation.current)
            setError(
              "サーバーに保存しました。端末内にキャッシュできないため、次回は再取得します。",
            );
        });
      } else {
        await characterRecord(scope, value);
      }
      if (id !== generation.current) return false;
      setPreference(value);
      return true;
    } catch (cause) {
      if (id === generation.current)
        setError(cause instanceof Error && /[ぁ-んァ-ヶ一-龠]/.test(cause.message) ? cause.message : failure);
      return false;
    } finally {
      if (id === generation.current) {
        busy.current = false;
        setSaving(false);
      }
    }
  }
  async function save(value: CharacterPreference) {
    return operation(async () => {
      if (value.storage === "server") {
        if (!cloud)
          throw Error("サーバー保存にはログインとSupabaseの設定が必要です。");
        return cloud.save(value);
      }
      return { ...value, storage: "local" };
    }, "モデルを保存できませんでした。");
  }
  async function reloadServer() {
    return operation(async () => {
      if (!cloud) throw Error("サーバーが設定されていません。");
      const value = await cloud.load(
        preference.storage === "server" ? preference.model : undefined,
      );
      setServerReady(true);
      return value;
    }, "サーバーのモデルを読み込めませんでした。");
  }
  return {
    preference,
    ready,
    saving,
    error,
    save,
    serverReady,
    serverConfigured: !!cloud,
    reloadServer,
  };
}
export type CharacterController = ReturnType<typeof useCharacterPreference>;
