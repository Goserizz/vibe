const KEY = 'vibe.token';

/**
 * Resolve the access token. A token supplied via `?token=` in the URL (the
 * link the server prints) takes precedence and is then persisted, with the
 * query string cleaned up so it isn't left lying around.
 */
export function resolveToken(): string | null {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    localStorage.setItem(KEY, fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    return fromUrl;
  }
  return localStorage.getItem(KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(KEY);
}
