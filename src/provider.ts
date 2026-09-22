import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnectRequest,
  ProviderConnection,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { createAntigravityConnector } from "./connector.js";
import { SteeringConnection } from "./steering.js";

/**
 * Creates the Antigravity provider registration for Paseo.
 *
 * Uses `createAntigravityConnector` to launch and stream to the local `agy_acp_server`,
 * filtering redundant mode controls, discovering and advertising skills, and expanding
 * slash commands. Wraps the established connection with `SteeringConnection` to support
 * mid-turn steering (`prompt.steer`).
 */
export function createAntigravityProvider(): ProviderRegistration {
  const baseProvider = runAcpProvider({
    id: "refined-antigravity-acp",
    label: "Antigravity",
    description: "Connect Paseo to Google Antigravity via ACP",
    icon: "assets/icon.svg",
    connector: createAntigravityConnector(),
    acpOptions: {
      waitForInitialCommands: true,
    },
  });

  return {
    ...baseProvider,
    async connect(request: ProviderConnectRequest): Promise<ProviderConnection> {
      const connection = await baseProvider.connect(request);
      return new SteeringConnection(connection, request);
    },
  };
}
