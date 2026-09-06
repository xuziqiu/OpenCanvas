export interface EditorLinkGesture {
  editable: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/**
 * Read-only card links behave like ordinary links. While editing, a plain
 * click must remain available for caret placement and text selection; opening
 * the target is an explicit Ctrl/Cmd-click action.
 */
export function shouldOpenEditorLink({ editable, ctrlKey = false, metaKey = false }: EditorLinkGesture) {
  return !editable || ctrlKey || metaKey;
}
