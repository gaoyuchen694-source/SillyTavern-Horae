/**
 * Keep batch AI scans reversible without coupling the data logic to the UI.
 */

function cloneData(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

/** Merge scan-owned array records without duplicating unchanged baseline data. */
export function mergeAiScanRecords(baseRecords, scannedRecords) {
    const merged = cloneData(Array.isArray(baseRecords) ? baseRecords : []) || [];
    const seen = new Set(merged.map(item => JSON.stringify(item)));
    for (const item of (Array.isArray(scannedRecords) ? scannedRecords : [])) {
        const signature = JSON.stringify(item);
        if (seen.has(signature)) continue;
        merged.push(cloneData(item));
        seen.add(signature);
    }
    return merged;
}

/** Return current array indices that are not already represented in a baseline. */
export function getAddedAiScanRecordIndices(records, baselineRecords) {
    const baselineCounts = new Map();
    for (const record of (Array.isArray(baselineRecords) ? baselineRecords : [])) {
        const signature = JSON.stringify(record);
        baselineCounts.set(signature, (baselineCounts.get(signature) || 0) + 1);
    }

    const added = [];
    for (let index = 0; index < (Array.isArray(records) ? records.length : 0); index++) {
        const signature = JSON.stringify(records[index]);
        const remaining = baselineCounts.get(signature) || 0;
        if (remaining > 0) baselineCounts.set(signature, remaining - 1);
        else added.push(index);
    }
    return added;
}

function withoutScanMarkers(meta) {
    if (meta == null) return null;
    const clean = cloneData(meta);
    delete clean._aiScanned;
    delete clean._aiScanBackup;
    return clean;
}

/**
 * Best-effort cleanup for data written by versions that predate scan backups.
 * Unknown extension fields are preserved so legacy undo remains conservative.
 */
export function cleanupLegacyAiScanMeta(meta) {
    if (!meta) return null;
    const clean = withoutScanMarkers(meta);
    clean.timestamp = { story_date: '', story_time: '', absolute: '' };
    clean.scene = { location: '', characters_present: [], atmosphere: '' };
    clean.items = {};
    clean.deletedItems = [];
    clean.itemLifecycle = [];
    clean.events = [];
    delete clean.event;
    clean.affection = {};
    clean.npcs = {};
    clean.agenda = [];
    clean.deletedAgenda = [];
    clean.agendaLifecycle = [];
    clean.mood = {};
    clean.relationships = [];
    clean.storyClock = null;
    delete clean.tableContributions;
    delete clean._tableUpdates;
    delete clean._rpgChanges;
    return clean;
}

function createOriginalSnapshot(previousMeta) {
    if (previousMeta == null) return null;
    if (Object.prototype.hasOwnProperty.call(previousMeta, '_aiScanBackup')) {
        return withoutScanMarkers(previousMeta._aiScanBackup);
    }
    if (previousMeta._aiScanned) {
        return cleanupLegacyAiScanMeta(previousMeta);
    }
    return withoutScanMarkers(previousMeta);
}

/** Mark merged metadata as scan-owned while retaining the earliest original. */
export function markAiScannedMeta(nextMeta, previousMeta) {
    const marked = cloneData(nextMeta) || {};
    marked._aiScanBackup = createOriginalSnapshot(previousMeta);
    marked._aiScanned = true;
    return marked;
}

/** Restore a scan-owned metadata object. Null means the message had no metadata. */
export function restoreAiScannedMeta(meta) {
    if (!meta?._aiScanned) return cloneData(meta);
    if (Object.prototype.hasOwnProperty.call(meta, '_aiScanBackup')) {
        return withoutScanMarkers(meta._aiScanBackup);
    }
    return cleanupLegacyAiScanMeta(meta);
}
