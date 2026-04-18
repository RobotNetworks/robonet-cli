export function renderJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}
