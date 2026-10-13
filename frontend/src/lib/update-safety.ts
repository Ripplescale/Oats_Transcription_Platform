type SaveGuard = () => Promise<void>;
const guards = new Set<SaveGuard>();

/** Mounted editors register a flush that rejects if changes remain unsaved. */
export function registerUpdateSaveGuard(guard: SaveGuard): () => void {
  guards.add(guard);
  return () => { guards.delete(guard); };
}

export async function prepareForUpdateInstall(): Promise<void> {
  try {
    for (const guard of [...guards]) await guard();
  } catch (error) {
    throw Error('Save your changes before installing the update. ' + (error instanceof Error ? error.message : String(error)));
  }
  let pending = false;
  try {
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (key && /^xx\.(?:note|workspace)-draft\./.test(key) && window.localStorage.getItem(key)) {
        pending = true;
        break;
      }
    }
  } catch {
    throw Error('Could not verify saved notes. Save your work and restart oats before installing the update.');
  }
  if (pending) throw Error('Unsaved notes or review edits remain on this device. Open and save them before installing the update.');
}
