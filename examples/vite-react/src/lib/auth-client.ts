import { createAuthClient } from "better-auth/react";
import { API_ORIGIN } from "./api";

// The session cookie lives on the API's host; the browser sends it to the API with every credentialed request.
export const authClient = createAuthClient({ baseURL: API_ORIGIN, fetchOptions: { credentials: "include" } });
