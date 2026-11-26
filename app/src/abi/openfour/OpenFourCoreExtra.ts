// MANUAL (kept by `npm run abi`): Core functions used by the startup scripts and the keeper that are not in
// the public IOpenFourCore interface artifact. Core.migrate(token) is permissionless once the migrate module's
// evaluate() returns canMigrate; Core.signer() is the create-signature key (OF_UI_SIGNER on the web route).
import { parseAbi } from "viem";

export const OpenFourCoreExtraAbi = parseAbi([
  "function migrate(address token)",
  "function signer() view returns (address)",
]);
