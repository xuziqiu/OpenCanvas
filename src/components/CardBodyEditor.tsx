import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { TextSelection } from '@tiptap/pm/state';
import { AlignCenter, AlignLeft, AlignRight, Bold, Braces, Check, CheckSquare, ChevronDown, Copy, FileCode2, Heading1, Heading2, Heading3, Heading4, Heading5, Heading6, Highlighter, Italic, Link2, List, ListOrdered, Minus, Paperclip, Quote, Sigma, Strikethrough, Table2, Underline as UnderlineIcon } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Card, ImportedAttachment } from '../types';
import { isNativeVault, vaultApi } from '../vault';
import { createCardEditorExtensions, parseCardEditorMarkdown } from '../editor/cardEditorExtensions';
import { joinMarkdownDocument, localAttachmentPath, splitMarkdownDocument, toEditorMarkdown, toSourceMarkdown } from '../editor/markdownDocument';
import { isComposingKeyboardEvent } from '../domain/keyboard';
import { shouldOpenEditorLink } from '../domain/editorLinkInteraction';
import { caretMenuPosition } from '../domain/overlayPosition';
import { recallCardEditorSelection, rememberCardEditorSelection, type CardEditorSurface } from '../domain/editorViewState';
import ExitPresence from './ExitPresence';
import BlockDragHandle from './editor/BlockDragHandle';
import 'katex/dist/katex.min.css';

const MAX_MEMORY_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function fileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}

function insertAttachment(editor: Editor, attachment: ImportedAttachment) {
  if (attachment.mimeType?.startsWith('image/')) {
    editor.chain().focus().setImage({ src: attachment.url, alt: attachment.name }).run();
    return;
  }
  if (attachment.mimeType?.startsWith('audio/') || attachment.mimeType?.startsWith('video/')) {
    editor.chain().focus().insertMediaAttachment({ src: attachment.url, mediaType: attachment.mimeType.startsWith('video/') ? 'video' : 'audio', name: attachment.name }).run();
    return;
  }
  editor.chain().focus().insertFileAttachment({ src: attachment.url, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size }).run();
}

interface TriggerMatch {
  from: number;
  to: number;
  query: string;
  kind: 'slash' | 'mention';
}

function currentTrigger(editor: Editor): TriggerMatch | null {
  const { from, empty } = editor.state.selection;
  if (!empty) return null;
  const start = Math.max(1, from - 80);
  const before = editor.state.doc.textBetween(start, from, '\n', '\0');
  const slash = before.match(/(?:^|\s)\/([^\s/]*)$/);
  if (slash) return { from: from - slash[1].length - 1, to: from, query: slash[1], kind: 'slash' };
  const mention = before.match(/(?:^|\s)@([^@\n]*)$/);
  if (mention) return { from: from - mention[1].length - 1, to: from, query: mention[1], kind: 'mention' };
  return null;
}

const slashItems = [
  { id: 'paragraph', label: '正文', hint: '普通文本', icon: <Braces size={15} />, run: (editor: Editor) => editor.chain().focus().setParagraph().run() },
  { id: 'h1', label: '一级标题', hint: '大标题', icon: <Heading1 size={15} />, run: (editor: Editor) => editor.chain().focus().setHeading({ level: 1 }).run() },
  { id: 'h2', label: '二级标题', hint: '小标题', icon: <Heading2 size={15} />, run: (editor: Editor) => editor.chain().focus().setHeading({ level: 2 }).run() },
  { id: 'h3', label: '三级标题', hint: '段落标题', icon: <Heading3 size={15} />, run: (editor: Editor) => editor.chain().focus().setHeading({ level: 3 }).run() },
  { id: 'h4', label: '四级标题', hint: '小节标题', icon: <Heading4 size={15} />, run: (editor: Editor) => editor.chain().focus().setHeading({ level: 4 }).run() },
  { id: 'h5', label: '五级标题', hint: '弱标题', icon: <Heading5 size={15} />, run: (editor: Editor) => editor.chain().focus().setHeading({ level: 5 }).run() },
  { id: 'h6', label: '六级标题', hint: '最小标题', icon: <Heading6 size={15} />, run: (editor: Editor) => editor.chain().focus().setHeading({ level: 6 }).run() },
  { id: 'bullet', label: '项目列表', hint: '无序列表', icon: <List size={15} />, run: (editor: Editor) => editor.chain().focus().toggleBulletList().run() },
  { id: 'ordered', label: '编号列表', hint: '有序列表', icon: <ListOrdered size={15} />, run: (editor: Editor) => editor.chain().focus().toggleOrderedList().run() },
  { id: 'quote', label: '引用', hint: '引用段落', icon: <Quote size={15} />, run: (editor: Editor) => editor.chain().focus().toggleBlockquote().run() },
  { id: 'task', label: '任务列表', hint: '可勾选事项', icon: <CheckSquare size={15} />, run: (editor: Editor) => editor.chain().focus().toggleTaskList().run() },
  { id: 'table', label: '表格', hint: '三行三列', icon: <Table2 size={15} />, run: (editor: Editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'code', label: '代码块', hint: '等宽代码', icon: <Braces size={15} />, run: (editor: Editor) => editor.chain().focus().toggleCodeBlock().run() },
  { id: 'divider', label: '分隔线', hint: '划分内容区域', icon: <Minus size={15} />, run: (editor: Editor) => editor.chain().focus().setHorizontalRule().run() },
  { id: 'math', label: '数学公式', hint: 'LaTeX 行内公式', icon: <Sigma size={15} />, run: (editor: Editor) => editor.chain().focus().insertInlineMath({ latex: 'x' }).run() },
];

const blockTypeIds = new Set(['paragraph', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'task', 'bullet', 'ordered', 'quote', 'code']);
const blockTypeItems = slashItems.filter((item) => blockTypeIds.has(item.id));

function activeBlockType(editor: Editor) {
  for (let level = 1; level <= 6; level += 1) {
    if (editor.isActive('heading', { level })) return `${level} 级标题`;
  }
  if (editor.isActive('taskList')) return '任务列表';
  if (editor.isActive('bulletList')) return '项目列表';
  if (editor.isActive('orderedList')) return '编号列表';
  if (editor.isActive('blockquote')) return '引用';
  if (editor.isActive('codeBlock')) return '代码块';
  if (editor.isActive('paragraph')) return '正文';
  return '多种格式';
}

function isBlockTypeActive(editor: Editor, id: string) {
  if (id === 'paragraph') return editor.isActive('paragraph');
  if (/^h[1-6]$/.test(id)) return editor.isActive('heading', { level: Number(id.slice(1)) });
  if (id === 'task') return editor.isActive('taskList');
  if (id === 'bullet') return editor.isActive('bulletList');
  if (id === 'ordered') return editor.isActive('orderedList');
  if (id === 'quote') return editor.isActive('blockquote');
  if (id === 'code') return editor.isActive('codeBlock');
  return false;
}

const codeLanguages = [
  ['', '纯文本'], ['bash', 'Bash'], ['css', 'CSS'], ['html', 'HTML'], ['javascript', 'JavaScript'],
  ['json', 'JSON'], ['markdown', 'Markdown'], ['python', 'Python'], ['sql', 'SQL'], ['typescript', 'TypeScript'], ['yaml', 'YAML'],
] as const;

function selectedCodeText(editor: Editor) {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'codeBlock') return node.textContent;
  }
  return '';
}

function restoreTextSelection(editor: Editor, selection?: { from: number; to: number }) {
  if (!selection) return;
  const maxPosition = editor.state.doc.content.size;
  const from = Math.min(maxPosition, Math.max(1, selection.from));
  const to = Math.min(maxPosition, Math.max(from, selection.to));
  editor.commands.setTextSelection({ from, to });
}

interface CardBodyEditorProps {
  card: Card;
  cards?: Card[];
  getCards?: () => Card[];
  compact?: boolean;
  editable?: boolean;
  surface?: CardEditorSurface;
  updateCard: (id: string, changes: Partial<Pick<Card, 'title' | 'body'>>) => void;
  onOpenCard?: (cardId: string) => void;
  initialImageSelectionIndex?: number;
  onInitialImageSelectionApplied?: () => void;
}

function CardBodyEditor({
  card,
  cards = [],
  getCards,
  compact = false,
  editable = true,
  surface = compact ? 'canvas' : 'page',
  updateCard,
  onOpenCard,
  initialImageSelectionIndex,
  onInitialImageSelectionApplied,
}: CardBodyEditorProps) {
  const [trigger, setTrigger] = useState<TriggerMatch | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [blockMenuOpen, setBlockMenuOpen] = useState(false);
  const [linkEditorOpen, setLinkEditorOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const [sourceMode, setSourceMode] = useState(false);
  const [editorViewMounted, setEditorViewMounted] = useState(false);
  const [confirmTableDelete, setConfirmTableDelete] = useState(false);
  const [attachmentImportCount, setAttachmentImportCount] = useState(0);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const lastEmitted = useMemo(() => ({ current: card.body }), [card.id]);
  const frontmatterRef = useMemo(() => ({ current: splitMarkdownDocument(card.body).frontmatter }), [card.id]);
  const editorRef = useRef<Editor | null>(null);
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<TriggerMatch | null>(null);
  const commandIndexRef = useRef(0);
  const cardsRef = useRef(cards);
  const getCardsRef = useRef(getCards);
  const editableRef = useRef(editable);
  const commandMenuId = useMemo(() => `editor-command-${card.id}-${surface ?? (compact ? 'compact' : 'document')}`.replace(/[^a-zA-Z0-9_-]/g, '-'), [card.id, compact, surface]);
  const initialEditorContent = useMemo(() => parseCardEditorMarkdown(toEditorMarkdown(splitMarkdownDocument(card.body).body)), [card.id]);
  const availableCards = getCards?.() ?? cards;
  cardsRef.current = availableCards;
  getCardsRef.current = getCards;
  editableRef.current = editable;

  const importFiles = async (files: File[]) => {
    setAttachmentImportCount((count) => count + files.length);
    let firstError: unknown;
    try {
      for (const [index, file] of files.entries()) {
        try {
          let attachment = await vaultApi.importAttachmentFile?.(file);
          if (!attachment) {
            if (file.size > MAX_MEMORY_ATTACHMENT_BYTES) throw new Error(`${file.name || `附件 ${index + 1}`} 超过 25 MB，浏览器内存导入不可用；请使用桌面版直接拖入`);
            attachment = await vaultApi.importAttachmentData?.({ name: file.name || `粘贴附件-${index + 1}`, mimeType: file.type, dataBase64: await fileAsBase64(file) });
          }
          if (attachment && editorRef.current) insertAttachment(editorRef.current, attachment);
        } catch (error) {
          firstError ??= error;
        }
      }
    } finally {
      setAttachmentImportCount((count) => Math.max(0, count - files.length));
    }
    if (firstError) throw firstError;
  };

  const syncTrigger = (nextEditor: Editor) => {
    const next = currentTrigger(nextEditor);
    const previous = triggerRef.current;
    if (next?.kind !== previous?.kind || next?.query !== previous?.query) {
      commandIndexRef.current = 0;
      setCommandIndex(0);
    }
    triggerRef.current = next;
    setTrigger(next);
    if (!next) { setMenuPosition(null); return; }
    const editorBox = nextEditor.view.dom.closest('.structured-card-editor')?.getBoundingClientRect();
    const caret = nextEditor.view.coordsAtPos(next.to);
    if (!editorBox) return;
    setMenuPosition(caretMenuPosition(
      caret,
      { left: editorBox.left, top: editorBox.top, width: editorBox.width },
      { width: window.innerWidth, height: window.innerHeight },
      { width: 250, height: 290 },
    ));
  };
  const editor = useEditor({
    extensions: createCardEditorExtensions(),
    content: initialEditorContent,
    contentType: 'json',
    editable,
    // OpenCanvas is a client-only Electron/browser app. Rendering immediately
    // keeps the persistent card surface from flashing empty before TipTap's
    // first effect, especially when a card is clicked straight after opening a
    // board. SSR hydration constraints do not apply here.
    immediatelyRender: true,
    onCreate: ({ editor: nextEditor }) => {
      restoreTextSelection(nextEditor, recallCardEditorSelection(card.id, surface));
    },
    editorProps: {
      attributes: { class: 'card-prosemirror', spellcheck: 'true' },
      handleClick: (_view, _pos, event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('a[href], a[data-wiki-link]') && !shouldOpenEditorLink({ editable: editableRef.current, ctrlKey: event.ctrlKey, metaKey: event.metaKey })) return false;
        const stableAnchor = target?.closest<HTMLAnchorElement>('a[href^="opencanvas://card/"]');
        if (stableAnchor) {
          event.preventDefault();
          onOpenCard?.(stableAnchor.href.replace('opencanvas://card/', ''));
          return true;
        }
        const wikiAnchor = target?.closest<HTMLAnchorElement>('a[data-wiki-link]');
        if (wikiAnchor) {
          event.preventDefault();
          const rawTarget = (wikiAnchor.dataset.wikiLink || '').split('|', 1)[0].split('#', 1)[0].replace(/\\/g, '/').replace(/^\.\//, '');
          const normalizedTarget = rawTarget.replace(/\.md$/i, '').toLocaleLowerCase();
          const matched = (getCardsRef.current?.() ?? cardsRef.current).find((candidate) =>
            candidate.relativePath.replace(/\.md$/i, '').toLocaleLowerCase() === normalizedTarget
            || candidate.title.toLocaleLowerCase() === normalizedTarget
          );
          if (matched) onOpenCard?.(matched.id);
          return true;
        }
        const ordinaryAnchor = target?.closest<HTMLAnchorElement>('a[href]');
        if (!ordinaryAnchor) return false;
        const href = ordinaryAnchor.getAttribute('href') || '';
        const attachmentPath = localAttachmentPath(href);
        if (attachmentPath) {
          event.preventDefault();
          void vaultApi.openAttachment?.(attachmentPath);
          return true;
        }
        if (/^(https?:|mailto:)/i.test(href)) {
          event.preventDefault();
          void vaultApi.openExternal?.(href);
          return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const files = [...(event.clipboardData?.files || [])];
        if (!files.length || !isNativeVault) return false;
        event.preventDefault();
        void importFiles(files);
        return true;
      },
      handleDrop: (_view, event) => {
        const files = [...(event.dataTransfer?.files || [])];
        if (!files.length || !isNativeVault) return false;
        event.preventDefault();
        void importFiles(files);
        return true;
      },
      handleKeyDown: (_view, event) => {
        if (isComposingKeyboardEvent(event)) return false;
        const activeTrigger = triggerRef.current;
        const activeEditor = editorRef.current;
        if (!activeTrigger || !activeEditor) return false;
        if (event.key === 'Escape') {
          event.preventDefault();
          triggerRef.current = null;
          setTrigger(null);
          setMenuPosition(null);
          return true;
        }
        const items = activeTrigger.kind === 'slash'
          ? slashItems.filter((item) => `${item.label}${item.hint}`.includes(activeTrigger.query))
          : (getCardsRef.current?.() ?? cardsRef.current).filter((item) => item.id !== card.id && item.title.toLocaleLowerCase().includes(activeTrigger.query.trim().toLocaleLowerCase())).slice(0, 8);
        if (!items.length) return false;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          commandIndexRef.current = (commandIndexRef.current + direction + items.length) % items.length;
          setCommandIndex(commandIndexRef.current);
          return true;
        }
        if (event.key !== 'Enter' && event.key !== 'Tab') return false;
        event.preventDefault();
        const selected = items[Math.min(commandIndexRef.current, items.length - 1)];
        activeEditor.chain().focus().deleteRange({ from: activeTrigger.from, to: activeTrigger.to }).run();
        if (activeTrigger.kind === 'slash') (selected as typeof slashItems[number]).run(activeEditor);
        else {
          const target = selected as Card;
          activeEditor.chain().focus().insertContent(`[${target.title || '未命名卡片'}](opencanvas://card/${target.id})`, { contentType: 'markdown' }).run();
        }
        triggerRef.current = null;
        setTrigger(null);
        setMenuPosition(null);
        return true;
      },
    },
    onUpdate: ({ editor: nextEditor }) => {
      const markdown = joinMarkdownDocument({ frontmatter: frontmatterRef.current, body: toSourceMarkdown(nextEditor.getMarkdown()) });
      lastEmitted.current = markdown;
      updateCard(card.id, { body: markdown });
      syncTrigger(nextEditor);
    },
    onSelectionUpdate: ({ editor: nextEditor }) => {
      syncTrigger(nextEditor);
      if (nextEditor.isFocused) rememberCardEditorSelection(card.id, surface, nextEditor.state.selection);
    },
    onBlur: ({ editor: nextEditor }) => {
      rememberCardEditorSelection(card.id, surface, nextEditor.state.selection);
      setTimeout(() => { triggerRef.current = null; setTrigger(null); setMenuPosition(null); }, 120);
    },
  }, [card.id]);

  useEffect(() => { editorRef.current = editor; }, [editor]);

  useLayoutEffect(() => {
    // `useEditor` exposes the Editor instance before `EditorContent` has
    // installed its ProseMirror view. Image selection needs that view because
    // focusing the selected node reads `editor.view`; defer the hand-off until
    // the real editing surface is mounted.
    if (!editor || !editorViewMounted || initialImageSelectionIndex === undefined) return;
    let imageIndex = 0;
    let imagePosition: number | null = null;
    editor.state.doc.descendants((node, position) => {
      if (imagePosition !== null || node.type.name !== 'image') return;
      if (imageIndex === initialImageSelectionIndex) imagePosition = position;
      imageIndex += 1;
    });
    if (imagePosition === null) return;
    editor.chain().focus().setNodeSelection(imagePosition).run();
    onInitialImageSelectionApplied?.();
  }, [editor, editorViewMounted, initialImageSelectionIndex, onInitialImageSelectionApplied]);

  useLayoutEffect(() => {
    if (!editor) {
      setEditorViewMounted(false);
      return;
    }
    // `useEditor` can publish the Editor instance one commit before
    // EditorContent installs its ProseMirror view. BubbleMenu and the block
    // drag handle both read `editor.view`, so mounting them in that gap can
    // crash the entire app (large Markdown documents make the gap much easier
    // to hit). EditorContent mounts first; view-dependent helpers follow in a
    // second commit once the real editing surface exists.
    const mounted = Boolean(editorContainerRef.current?.querySelector('.card-prosemirror'));
    setEditorViewMounted(mounted);
    if (mounted) return;
    const frame = window.requestAnimationFrame(() => {
      setEditorViewMounted(Boolean(editorContainerRef.current?.querySelector('.card-prosemirror')));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editor]);

  useEffect(() => {
    if (!editor || card.body === lastEmitted.current || editor.isFocused) return;
    const parts = splitMarkdownDocument(card.body);
    frontmatterRef.current = parts.frontmatter;
    editor.commands.setContent(parseCardEditorMarkdown(toEditorMarkdown(parts.body)), { contentType: 'json' });
    restoreTextSelection(editor, recallCardEditorSelection(card.id, surface));
    lastEmitted.current = card.body;
  }, [card.body, card.id, editor, lastEmitted, surface]);

  useLayoutEffect(() => {
    if (!editor) return;
    editor.setEditable(editable);
    if (!editable) { setTrigger(null); setBlockMenuOpen(false); setLinkEditorOpen(false); }
  }, [editable, editor]);

  useEffect(() => {
    if (!blockMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest('.editor-block-control')) setBlockMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (isComposingKeyboardEvent(event) || event.key !== 'Escape') return;
      event.preventDefault();
      setBlockMenuOpen(false);
      editor?.commands.focus();
    };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', escape, true);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', escape, true);
    };
  }, [blockMenuOpen, editor]);

  useEffect(() => {
    if (linkEditorOpen) window.requestAnimationFrame(() => linkInputRef.current?.focus());
  }, [linkEditorOpen]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // The TipTap Editor instance may exist one commit before EditorContent has
    // mounted its ProseMirror view (and for one commit while it is being torn
    // down). Reading editor.view in that window throws and forces the whole app
    // through the error boundary. Resolve the mounted DOM from our own stable
    // container instead, and simply defer ARIA decoration until it exists.
    const editorElement = editorContainerRef.current?.querySelector<HTMLElement>('.card-prosemirror');
    if (!editorElement) return;
    const optionCount = trigger?.kind === 'slash'
      ? slashItems.filter((item) => `${item.label}${item.hint}`.includes(trigger.query)).length
      : trigger?.kind === 'mention'
        ? availableCards.filter((item) => item.id !== card.id && item.title.toLocaleLowerCase().includes(trigger.query.trim().toLocaleLowerCase())).slice(0, 8).length
        : 0;
    if (editable && trigger && optionCount > 0) {
      const activeIndex = Math.min(commandIndex, optionCount - 1);
      editorElement.setAttribute('aria-autocomplete', 'list');
      editorElement.setAttribute('aria-controls', commandMenuId);
      editorElement.setAttribute('aria-expanded', 'true');
      editorElement.setAttribute('aria-activedescendant', `${commandMenuId}-option-${activeIndex}`);
    } else {
      editorElement.removeAttribute('aria-autocomplete');
      editorElement.removeAttribute('aria-controls');
      editorElement.removeAttribute('aria-expanded');
      editorElement.removeAttribute('aria-activedescendant');
    }
    return () => {
      editorElement.removeAttribute('aria-autocomplete');
      editorElement.removeAttribute('aria-controls');
      editorElement.removeAttribute('aria-expanded');
      editorElement.removeAttribute('aria-activedescendant');
    };
  }, [availableCards, card.id, commandIndex, commandMenuId, editable, editor, trigger]);

  if (!editor) return null;

  const runSlash = (item: typeof slashItems[number]) => {
    if (!trigger) return;
    editor.chain().focus().deleteRange({ from: trigger.from, to: trigger.to }).run();
    item.run(editor);
    triggerRef.current = null;
    setTrigger(null);
    setMenuPosition(null);
  };

  const insertMention = (target: Card) => {
    if (!trigger) return;
    editor.chain().focus().deleteRange({ from: trigger.from, to: trigger.to }).insertContent(
      `[${target.title || '未命名卡片'}](opencanvas://card/${target.id})`,
      { contentType: 'markdown' },
    ).run();
    triggerRef.current = null;
    setTrigger(null);
    setMenuPosition(null);
  };

  const insertImage = async () => {
    const attachment = await vaultApi.importAttachment?.();
    if (!attachment) return;
    insertAttachment(editor, attachment);
  };

  const openLinkEditor = () => {
    const current = editor.getAttributes('link').href as string | undefined;
    setLinkValue(current || 'https://');
    setLinkEditorOpen(true);
  };

  const applyLink = () => {
    const value = linkValue.trim();
    if (!value) editor.chain().focus().extendMarkRange('link').unsetLink().run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: value }).run();
    setLinkEditorOpen(false);
  };

  const matchingCards = trigger?.kind === 'mention'
    ? availableCards.filter((item) => item.id !== card.id && item.title.toLocaleLowerCase().includes(trigger.query.trim().toLocaleLowerCase())).slice(0, 8)
    : [];
  const matchingSlashItems = trigger?.kind === 'slash'
    ? slashItems.filter((item) => `${item.label}${item.hint}`.includes(trigger.query))
    : [];

  const toggleSourceMode = () => {
    if (sourceMode) {
      const parts = splitMarkdownDocument(card.body);
      frontmatterRef.current = parts.frontmatter;
      editor.commands.setContent(parseCardEditorMarkdown(toEditorMarkdown(parts.body)), { contentType: 'json' });
      restoreTextSelection(editor, recallCardEditorSelection(card.id, surface));
      lastEmitted.current = card.body;
    }
    setBlockMenuOpen(false);
    setLinkEditorOpen(false);
    setSourceMode((value) => !value);
  };
  const activeMediaAttributes = editor.isActive('image') ? editor.getAttributes('image') : editor.isActive('mediaAttachment') ? editor.getAttributes('mediaAttachment') : editor.getAttributes('fileAttachment');
  const activeAttachmentPath = localAttachmentPath(activeMediaAttributes.src as string | undefined);

  return (
    <div ref={editorContainerRef} className={`structured-card-editor ${compact ? 'compact' : 'document'} ${editable ? 'is-editable' : 'is-readonly'} ${sourceMode ? 'is-source-mode' : ''}`}>
      {sourceMode && !compact && <div className="editor-source-mode-header"><span><FileCode2 size={14} />Markdown 源码</span><button onClick={toggleSourceMode} aria-label="返回所见即所得编辑" title="返回所见即所得编辑">返回所见即所得</button></div>}
      {!sourceMode && !compact && editor.isActive('codeBlock') && <div className="editor-code-bar"><span><Braces size={14} /> 代码块</span><label>语言<select aria-label="代码语言" value={editor.getAttributes('codeBlock').language || ''} onChange={(event) => editor.chain().focus().updateAttributes('codeBlock', { language: event.target.value || null }).run()}>{codeLanguages.map(([value, label]) => <option value={value} key={value || 'plain'}>{label}</option>)}</select></label><button onClick={() => void navigator.clipboard.writeText(selectedCodeText(editor))}><Copy size={13} />复制代码</button></div>}
      {!sourceMode && !compact && editor.isActive('table') && <div className="editor-table-bar"><span><Table2 size={14} /> 表格</span><button aria-label="左对齐" title="左对齐" onClick={() => editor.chain().focus().setCellAttribute('align', 'left').run()}><AlignLeft size={13} /></button><button aria-label="居中对齐" title="居中对齐" onClick={() => editor.chain().focus().setCellAttribute('align', 'center').run()}><AlignCenter size={13} /></button><button aria-label="右对齐" title="右对齐" onClick={() => editor.chain().focus().setCellAttribute('align', 'right').run()}><AlignRight size={13} /></button><button onClick={() => editor.chain().focus().addRowAfter().run()}>下方加行</button><button onClick={() => editor.chain().focus().addColumnAfter().run()}>右侧加列</button><button onClick={() => editor.chain().focus().deleteRow().run()}>删行</button><button onClick={() => editor.chain().focus().deleteColumn().run()}>删列</button><button className="danger" onClick={() => setConfirmTableDelete(true)}>删除表格</button></div>}
      {!sourceMode && confirmTableDelete && <div className="editor-inline-confirm" role="alertdialog" aria-label="确认删除表格" onKeyDown={(event) => { if (!isComposingKeyboardEvent(event.nativeEvent) && event.key === 'Escape') { event.preventDefault(); setConfirmTableDelete(false); editor.commands.focus(); } }}><span>删除整张表格？</span><button autoFocus onClick={() => { setConfirmTableDelete(false); editor.commands.focus(); }}>取消</button><button className="danger" onClick={() => { editor.chain().focus().deleteTable().run(); setConfirmTableDelete(false); }}>删除</button></div>}
      {!sourceMode && editable && editorViewMounted && <BubbleMenu
        editor={editor}
        options={{ placement: 'top' }}
        shouldShow={({ from, to }) => editor.state.selection instanceof TextSelection
          && (from !== to || blockMenuOpen || linkEditorOpen)
          && !editor.isActive('codeBlock')}
      >
        <div className="editor-bubble-menu" role="toolbar" aria-label="选中文字格式">
          <span className="editor-block-control">
            <button className="editor-block-trigger" aria-label="转换块类型" aria-haspopup="menu" aria-expanded={blockMenuOpen} onMouseDown={(event) => event.preventDefault()} onClick={() => { setLinkEditorOpen(false); setBlockMenuOpen((open) => !open); }}><span>{activeBlockType(editor)}</span><ChevronDown size={13} /></button>
            <ExitPresence show={blockMenuOpen} duration={100}>{blockMenuOpen ? <div className="editor-block-menu" role="menu" aria-label="转换为">
              {blockTypeItems.map((item) => <button key={item.id} role="menuitemradio" aria-checked={isBlockTypeActive(editor, item.id)} onMouseDown={(event) => event.preventDefault()} onClick={() => { item.run(editor); setBlockMenuOpen(false); }}><span>{item.icon}</span><strong>{item.label}</strong>{isBlockTypeActive(editor, item.id) && <Check size={14} />}</button>)}
            </div> : null}</ExitPresence>
          </span>
          <i className="editor-bubble-separator" />
          <span className="editor-link-control">
            <button className={editor.isActive('link') || linkEditorOpen ? 'active' : ''} aria-pressed={editor.isActive('link') || linkEditorOpen} aria-haspopup="dialog" aria-expanded={linkEditorOpen} onMouseDown={(event) => event.preventDefault()} onClick={() => { setBlockMenuOpen(false); openLinkEditor(); }} aria-label="链接" title="链接"><Link2 size={14} /></button>
            <ExitPresence show={linkEditorOpen} duration={100}>{linkEditorOpen ? <form className="editor-link-popover" role="dialog" aria-label="编辑链接" onSubmit={(event) => { event.preventDefault(); applyLink(); }} onKeyDown={(event) => { if (isComposingKeyboardEvent(event.nativeEvent)) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setLinkEditorOpen(false); editor.commands.focus(); } }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setLinkEditorOpen(false); }}>
              <input ref={linkInputRef} value={linkValue} onChange={(event) => setLinkValue(event.target.value)} aria-label="链接地址" placeholder="https://" />
              <button type="submit">应用</button>
              {editor.isActive('link') && <button type="button" className="muted" onClick={() => { setLinkValue(''); editor.chain().focus().extendMarkRange('link').unsetLink().run(); setLinkEditorOpen(false); }}>移除</button>}
            </form> : null}</ExitPresence>
          </span>
          <button className={editor.isActive('bold') ? 'active' : ''} aria-pressed={editor.isActive('bold')} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleBold().run()} aria-label="粗体" title="粗体"><Bold size={14} /></button>
          <button className={editor.isActive('italic') ? 'active' : ''} aria-pressed={editor.isActive('italic')} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="斜体" title="斜体"><Italic size={14} /></button>
          <button className={editor.isActive('underline') ? 'active' : ''} aria-pressed={editor.isActive('underline')} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleUnderline().run()} aria-label="下划线" title="下划线"><UnderlineIcon size={14} /></button>
          <button className={editor.isActive('strike') ? 'active' : ''} aria-pressed={editor.isActive('strike')} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleStrike().run()} aria-label="删除线" title="删除线"><Strikethrough size={14} /></button>
          <button className={editor.isActive('code') ? 'active' : ''} aria-pressed={editor.isActive('code')} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleCode().run()} aria-label="行内代码" title="行内代码"><Braces size={14} /></button>
          <button className={editor.isActive('highlight') ? 'active' : ''} aria-pressed={editor.isActive('highlight')} onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().toggleHighlight().run()} aria-label="高亮" title="高亮"><Highlighter size={14} /></button>
          <i className="editor-bubble-separator" />
          <button onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} aria-label="插入表格" title="插入表格"><Table2 size={14} /></button>
          <button onMouseDown={(event) => event.preventDefault()} onClick={() => editor.chain().focus().insertInlineMath({ latex: 'x' }).run()} aria-label="插入公式" title="插入公式"><Sigma size={14} /></button>
          {isNativeVault && <button onMouseDown={(event) => event.preventDefault()} onClick={() => void insertImage()} aria-label="插入本地附件" title="插入本地附件"><Paperclip size={14} /></button>}
          {!compact && <button onMouseDown={(event) => event.preventDefault()} onClick={toggleSourceMode} aria-label="Markdown 源码模式" title="Markdown 源码模式"><FileCode2 size={14} /></button>}
        </div>
      </BubbleMenu>}
      {!sourceMode && editable && editorViewMounted && <BubbleMenu editor={editor} pluginKey="attachment-menu" options={{ placement: 'top' }} shouldShow={() => editor.isActive('image') || editor.isActive('mediaAttachment') || editor.isActive('fileAttachment')}><div className="editor-attachment-menu">{editor.isActive('image') && <input key={String(activeMediaAttributes.src)} aria-label="图片替代文字" defaultValue={String(activeMediaAttributes.alt || '')} placeholder="替代文字" onMouseDown={(event) => event.stopPropagation()} onBlur={(event) => editor.chain().updateAttributes('image', { alt: event.target.value }).run()} />}{activeAttachmentPath && <><button onClick={() => void vaultApi.openAttachment?.(activeAttachmentPath)}>打开</button><button onClick={() => void vaultApi.revealAttachment?.(activeAttachmentPath)}>定位</button><button onClick={() => void navigator.clipboard.writeText(activeAttachmentPath)}><Copy size={13} />复制路径</button></>}</div></BubbleMenu>}
      {!sourceMode && !compact && editable && editorViewMounted && <BlockDragHandle editor={editor} />}
      {attachmentImportCount > 0 && <div className="editor-attachment-import-status" role="status"><span className="editor-import-spinner" />正在导入 {attachmentImportCount} 个附件…</div>}
      {sourceMode ? <textarea className="editor-source-textarea" aria-label="Markdown 源码" spellCheck={false} value={card.body} onChange={(event) => updateCard(card.id, { body: event.target.value })} /> : <EditorContent editor={editor} />}
      <ExitPresence show={Boolean(editable && trigger?.kind === 'slash' && matchingSlashItems.length > 0)} duration={100}>{editable && trigger?.kind === 'slash' && matchingSlashItems.length > 0 ? (
        <div id={commandMenuId} className="editor-command-menu" role="listbox" aria-label="插入命令" style={menuPosition ?? undefined}>
          {matchingSlashItems.map((item, index) => (
            <button id={`${commandMenuId}-option-${index}`} role="option" aria-selected={index === commandIndex} className={index === commandIndex ? 'active' : ''} key={item.id} onMouseDown={(event) => { event.preventDefault(); runSlash(item); }}>
              <span>{item.icon}</span><strong>{item.label}</strong><small>{item.hint}</small>
            </button>
          ))}
        </div>
      ) : null}</ExitPresence>
      <ExitPresence show={Boolean(editable && trigger?.kind === 'mention' && matchingCards.length > 0)} duration={100}>{editable && trigger?.kind === 'mention' && matchingCards.length > 0 ? (
        <div id={commandMenuId} className="editor-command-menu mention-menu" role="listbox" aria-label="卡片引用建议" style={menuPosition ?? undefined}>
          {matchingCards.map((target, index) => (
            <button id={`${commandMenuId}-option-${index}`} role="option" aria-selected={index === commandIndex} className={index === commandIndex ? 'active' : ''} key={target.id} onMouseDown={(event) => { event.preventDefault(); insertMention(target); }}>
              <span>@</span><strong>{target.title || '未命名卡片'}</strong><small>卡片引用</small>
            </button>
          ))}
        </div>
      ) : null}</ExitPresence>
    </div>
  );
}

export default memo(CardBodyEditor, (previous, next) => (
  previous.card === next.card
  && previous.cards === next.cards
  && previous.getCards === next.getCards
  && previous.compact === next.compact
  && previous.editable === next.editable
  && previous.surface === next.surface
  && previous.updateCard === next.updateCard
  && previous.onOpenCard === next.onOpenCard
));
