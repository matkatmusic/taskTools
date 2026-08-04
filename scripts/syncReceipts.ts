// syncReceipts.ts: assembles and (de)serializes machine-readable receipts for an occurrence sync.
export interface Occurrence {
    id: string;
    parentChain: string[];
}

export interface SyncDestination {
    occurrence: Occurrence;
    branch: string;
    contentDigest: string;
}

export interface SyncReceipt {
    logicalRepoId: string;
    source: Occurrence;
    changedPaths: string[];
    destinations: SyncDestination[];
}

export function buildSyncReceipt(
    logicalRepoId: string,
    source: Occurrence,
    changedPaths: string[],
    destinations: SyncDestination[],
): SyncReceipt {
    return { logicalRepoId, source, changedPaths, destinations };
}

export function serializeSyncReceipt(receipt: SyncReceipt): string {
    return JSON.stringify(receipt);
}

export function parseSyncReceipt(json: string): SyncReceipt {
    return JSON.parse(json);
}
