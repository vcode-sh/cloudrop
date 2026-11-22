// The store's code for the server (M12-S1). Only stores import this file, through defineStore, so its modules reach an
// app's bundle with a store and never with the stateless server alone.

import * as api from "../server/store-api.ts";
import * as calls from "../server/store-calls.ts";
import * as complete from "../server/store-complete.ts";
import type { StorePaths } from "../server/store-paths.ts";
import * as upload from "../server/store-upload.ts";

export const storePaths: StorePaths = { version: 1, upload, complete, calls, api };
