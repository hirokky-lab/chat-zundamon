import type { AuthSession } from "../auth";
import { inspectVrm, MAX_VRM_BYTES, type LocalVrm } from "./vrm-file";
import type { CharacterPreference } from "./vrm-preference";

export type VrmCloud = {
  check(): Promise<void>;
  load(cached?: LocalVrm): Promise<CharacterPreference>;
  save(value: CharacterPreference): Promise<CharacterPreference>;
};
type Metadata = {
  revision: number;
  mode: "live2d" | "vrm";
  model_id: string | null;
  file_name: string | null;
};
const bucket = "zundamon-vrm";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Uses the signed-in owner's token, never a service key or public model URL. */
export function createVrmCloud(options: {
  url: string;
  key: string;
  ownerId: string;
  getSession(): Promise<AuthSession | null>;
  fetchImpl?: typeof fetch;
}): VrmCloud {
  let current: Metadata | undefined;
  const request = async (path: string, init: RequestInit = {}) => {
    const session = await options.getSession();
    if (!session || session.userId !== options.ownerId)
      throw Error("ログインし直してください。");
    const headers = new Headers(init.headers);
    headers.set("apikey", options.key);
    headers.set("Authorization", `Bearer ${session.accessToken}`);
    return (options.fetchImpl ?? fetch)(`${options.url}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
  };
  const readMetadata = async () => {
    const r = await request(
      `/rest/v1/vrm_preferences?select=revision,mode,model_id,file_name&user_id=eq.${options.ownerId}`,
    );
    if (!r.ok)
      throw Error(
        "サーバー保存を利用できません。接続と保存先の設定を確認してください。",
      );
    const rows = await r.json();
    const row = rows[0] ?? {
      revision: 0,
      mode: "live2d",
      model_id: null,
      file_name: null,
    };
    if (
      !Array.isArray(rows) ||
      rows.length > 1 ||
      !Number.isSafeInteger(row.revision) ||
      row.revision < 0 ||
      !["live2d", "vrm"].includes(row.mode) ||
      (row.model_id !== null && !uuid.test(row.model_id)) ||
      (row.model_id !== null &&
        (typeof row.file_name !== "string" || row.file_name.length > 255))
    )
      throw Error("サーバーのモデル情報を読み込めませんでした。");
    return row as Metadata;
  };
  const remove = async (id: string) => {
    // RLS refuses deletion if another tab has made this file current again.
    const response = await request(`/storage/v1/object/${bucket}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: [`${options.ownerId}/${id}.vrm`] }),
    });
    if (!response.ok) throw Error("old_model_cleanup_failed");
  };
  return {
    async check() {
      current = await readMetadata();
    },
    async load(cached) {
      const row = await readMetadata();
      let model: LocalVrm | undefined;
      if (row.model_id) {
        if (cached?.id === row.model_id) {
          inspectVrm(cached.data);
          model = cached;
        } else {
          const response = await request(
            `/storage/v1/object/authenticated/${bucket}/${options.ownerId}/${row.model_id}.vrm`,
          );
          if (!response.ok)
            throw Error(
              "サーバーのVRMを取得できませんでした。再試行してください。",
            );
          // Enforce a bound even if a response omits Content-Length.
          const reader = response.body?.getReader();
          if (!reader) throw Error("モデルを読み込めませんでした。");
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > MAX_VRM_BYTES) {
              await reader.cancel();
              throw Error("50MB以下のVRMを選んでください。");
            }
            chunks.push(part.value);
          }
          const data = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.byteLength;
          }
          model = {
            ...inspectVrm(data.buffer),
            data: data.buffer,
            id: row.model_id,
            fileName: row.file_name!,
          };
        }
      }
      current = row;
      return { mode: model ? row.mode : "live2d", model, storage: "server" };
    },
    async save(value) {
      const previous = current ?? (await readMetadata());
      let model = value.model;
      let uploaded: string | undefined;
      if (model) {
        inspectVrm(model.data);
        if (model.id !== previous.model_id) {
          const id = crypto.randomUUID();
          const response = await request(
            `/storage/v1/object/${bucket}/${options.ownerId}/${id}.vrm`,
            {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body: model.data,
            },
          );
          if (!response.ok)
            throw Error(
              "VRMをアップロードできませんでした。無料枠の空き容量と接続を確認してください。",
            );
          uploaded = id;
          model = { ...model, id };
        }
      }
      const r = await request("/rest/v1/rpc/save_vrm_preference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          p_revision: previous.revision,
          p_mode: model ? value.mode : "live2d",
          p_model_id: model?.id ?? null,
          p_file_name: model?.fileName.slice(0, 255) ?? null,
        }),
      });
      if (!r.ok) {
        // A known conflict did not publish the uploaded file. On ambiguous network
        // failure keep it: deleting could break a successfully committed response.
        if (r.status === 409 && uploaded)
          await remove(uploaded).catch(() => undefined);
        throw Error(
          r.status === 409
            ? "別の端末で設定が変わりました。「サーバーから読み込む」で更新してください。"
            : "モデルの設定を保存できませんでした。サーバーから読み込み直して確認してください。",
        );
      }
      const saved = (await r.json()) as Metadata;
      current = saved;
      if (previous.model_id && previous.model_id !== saved.model_id)
        await remove(previous.model_id).catch(() => undefined);
      return { mode: model ? value.mode : "live2d", model, storage: "server" };
    },
  };
}
