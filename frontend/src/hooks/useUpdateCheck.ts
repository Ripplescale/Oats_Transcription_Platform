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
  useEffect(() => {
    void updateService.getStatus().catch(() => {});
    const first = window.setTimeout(() => { void checkForUpdates(); }, 15_000);
    const daily = window.setInterval(() => { void checkForUpdates(); }, 24 * 60 * 60 * 1000);
    return () => { window.clearTimeout(first); window.clearInterval(daily); };
  }, [checkForUpdates]);
  return { updateInfo, isChecking: updateInfo?.state === 'checking', error, checkForUpdates };
}
