import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAntigravityProvider } from "./src/provider.js";

export { createAntigravityProvider } from "./src/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createAntigravityProvider());
  return () => {};
}
