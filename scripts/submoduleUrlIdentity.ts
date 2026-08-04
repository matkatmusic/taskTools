// submoduleUrlIdentity.ts: resolve submodule .gitmodules URLs to a normalized repository identity.

export interface SubmoduleOccurrence {
    path: string;
    url: string | undefined; // raw .gitmodules value; undefined = missing entry
    parentOriginUrl: string | undefined; // immediate parent's origin URL; undefined = unavailable
}

export interface RepositoryIdentity {
    host: string;
    owner: string;
    repository: string;
}

export type SubmoduleIdentityResolution =
    | { status: "resolved"; identity: RepositoryIdentity }
    | { status: "resolution-required"; reason: string; occurrences: SubmoduleOccurrence[] };

const DEFAULT_PORTS_BY_SCHEME: Record<string, string> = { https: "443", http: "80", ssh: "22" };

export function resolveRelativeSubmoduleUrl(relativeUrl: string, parentOriginUrl: string): string {
    let remoteUrl = parentOriginUrl.replace(/\/+$/, "");
    let separator = "/";
    let remainder = relativeUrl;

    while (remainder.length > 0) {
        if (remainder.startsWith("../")) {
            remainder = remainder.slice(3);
            if (remoteUrl.includes("/")) {
                remoteUrl = remoteUrl.slice(0, remoteUrl.lastIndexOf("/"));
            } else if (remoteUrl.includes(":")) {
                remoteUrl = remoteUrl.slice(0, remoteUrl.lastIndexOf(":"));
                separator = "";
            } else {
                throw new Error(
                    `cannot resolve relative submodule url "${relativeUrl}" past root of "${parentOriginUrl}"`
                );
            }
            continue;
        }
        if (remainder.startsWith("./")) {
            remainder = remainder.slice(2);
            continue;
        }
        break;
    }

    return remoteUrl + separator + remainder.replace(/\/+$/, "");
}

function resolveSubmoduleUrl(url: string, parentOriginUrl: string | undefined): string | undefined {
    const isRelative = url.startsWith("./") || url.startsWith("../");
    if (!isRelative) {
        return url;
    }
    if (parentOriginUrl === undefined) {
        return undefined; // signals "unavailable" to the caller
    }
    return resolveRelativeSubmoduleUrl(url, parentOriginUrl);
}

export function normalizeRepositoryIdentity(url: string): RepositoryIdentity | null {
    const scpMatch = !url.includes("://") && url.match(/^(?:[^@]+@)?([^:/]+):(.+)$/);

    let host: string;
    let pathPortion: string;
    let scheme = "ssh"; // scp-style URLs are implicitly ssh
    let port: string | null = null;

    if (scpMatch) {
        host = scpMatch[1];
        pathPortion = scpMatch[2];
    } else {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return null;
        }
        scheme = parsed.protocol.replace(":", "");
        host = parsed.hostname;
        port = parsed.port || null;
        pathPortion = parsed.pathname.replace(/^\//, "");
    }

    pathPortion = pathPortion.replace(/\/+$/, "").replace(/\.git$/i, "");
    const segments = pathPortion.split("/").filter(Boolean);
    if (segments.length < 2) {
        return null;
    }

    const repository = segments[segments.length - 1];
    const owner = segments.slice(0, -1).join("/");

    const isNonDefaultPort = port !== null && port !== DEFAULT_PORTS_BY_SCHEME[scheme];
    const hostIdentity = isNonDefaultPort ? `${host}:${port}` : host;

    return {
        host: hostIdentity.toLowerCase(),
        owner: owner.toLowerCase(),
        repository: repository.toLowerCase(),
    };
}

function repositoryIdentitiesMatch(a: RepositoryIdentity, b: RepositoryIdentity): boolean {
    return a.host === b.host && a.owner === b.owner && a.repository === b.repository;
}

function resolutionRequired(reason: string, occurrences: SubmoduleOccurrence[]): SubmoduleIdentityResolution {
    return { status: "resolution-required", reason, occurrences };
}

export function resolveSubmoduleUpstreamIdentity(
    occurrences: SubmoduleOccurrence[]
): SubmoduleIdentityResolution {
    const resolvedUrls: string[] = [];

    for (const occurrence of occurrences) {
        if (occurrence.url === undefined) {
            return resolutionRequired("missing .gitmodules url entry", occurrences);
        }
        const fullUrl = resolveSubmoduleUrl(occurrence.url, occurrence.parentOriginUrl);
        if (fullUrl === undefined) {
            return resolutionRequired("relative submodule url has no parent origin to resolve against", occurrences);
        }
        resolvedUrls.push(fullUrl);
    }

    const identities = resolvedUrls.map(normalizeRepositoryIdentity);
    if (identities.some((identity) => identity === null)) {
        return resolutionRequired("submodule url could not be parsed into a repository identity", occurrences);
    }

    const [first, ...rest] = identities as RepositoryIdentity[];
    for (const identity of rest) {
        if (!repositoryIdentitiesMatch(first, identity)) {
            return resolutionRequired("submodule urls resolve to different repository identities", occurrences);
        }
    }

    return { status: "resolved", identity: first };
}
