// Flap's TaxProcessor (external, Flap-owned). Only dispatch() is used.
import { parseAbi } from "viem";

export const FlapTaxProcessorAbi = parseAbi(["function dispatch()"]);

/** The Flap tax token exposes its TaxProcessor (example ForkBase). [UNVERIFIED on the live token] */
export const FlapTaxTokenAbi = parseAbi(["function taxProcessor() view returns (address)"]);
