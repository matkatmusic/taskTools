// Global rule 8: no dependence on the agent's working directory. Paths a CLI contract
// calls absolute are checked here so a relative one fails loudly instead of resolving
// against whatever cwd the process happened to start in.
import { isAbsolute } from "node:path";

export function requireAbsolutePath(label: string, value: unknown): string {
    if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
    if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path, got "${value}"`);
    return value;
}
