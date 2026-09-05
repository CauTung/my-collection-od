/**
 * Runs independent asynchronous work in bounded chunks.
 *
 * Webhook handlers use this helper to isolate item failures without launching an
 * unbounded burst of Admin GraphQL mutations against Shopify's leaky bucket.
 */

/**
 * Map every input to a settled result while limiting active work to one chunk.
 *
 * @param inputs - Values to process in source order.
 * @param concurrency - Positive maximum number of simultaneous operations.
 * @param operation - Asynchronous operation applied to each input.
 * @returns Settled results in the same order as the inputs.
 * @throws RangeError when concurrency is not a positive safe integer.
 */
export async function mapSettledInChunks<T, R>(
  inputs: readonly T[],
  concurrency: number,
  operation: (input: T) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new RangeError("Concurrency must be a positive safe integer");
  }

  const settled: Array<PromiseSettledResult<R>> = [];
  for (let index = 0; index < inputs.length; index += concurrency) {
    const chunk = inputs.slice(index, index + concurrency);
    settled.push(...(await Promise.allSettled(chunk.map(operation))));
  }
  return settled;
}
