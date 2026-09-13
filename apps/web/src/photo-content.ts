export type PhotoContentHandle = { objectUrl: string; dispose(): void };

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function createPhotoContentLoader(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis), revokeAfterMs = 30_000) {
  return {
    async load(photoId: string, signal: AbortSignal): Promise<PhotoContentHandle> {
      const response = await fetchImpl(`/api/photos/${encodeURIComponent(photoId)}/content`, { cache: "no-store", signal });
      if (response.status === 401) throw new Error("photo_auth_expired");
      if (!response.ok) throw new Error("photo_content_unavailable");
      if (response.headers.get("Content-Type") !== "image/jpeg") throw new Error("invalid_photo_content");
      const blob = await response.blob();
      if (blob.type !== "image/jpeg" || blob.size < 1 || blob.size > 5 * 1024 * 1024) throw new Error("invalid_photo_content");
      const objectUrl = URL.createObjectURL(blob);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearTimeout(timer);
        URL.revokeObjectURL(objectUrl);
      };
      const timer = setTimeout(dispose, revokeAfterMs);
      return { objectUrl, dispose };
    },
  };
}
