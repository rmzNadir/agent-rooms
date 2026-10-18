export interface SearchEntry {
  readonly authorName: string;
  readonly body: string;
  readonly redacted: boolean;
  readonly seq: number;
}

export const searchBodies = (
  entries: readonly SearchEntry[],
  query: string,
  limit: number
): readonly SearchEntry[] => {
  const needle = query.toLowerCase();
  const matched = entries.filter(
    (entry) => !entry.redacted && entry.body.toLowerCase().includes(needle)
  );
  return matched.slice(-limit);
};
