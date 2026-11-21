// The cloudrop/plugins entry: plugins for createCloudrop's `plugins` option, server side only. The build keeps the
// imports of ./index.ts as imports of the published entry (tsdown.config.ts), so a plugin's errors are the server's own
// CloudropError class and this entry adds no copy of it (M10-K5).

export { type ContentCheckOptions, contentChecks } from "./plugins/content-checks.ts";
