export interface ModelInfo {
  id: string; display_name: string; created_at?: string;
  contextWindow?: number; maxOutput?: number; reasoning?: boolean;
  cost?: { input: number; output: number };
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? res.statusText);
  return res.json() as Promise<T>;
}

export const api = {
  // Live model list for a provider. The key rides in a header (BYOK); the route
  // fetches server-side so every provider works.
  models: (provider: string, key?: string) =>
    fetch(`/api/models?provider=${encodeURIComponent(provider)}`, {
      headers: key ? { "x-provider-key": key } : {},
    }).then(j<ModelInfo[]>),
};
