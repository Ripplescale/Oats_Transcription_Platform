import { useCallback, useEffect, useState } from 'react';
import { updateService, type UpdateInfo } from '@/services/updateService';

export function useUpdateCheck() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => updateService.subscribe(setUpdateInfo), []);
  const checkForUpdates = useCallback(async (force = false) => {
    setError(null);
    try { await updateService.checkForUpdates(force); }
    catch (reason) { setError('Could not check for updates. ' + String(reason)); }
  }, []);
  const checkOnOpen = useCallback(async () => {
    setError(null);
    try { await updateService.checkOnOpen(); }
    catch (reason) { setError('Could not check for updates. ' + String(reason)); }
  }, []);
  useEffect(() => {
    void updateService.getStatus().catch(() => {});
    const resumed = () => { void checkOnOpen(); };
    const first = window.setTimeout(resumed, 3_000);
    const daily = window.setInterval(() => { void checkForUpdates(); }, 24 * 60 * 60 * 1000);
    window.addEventListener('focus', resumed);
    window.addEventListener('online', resumed);
    return () => {
      window.clearTimeout(first); window.clearInterval(daily);
      window.removeEventListener('focus', resumed); window.removeEventListener('online', resumed);
    };
  }, [checkForUpdates, checkOnOpen]);
  return { updateInfo, isChecking: updateInfo?.state === 'checking', error, checkForUpdates };
}
