import {afterEach,describe,it,expect,vi} from "vitest";
import {retryFetch} from "../apps/visual-audit-dev/lib/retry-fetch";
afterEach(()=>{vi.unstubAllGlobals();});
describe("provider request recovery",()=>{
  it("retries transient failures once",async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(new Response("overloaded",{status:529})).mockResolvedValueOnce(new Response("ok"));vi.stubGlobal("fetch",fetch);
    expect((await retryFetch("https://provider.test",{})).status).toBe(200);expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not retry missing credit or invalid credentials",async()=>{
    const fetch=vi.fn().mockResolvedValue(new Response("credit",{status:402}));vi.stubGlobal("fetch",fetch);
    expect((await retryFetch("https://provider.test",{})).status).toBe(402);expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("never retries a cancelled request",async()=>{
    const abort=new AbortController();abort.abort();const fetch=vi.fn().mockRejectedValue(new DOMException("Aborted","AbortError"));vi.stubGlobal("fetch",fetch);
    await expect(retryFetch("https://provider.test",{signal:abort.signal})).rejects.toThrow("Aborted");expect(fetch).toHaveBeenCalledTimes(1);
  });
});
