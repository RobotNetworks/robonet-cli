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

/**
 * Select the singular or plural noun form for `count`. The plural form is
 * inferred by appending `s` when not supplied — pass an explicit `plural`
 * for irregular nouns (`entry` → `entries`, `policy` → `policies`).
 *
 * Returns just the noun, not the count, so callers can format the surrounding
 * sentence however they like (e.g. `"Added 1 entry"` vs. `"No entries"`).
 */
export function pluralize(
  count: number,
  singular: string,
  plural?: string,
): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}
