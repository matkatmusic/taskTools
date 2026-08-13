// Tri-state outcomes for output fields where the real mutating script always knows the answer
// at call time, but reconciling a lost result afterward sometimes cannot: the world can look
// identical whether this run caused the observed state or never touched it. Real scripts must
// never return the unknown value — only reconcileStep.ts, reconstructing after the fact, may.
export const HOLD_NOT_RELEASED = 0;
export const HOLD_RELEASED = 1;
export const HOLD_RELEASE_UNKNOWN = 2;
export type HoldReleaseState = typeof HOLD_NOT_RELEASED | typeof HOLD_RELEASED | typeof HOLD_RELEASE_UNKNOWN;

export const SUBMODULES_NOT_INITIALIZED = 0;
export const SUBMODULES_INITIALIZED = 1;
export const SUBMODULE_INITIALIZATION_UNKNOWN = 2;
export type SubmoduleInitializationState =
    | typeof SUBMODULES_NOT_INITIALIZED
    | typeof SUBMODULES_INITIALIZED
    | typeof SUBMODULE_INITIALIZATION_UNKNOWN;
