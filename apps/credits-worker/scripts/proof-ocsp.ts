import fetch, { Headers, type RequestInit, type Response } from "node-fetch";
export { Headers };

type OcspTransport = (url: string, options: RequestInit) => Promise<Response>;

export function ocspTransport(transport: OcspTransport = fetch): OcspTransport {
  return async (raw, options) => {
    const url = new URL(raw);
    const headers = new Headers(options.headers);
    if (
      !["http://ocsp.apple.com", "https://ocsp.apple.com"].includes(url.origin) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash ||
      options.method !== "POST" ||
      headers.get("content-type") !== "application/ocsp-request" ||
      [...headers.keys()].some((name) => name !== "content-type")
    )
      throw new Error("invalid OCSP destination");
    const response = await transport(url.href, { ...options, headers, redirect: "error" });
    if (response.redirected || (response.status >= 300 && response.status < 400))
      throw new Error("OCSP redirect refused");
    return response;
  };
}

export default ocspTransport();
