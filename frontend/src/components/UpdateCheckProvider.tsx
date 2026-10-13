'use client';

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useUpdateCheck } from '@/hooks/useUpdateCheck';
import { updateService, type UpdateInfo } from '@/services/updateService';
import { UpdateDialog } from './UpdateDialog';
import { showUpdateNotification } from './UpdateNotification';

interface UpdateCheckContextType {
  updateInfo: UpdateInfo | null;
  isChecking: boolean;
  checkForUpdates: (force?: boolean) => Promise<void>;
  showUpdateDialog: () => void;
}
const UpdateCheckContext = createContext<UpdateCheckContextType | undefined>(undefined);

export function UpdateCheckProvider({ children }: { children: React.ReactNode }) {
  const [showDialog, setShowDialog] = useState(false);
  const notified = useRef(new Set<string>());
  const showUpdateDialog = useCallback(() => { setShowDialog(true); }, []);
  const { updateInfo, isChecking, error, checkForUpdates } = useUpdateCheck();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<UpdateInfo>('updates-status', event => updateService.accept(event.payload)).then(stop => {
      if (disposed) stop(); else unlisten = stop;
    }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, []);
  useEffect(() => {
    if (updateInfo?.state === 'available' && updateInfo.version && !notified.current.has(updateInfo.version)) {
      notified.current.add(updateInfo.version);
      showUpdateNotification(updateInfo, showUpdateDialog);
    }
  }, [updateInfo, showUpdateDialog]);
  useEffect(() => {
    const fromTray = () => { showUpdateDialog(); void checkForUpdates(true); };
    window.addEventListener('check-updates-from-tray', fromTray);
    return () => window.removeEventListener('check-updates-from-tray', fromTray);
  }, [checkForUpdates, showUpdateDialog]);
  return <UpdateCheckContext.Provider value={{ updateInfo, isChecking, checkForUpdates, showUpdateDialog }}>
    {children}
    <UpdateDialog open={showDialog} onOpenChange={setShowDialog} updateInfo={updateInfo}
      checkError={error} onCheck={() => checkForUpdates(true)} />
  </UpdateCheckContext.Provider>;
}
export function useUpdateCheckContext() {
  const context = useContext(UpdateCheckContext);
  if (!context) throw Error('useUpdateCheckContext must be used within UpdateCheckProvider');
  return context;
}
