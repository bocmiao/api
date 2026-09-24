export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function fetchJSON(url, { timeoutMs = 10_000, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'api-hub/0.1', accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(502, `上游返回 HTTP ${res.status}`);
  return res.json();
}
