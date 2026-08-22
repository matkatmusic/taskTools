// The only three things a block may say when it finishes. Node strips types, so this cannot be an enum.
export const SIGNAL = {
    CONTINUE: "continue",
    STOP: "stop",
    PROMPT: "prompt",
} as const;

export type Signal = typeof SIGNAL[keyof typeof SIGNAL];

export const KNOWN_SIGNALS: Signal[] = [SIGNAL.CONTINUE, SIGNAL.STOP, SIGNAL.PROMPT];
