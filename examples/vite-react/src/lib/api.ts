/** The Hono API's origin: another origin of the same site, so its cookies travel with `credentials: "include"`. */
export const API_ORIGIN: string = import.meta.env.VITE_API_ORIGIN ?? "http://localhost:5181";
