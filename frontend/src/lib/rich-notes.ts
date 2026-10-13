/** JSON only: existing plain notes remain readable by exports and older clients. */
export interface NotesNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: NotesNode[];
}
export interface NotesDocument extends NotesNode { type: 'doc'; content: NotesNode[] }

/** Native JSON maps can reorder keys. Equality must compare values, not insertion order. */
export function stableNotesValue(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : item);
}

const nodes = new Set(['doc', 'paragraph', 'heading', 'text', 'hardBreak', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'horizontalRule', 'taskList', 'taskItem']);
const marks = new Set(['bold', 'italic', 'strike', 'code', 'underline', 'highlight', 'link']);

export function safeNoteLink(value: string): string | null {
  try {
    const url = new URL(value.trim());
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function isNotesDocument(value: unknown): value is NotesDocument {
  let count = 0;
  const check = (input: unknown, depth: number): boolean => {
    if (!input || typeof input !== 'object' || depth > 40 || ++count > 50000) return false;
    const node = input as NotesNode;
    if (!nodes.has(node.type) || (node.text !== undefined && typeof node.text !== 'string')) return false;
    if (node.type === 'text' && (!node.text || node.content !== undefined)) return false;
    if (node.marks && (!Array.isArray(node.marks) || !node.marks.every(mark => !!mark && typeof mark === 'object' && marks.has(mark.type) && (mark.type !== 'link' || (typeof mark.attrs?.href === 'string' && !!safeNoteLink(mark.attrs.href)))))) return false;
    return node.content === undefined || (Array.isArray(node.content) && node.content.every(child => check(child, depth + 1)));
  };
  return !!value && (value as NotesNode).type === 'doc' && Array.isArray((value as NotesNode).content) && check(value, 0);
}

export function plainNotesDocument(notes: string): NotesDocument {
  return { type: 'doc', content: notes.split('\n').map(text => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) })) };
}

export function notesDocumentText(document: NotesDocument): string {
  const text = (node: NotesNode): string => {
    if (node.type === 'text') return node.text ?? '';
    if (node.type === 'hardBreak') return '\n';
    if (node.type === 'horizontalRule') return '---';
    const separator = ['doc', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem', 'blockquote'].includes(node.type) ? '\n' : '';
    const body = (node.content ?? []).map(text).join(separator);
    return node.type === 'taskItem' ? `${node.attrs?.checked ? '[x]' : '[ ]'} ${body}` : body;
  };
  return text(document);
}

export function editorNotesDocument(notes: string, document?: NotesDocument | null): NotesDocument {
  // An older client or worker may have updated only the plain notes field.
  // Never show stale structured text in preference to those saved notes.
  return isNotesDocument(document) && notesDocumentText(document) === notes ? document : plainNotesDocument(notes);
}
