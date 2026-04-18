export function renderKeyValues(
  title: string,
  payload: Record<string, unknown>,
): string {
  const lines = [title];
  for (const [key, value] of Object.entries(payload)) {
    lines.push(`- ${key}: ${value}`);
  }
  return lines.join("\n");
}
