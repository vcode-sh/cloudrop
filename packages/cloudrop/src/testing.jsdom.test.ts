// @vitest-environment jsdom
// testClient as an app's test runs it under Vitest's jsdom environment (M11-R1).

import { testClientEnvironmentCases } from "./testing/test-client-environments.ts";

testClientEnvironmentCases("jsdom");
