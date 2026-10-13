'use client';

import React from 'react';
import { AppHeader } from '@/components/AppHeader';

interface MainContentProps {
  children: React.ReactNode;
}

const MainContent: React.FC<MainContentProps> = ({ children }) => {
  return (
    <main
      className="xx-main xx-main-full"
    >
      <AppHeader />
      <div className="flex-1 min-h-0 min-w-0 w-full max-w-full overflow-hidden">
        {children}
      </div>
    </main>
  );
};

export default MainContent;
