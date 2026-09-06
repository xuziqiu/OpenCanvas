export const SECTION_RENAME_REQUEST_EVENT = 'opencanvas:request-section-rename';

export function requestSectionRename(placementId: string) {
  window.dispatchEvent(new CustomEvent<string>(SECTION_RENAME_REQUEST_EVENT, { detail: placementId }));
}
