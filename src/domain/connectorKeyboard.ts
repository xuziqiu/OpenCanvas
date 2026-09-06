export function shouldOpenConnectorMenu(key: string, shiftKey: boolean, eventTargetsConnector = true) {
  if (!eventTargetsConnector) return false;
  return key === 'Enter' || key === ' ' || key === 'ContextMenu' || (shiftKey && key === 'F10');
}
