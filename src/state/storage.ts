import type { Plan, SpeciesParams } from '../types';

const DB_NAME = 'garden-preview-db';
const DB_VERSION = 1;
const STORE_PLANS = 'plans';
const STORE_SPECIES = 'species';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PLANS)) db.createObjectStore(STORE_PLANS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_SPECIES)) db.createObjectStore(STORE_SPECIES, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  });
}

export const storage = {
  async loadAllPlans(): Promise<Plan[]> {
    return tx(STORE_PLANS, 'readonly', (s) => s.getAll() as IDBRequest<Plan[]>);
  },
  async putPlan(plan: Plan): Promise<void> {
    await tx(STORE_PLANS, 'readwrite', (s) => s.put(plan));
  },
  async deletePlan(id: string): Promise<void> {
    await tx(STORE_PLANS, 'readwrite', (s) => s.delete(id));
  },
  async loadAllSpecies(): Promise<SpeciesParams[]> {
    return tx(STORE_SPECIES, 'readonly', (s) => s.getAll() as IDBRequest<SpeciesParams[]>);
  },
  async putSpecies(sp: SpeciesParams): Promise<void> {
    await tx(STORE_SPECIES, 'readwrite', (s) => s.put(sp));
  },
  async deleteSpecies(id: string): Promise<void> {
    await tx(STORE_SPECIES, 'readwrite', (s) => s.delete(id));
  },
};
