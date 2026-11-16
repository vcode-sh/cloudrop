/** How the client sends every request: the endpoints' POSTs and the bucket's PUTs. */
export type ClientFetch = (url: string, init: RequestInit) => Promise<Response>;
