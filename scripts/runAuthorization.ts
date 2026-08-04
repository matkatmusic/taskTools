const runAuthorizationBrand: unique symbol = Symbol("RunAuthorizationToken");

export type RunAuthorizationToken = {
    readonly [runAuthorizationBrand]: true;
    readonly stateDigest: string;
};

export function issueRunAuthorization(stateDigest: string): RunAuthorizationToken {
    return { [runAuthorizationBrand]: true, stateDigest };
}

function isRunAuthorizationToken(value: unknown): value is RunAuthorizationToken {
    return typeof value === "object" && value !== null && runAuthorizationBrand in value;
}

export function runFinalization<T>(token: RunAuthorizationToken, currentStateDigest: string, mutate: () => T): T {
    if (!isRunAuthorizationToken(token)) {
        throw new Error("runFinalization requires a RunAuthorizationToken issued by issueRunAuthorization");
    }
    if (token.stateDigest !== currentStateDigest) {
        throw new Error(`runAuthorization token digest "${token.stateDigest}" does not match current state digest "${currentStateDigest}"`);
    }
    return mutate();
}
