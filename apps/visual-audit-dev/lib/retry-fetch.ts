/** One bounded retry for transient provider failures, never authentication errors. */
export async function retryFetch(url: string, init: RequestInit, timeoutMs = 45000): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)])});
      if (attempt || ![429, 502, 503, 504, 529].includes(response.status)) return response;
      await response.body?.cancel();
    } catch (error) {
      if (attempt || init.signal?.aborted) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 700));
    init.signal?.throwIfAborted();
  }
}
