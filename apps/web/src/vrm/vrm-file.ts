export const MAX_VRM_BYTES = 50 * 1024 * 1024;
export type VrmInfo = { name: string; author: string; version: "0" | "1" };
export type LocalVrm = VrmInfo & {
  data: ArrayBuffer;
  id: string;
  fileName: string;
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const label = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, 160)
    : fallback;

/** Inspect the container before GLTFLoader can resolve any resource URLs. */
export function inspectVrm(data: ArrayBuffer): VrmInfo {
  if (data.byteLength > MAX_VRM_BYTES)
    throw Error("50MB以下のVRMファイルを選んでください。");
  const invalid = () =>
    Error("VRMファイルを読み込めません。別のファイルを選んでください。");
  if (data.byteLength < 20) throw invalid();
  const header = new DataView(data);
  if (
    header.getUint32(0, true) !== 0x46546c67 ||
    header.getUint32(4, true) !== 2 ||
    header.getUint32(8, true) !== data.byteLength ||
    header.getUint32(16, true) !== 0x4e4f534a
  )
    throw invalid();
  const size = header.getUint32(12, true);
  if (
    !size ||
    size > 4 * 1024 * 1024 ||
    size % 4 ||
    20 + size > data.byteLength
  )
    throw invalid();
  let json: unknown;
  try {
    json = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array(data, 20, size),
      ),
    );
  } catch {
    throw invalid();
  }
  if (
    !record(json) ||
    !record(json.asset) ||
    json.asset.version !== "2.0" ||
    !record(json.extensions)
  )
    throw invalid();
  for (const resources of [json.buffers, json.images]) {
    if (resources === undefined) continue;
    if (!Array.isArray(resources)) throw invalid();
    for (const resource of resources) {
      if (!record(resource)) throw invalid();
      if (
        resource.uri !== undefined &&
        (typeof resource.uri !== "string" ||
          !/^data:(?:image\/(?:png|jpeg)|application\/octet-stream);base64,[A-Za-z0-9+/=]+$/.test(
            resource.uri,
          ))
      ) {
        throw Error(
          "外部ファイルを参照するモデルは使えません。画像を含む1つのVRMファイルを選んでください。",
        );
      }
    }
  }
  const v1 = json.extensions.VRMC_vrm,
    v0 = json.extensions.VRM;
  if (record(v1) && record(v1.meta) && v1.specVersion === "1.0")
    return {
      name: label(v1.meta.name, "VRMモデル"),
      author: label(
        Array.isArray(v1.meta.authors) ? v1.meta.authors[0] : undefined,
        "未記載",
      ),
      version: "1",
    };
  if (record(v0) && record(v0.meta))
    return {
      name: label(v0.meta.title, "VRMモデル"),
      author: label(v0.meta.author, "未記載"),
      version: "0",
    };
  throw invalid();
}

export async function readVrmFile(file: File): Promise<LocalVrm> {
  if (!/\.vrm$/i.test(file.name))
    throw Error(".vrm形式のファイルを選んでください。");
  if (file.size > MAX_VRM_BYTES)
    throw Error("50MB以下のVRMファイルを選んでください。");
  const data = await file.arrayBuffer();
  return {
    ...inspectVrm(data),
    data,
    id: crypto.randomUUID(),
    fileName: file.name,
  };
}
