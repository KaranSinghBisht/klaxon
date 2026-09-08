/** Run `worker` over `items` with at most `limit` in flight, preserving result order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.trunc(limit));
  const results = new Array<R>(items.length);
  let next = 0;
  async function pump(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  }
  const lanes: Promise<void>[] = [];
  for (let i = 0; i < Math.min(width, items.length); i++) lanes.push(pump());
  await Promise.all(lanes);
  return results;
}
