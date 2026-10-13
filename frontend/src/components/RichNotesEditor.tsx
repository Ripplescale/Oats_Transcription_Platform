'use client';

import { useEffect, useRef, useState } from 'react';
import { BubbleMenu, EditorContent, Mark, Node, mergeAttributes, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, Highlighter, Italic, Link2, Redo2, Strikethrough, Underline, Undo2 } from 'lucide-react';
import { editorNotesDocument, notesDocumentText, safeNoteLink, stableNotesValue, type NotesDocument } from '@/lib/rich-notes';
import './rich-notes-editor.css';

const UnderlineMark = Mark.create({
  name: 'underline', parseHTML: () => [{ tag: 'u' }, { style: 'text-decoration', consuming: false, getAttrs: value => String(value).includes('underline') ? {} : false }],
  renderHTML: ({ HTMLAttributes }) => ['u', HTMLAttributes, 0],
  addKeyboardShortcuts() { return { 'Mod-u': () => this.editor.commands.toggleMark('underline') }; },
});
const HighlightMark = Mark.create({
  name: 'highlight', parseHTML: () => [{ tag: 'mark' }], renderHTML: ({ HTMLAttributes }) => ['mark', HTMLAttributes, 0],
  addKeyboardShortcuts() { return { 'Mod-Shift-h': () => this.editor.commands.toggleMark('highlight') }; },
});
const LinkMark = Mark.create({
  name: 'link', priority: 1000, inclusive: false,
  addAttributes: () => ({ href: { default: null, parseHTML: element => safeNoteLink(element.getAttribute('href') ?? '') } }),
  parseHTML: () => [{ tag: 'a[href]', getAttrs: element => safeNoteLink((element as HTMLElement).getAttribute('href') ?? '') ? {} : false }],
  renderHTML: ({ HTMLAttributes }) => ['a', { ...HTMLAttributes, href: safeNoteLink(String(HTMLAttributes.href ?? '')) ?? undefined, rel: 'noopener noreferrer', target: '_blank' }, 0],
});
const TaskList = Node.create({
  name: 'taskList', group: 'block list', content: 'taskItem+',
  parseHTML: () => [{ tag: 'ul[data-type="taskList"]' }],
  renderHTML: ({ HTMLAttributes }) => ['ul', mergeAttributes(HTMLAttributes, { 'data-type': 'taskList' }), 0],
  addKeyboardShortcuts() { return { 'Mod-Shift-9': () => this.editor.commands.toggleList('taskList', 'taskItem') }; },
});
const TaskItem = Node.create({
  name: 'taskItem', content: 'paragraph block*', defining: true,
  addAttributes: () => ({ checked: { default: false, parseHTML: element => element.getAttribute('data-checked') === 'true', renderHTML: attrs => ({ 'data-checked': attrs.checked }) } }),
  parseHTML: () => [{ tag: 'li[data-type="taskItem"]' }],
  renderHTML: ({ HTMLAttributes }) => ['li', mergeAttributes(HTMLAttributes, { 'data-type': 'taskItem' }), 0],
  addKeyboardShortcuts() { return { Enter: () => this.editor.commands.splitListItem('taskItem'), Tab: () => this.editor.commands.sinkListItem('taskItem'), 'Shift-Tab': () => this.editor.commands.liftListItem('taskItem') }; },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('li'); dom.dataset.type = 'taskItem'; dom.dataset.checked = String(!!node.attrs.checked);
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !!node.attrs.checked; check.setAttribute('aria-label', 'Complete checklist item'); check.contentEditable = 'false';
      const contentDOM = document.createElement('div'); dom.append(check, contentDOM);
      check.addEventListener('change', () => {
        const position = getPos();
        if (!editor.isEditable || typeof position !== 'number') { check.checked = !!node.attrs.checked; return; }
        editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, checked: check.checked }));
      });
      return { dom, contentDOM, stopEvent: event => event.target === check, ignoreMutation: mutation => mutation.type !== 'selection' && (mutation.target === check || mutation.target === dom),
        update: next => { if (next.type !== node.type) return false; node = next; check.checked = !!node.attrs.checked; dom.dataset.checked = String(check.checked); return true; } };
    };
  },
});

const inlineFormats = [
  { mark: 'bold', label: 'Bold', shortcut: 'Ctrl+B', Icon: Bold },
  { mark: 'italic', label: 'Italic', shortcut: 'Ctrl+I', Icon: Italic },
  { mark: 'underline', label: 'Underline', shortcut: 'Ctrl+U', Icon: Underline },
  { mark: 'strike', label: 'Strikethrough', shortcut: 'Ctrl+Shift+S', Icon: Strikethrough },
  { mark: 'highlight', label: 'Highlight', shortcut: 'Ctrl+Shift+H', Icon: Highlighter },
];

function InlineTools({ editor, openLink }: { editor: Editor; openLink: () => void }) {
  return <>{inlineFormats.map(({ mark, label, shortcut, Icon }) => <button type="button" key={mark} title={`${label} (${shortcut})`} aria-label={label} aria-pressed={editor.isActive(mark)} onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().toggleMark(mark).run()}><Icon size={15} aria-hidden="true" /></button>)}<button type="button" title="Link (Ctrl+K)" aria-label="Link" aria-pressed={editor.isActive('link')} onMouseDown={event => event.preventDefault()} onClick={openLink}><Link2 size={15} aria-hidden="true" /></button></>;
}

export interface RichNotesEditorProps {
  notes: string;
  document?: NotesDocument | null;
  onChange: (notes: string, document: NotesDocument) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}

/** Controlled persistence, uncontrolled selection/history: ordinary autosave replies never reset the editor. */
export function RichNotesEditor({ notes, document: documentValue, onChange, disabled = false, autoFocus = false, ariaLabel = 'Meeting notes', placeholder = 'What would you like to remember?', className = '' }: RichNotesEditorProps) {
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const openLinkRef = useRef<() => void>(() => {});
  const lastEmitted = useRef<string | null>(null);
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const editor = useEditor({
    extensions: [StarterKit, UnderlineMark, HighlightMark, LinkMark, TaskList, TaskItem],
    immediatelyRender: false, editable: !disabled,
    content: editorNotesDocument(notes, documentValue),
    editorProps: {
      attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': ariaLabel, 'data-placeholder': placeholder },
      handleKeyDown: (_view, event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openLinkRef.current(); return true; } return false; },
      handleClick: (_view, _position, event) => !!(event.target as HTMLElement).closest('a'),
    },
    onUpdate: ({ editor: current }) => {
      if (disabledRef.current || !current.isEditable) return;
      const next = current.getJSON() as NotesDocument;
      lastEmitted.current = stableNotesValue(next);
      onChangeRef.current(notesDocumentText(next), next);
    },
  });
  const openLink = () => {
    if (!editor || disabled) return;
    setLinkValue(String(editor.getAttributes('link').href ?? '')); setLinkError(null); setLinkOpen(true);
  };
  openLinkRef.current = openLink;
  useEffect(() => {
    if (!editor) return;
    const next = editorNotesDocument(notes, documentValue);
    const serialized = stableNotesValue(next);
    // getJSON preserves marks from the latest transaction. A save acknowledgment
    // is not an instruction to rebuild the document or erase undo history.
    if (serialized === lastEmitted.current || serialized === stableNotesValue(editor.getJSON())) return;
    editor.chain().setContent(next, false).setMeta('addToHistory', false).run();
    lastEmitted.current = serialized;
  }, [editor, notes, documentValue]);
  // setEditable emits onUpdate by default. Enabling after an asynchronous load
  // must never report the initial empty editor as a user edit over saved notes.
  useEffect(() => { editor?.setEditable(!disabled, false); }, [editor, disabled]);
  useEffect(() => { if (editor && autoFocus && !disabled) editor.commands.focus('end'); }, [editor, autoFocus, disabled]);
  const formatBlock = (value: string) => {
    if (!editor) return;
    const chain = editor.chain().focus();
    if (value === 'paragraph') chain.setParagraph().run();
    else if (value === 'heading1' || value === 'heading2') chain.toggleHeading({ level: value === 'heading1' ? 1 : 2 }).run();
    else if (value === 'bullet') chain.toggleBulletList().run();
    else if (value === 'ordered') chain.toggleOrderedList().run();
    else if (value === 'task') chain.toggleList('taskList', 'taskItem').run();
    else if (value === 'quote') chain.toggleBlockquote().run();
    else if (value === 'code') chain.toggleCodeBlock().run();
    else if (value === 'rule') chain.setHorizontalRule().run();
  };
  const formattingUnavailable = documentValue != null && editorNotesDocument(notes, documentValue) !== documentValue;
  return <div className={`xx-rich-notes ${editor?.isEmpty ? 'is-empty' : ''} ${className}`} aria-busy={disabled}>
    <div className="xx-rich-toolbar" role="toolbar" aria-label="Note formatting" aria-disabled={disabled}>
      {editor && !disabled && <><InlineTools editor={editor} openLink={openLink} /><span className="xx-rich-toolbar-divider" /><select aria-label="Insert or format block" value="" onChange={event => formatBlock(event.target.value)}><option value="" disabled>Insert / style</option><option value="paragraph">Paragraph</option><option value="heading1">Heading 1</option><option value="heading2">Heading 2</option><option value="bullet">Bulleted list</option><option value="ordered">Numbered list</option><option value="task">Checklist</option><option value="quote">Quote</option><option value="rule">Horizontal line</option><option value="code">Code block</option></select><span className="xx-rich-toolbar-spacer" /><button type="button" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!editor.can().undo()} onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().undo().run()}><Undo2 size={15} /></button><button type="button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!editor.can().redo()} onMouseDown={event => event.preventDefault()} onClick={() => editor.chain().focus().redo().run()}><Redo2 size={15} /></button></>}
    </div>
    {formattingUnavailable && <p className="xx-rich-recovery" role="status">Saved text is shown because its formatting could not be restored. Editing this note will replace that formatting.</p>}
    {editor && !disabled && <BubbleMenu editor={editor} tippyOptions={{ duration: 100, maxWidth: 320 }} shouldShow={({ editor: current, state }) => !linkOpen && current.isFocused && !state.selection.empty && !current.isActive('codeBlock')}><div className="xx-rich-bubble" role="toolbar" aria-label="Selection formatting"><InlineTools editor={editor} openLink={openLink} /></div></BubbleMenu>}
    {linkOpen && <form className="xx-rich-link" aria-label="Edit note link" onSubmit={event => {
      event.preventDefault(); const href = safeNoteLink(linkValue);
      if (!href) { setLinkError('Use a full https://, http://, or mailto: link.'); return; }
      editor?.chain().focus().extendMarkRange('link').setMark('link', { href }).run(); setLinkOpen(false);
    }}><label>Link<input aria-label="Link address" value={linkValue} autoFocus onChange={event => setLinkValue(event.target.value)} placeholder="https://…" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setLinkOpen(false); editor?.commands.focus(); } }} /></label><button type="submit">Apply</button><button type="button" onClick={() => { editor?.chain().focus().extendMarkRange('link').unsetMark('link').run(); setLinkOpen(false); }}>Remove</button><button type="button" onClick={() => { setLinkOpen(false); editor?.commands.focus(); }}>Cancel</button>{linkError && <span role="alert">{linkError}</span>}</form>}
    <EditorContent editor={editor} className="xx-rich-scroll" />
  </div>;
}
