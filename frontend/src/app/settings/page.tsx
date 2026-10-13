'use client';
import { useState } from 'react';
import { Settings2, Mic, AudioLines, ArrowUpRight, Keyboard } from 'lucide-react';
import { PreferenceSettings } from '@/components/PreferenceSettings';
import { RecordingSettings } from '@/components/RecordingSettings';
import { LocalTranscriptionPanel } from '@/components/LocalTranscriptionPanel';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { DisplayModeControl } from '@/components/DisplayModeControl';
import { DictationSettings } from '@/components/DictationSettings';

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('general');
  return <div className="xx-settings flex h-full min-h-0 flex-col p-7">
    <header className="mb-6 shrink-0"><p className="xx-eyebrow">Make yourself comfortable</p><h1 className="xx-heading mt-2 text-4xl">Settings</h1><p className="mt-2 text-sm text-[var(--xx-muted)]">A few preferences for the way you listen.</p></header>
    <Tabs value={activeTab} onValueChange={setActiveTab} className="flex min-h-0 flex-1 flex-col">
      <TabsList className="mb-5 h-auto max-w-full flex-wrap shrink-0 justify-start gap-1 self-start bg-transparent p-0">
        {[{id:'general',title:'General',Icon:Settings2},{id:'recording',title:'Recording',Icon:Mic},{id:'dictation',title:'Dictation',Icon:Keyboard},{id:'transcription',title:'Transcription',Icon:AudioLines},{id:'handoff',title:'Claude handoff',Icon:ArrowUpRight}].map(({id,title,Icon}) => <TabsTrigger key={id} value={id} className="gap-2 rounded-lg px-4 py-2.5 text-xs text-[var(--xx-muted)] data-[state=active]:bg-[var(--xx-paper)] data-[state=active]:text-[var(--xx-ink)]"><Icon size={14} />{title}</TabsTrigger>)}
      </TabsList>
      <div className="xx-paper min-h-0 flex-1 overflow-y-auto p-6 custom-scrollbar">
        <TabsContent value="general" className="m-0 max-w-3xl"><section className="mb-6"><h2 className="mb-3 text-sm font-medium">Display mode</h2><DisplayModeControl /></section><PreferenceSettings /></TabsContent>
        <TabsContent value="recording" className="m-0 max-w-3xl"><RecordingSettings /></TabsContent>
        <TabsContent value="dictation" className="m-0 max-w-3xl"><DictationSettings /></TabsContent>
        <TabsContent value="transcription" className="m-0 max-w-3xl"><LocalTranscriptionPanel /></TabsContent>
        <TabsContent value="handoff" className="m-0 max-w-2xl"><h2 className="xx-heading text-2xl">A thoughtful handoff</h2><p className="mt-4 text-sm leading-7 text-[var(--xx-muted)]">When your transcript is ready, use <strong className="text-[var(--xx-ink)]">Copy & open Claude</strong> in the meeting workspace. Paste it into the Claude app and send it when you’re ready.</p><p className="mt-4 text-sm leading-7 text-[var(--xx-muted)]">For longer calls, export Markdown or TXT and attach the file. Bring the finished summary back to My notes, where you can edit and save it alongside the conversation.</p><p className="mt-6 rounded-xl bg-[var(--xx-canvas)] p-4 text-xs leading-6 text-[var(--xx-muted)]">No API key or summary model is needed. Nothing is sent to Claude automatically.</p></TabsContent>
      </div>
    </Tabs>
  </div>;
}
