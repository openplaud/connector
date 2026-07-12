/**
 * Tiny typed wrapper over chrome.storage.local for the only thing we
 * persist: the list of self-hosted Riffado origins the user has paired
 * with this extension. Hosted (`https://riffado.com`) is always implicit.
 *
 * NOTE: the storage key is intentionally kept as "openplaudOrigins" (the
 * pre-rebrand name) so existing users don't lose their paired origins on
 * upgrade. Do not rename without a migration.
 */

export const ORIGINS_STORAGE_KEY = "openplaudOrigins";

export interface StoredOrigin {
    origin: string;
    addedAt: number;
}

export async function getPairedOrigins(): Promise<StoredOrigin[]> {
    const data = await chrome.storage.local.get(ORIGINS_STORAGE_KEY);
    const list = data[ORIGINS_STORAGE_KEY];
    return Array.isArray(list) ? (list as StoredOrigin[]) : [];
}

export async function addPairedOrigin(origin: string): Promise<StoredOrigin[]> {
    const normalized = origin.replace(/\/+$/, "");
    const existing = await getPairedOrigins();
    if (existing.some((o) => o.origin === normalized)) return existing;
    const next: StoredOrigin[] = [
        ...existing,
        { origin: normalized, addedAt: Date.now() },
    ];
    await chrome.storage.local.set({ [ORIGINS_STORAGE_KEY]: next });
    return next;
}

export async function removePairedOrigin(
    origin: string,
): Promise<StoredOrigin[]> {
    const existing = await getPairedOrigins();
    const next = existing.filter((o) => o.origin !== origin);
    await chrome.storage.local.set({ [ORIGINS_STORAGE_KEY]: next });
    return next;
}
