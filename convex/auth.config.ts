import type { AuthConfig } from "convex/server";

// Configure an OIDC issuer and audience in the Convex deployment before using
// the cloud adapter. Functions derive tenant scope from the verified identity.
export default {
  providers: [{ domain: process.env.CONVEX_AUTH_ISSUER!, applicationID: process.env.CONVEX_AUTH_AUDIENCE! }],
} satisfies AuthConfig;
