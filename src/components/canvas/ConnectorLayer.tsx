import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { connectorGeometry, type Point } from '../../domain/connectorGeometry';
import { shouldOpenConnectorMenu } from '../../domain/connectorKeyboard';
import { connectorLabelMetrics, type ConnectorLabelCandidate } from '../../domain/connectorLabelLayout';
import { isComposingKeyboardEvent } from '../../domain/keyboard';
import { nearestPolyline } from '../../domain/polylineHitTest';
import type { BoardConnector, BoardPlacement } from '../../types';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const CONNECTOR_COLORS = [
  { id: 'neutral', value: '#7d8088', label: '灰色' },
  { id: 'blue', value: '#55bde9', label: '蓝色' },
  { id: 'green', value: '#61b98a', label: '绿色' },
  { id: 'yellow', value: '#d6a94d', label: '黄色' },
  { id: 'red', value: '#df6d72', label: '红色' },
  { id: 'purple', value: '#a77bd8', label: '紫色' },
];

export const connectorColor = (color = 'neutral') => CONNECTOR_COLORS.find((item) => item.id === color)?.value ?? color;

export function connectorFocusState(
  connector: Pick<BoardConnector, 'id' | 'from' | 'to'>,
  focusedPlacementIds: ReadonlySet<string>,
  focusedConnectorId?: string | null,
) {
  const active = focusedPlacementIds.size > 0 || Boolean(focusedConnectorId);
  const related = connector.id === focusedConnectorId
    || focusedPlacementIds.has(connector.from)
    || focusedPlacementIds.has(connector.to);
  return { related, dimmed: active && !related };
}
export type AnchorSide = NonNullable<BoardConnector['fromAnchor']>;
const ANCHOR_SIDES: AnchorSide[] = ['top', 'right', 'bottom', 'left'];
export type AnchorChoice = AnchorSide | 'auto';
export const ANCHOR_CHOICES: AnchorChoice[] = [...ANCHOR_SIDES, 'auto'];

export function portPoint(placement: BoardPlacement, side: AnchorChoice) {
  if (side === 'auto') return { x: placement.x + placement.width / 2, y: placement.y + placement.height / 2 };
  if (side === 'top') return { x: placement.x + placement.width / 2, y: placement.y };
  if (side === 'right') return { x: placement.x + placement.width, y: placement.y + placement.height / 2 };
  if (side === 'bottom') return { x: placement.x + placement.width / 2, y: placement.y + placement.height };
  return { x: placement.x, y: placement.y + placement.height / 2 };
}

function anchorSideToward(placement: BoardPlacement, target: Point): AnchorSide {
  const center = { x: placement.x + placement.width / 2, y: placement.y + placement.height / 2 };
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  const horizontalWeight = Math.abs(dx) / Math.max(1, placement.width / 2);
  const verticalWeight = Math.abs(dy) / Math.max(1, placement.height / 2);
  if (horizontalWeight >= verticalWeight) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

export function anchorToward(placement: BoardPlacement, target: Point) {
  return portPoint(placement, anchorSideToward(placement, target));
}

export function fixedAnchor(side: AnchorChoice): AnchorSide | undefined {
  return side === 'auto' ? undefined : side;
}

interface ConnectorRouteGeometry {
  from: BoardPlacement;
  to: BoardPlacement;
  fromSide: AnchorSide;
  toSide: AnchorSide;
  start: Point;
  end: Point;
  geometry: ReturnType<typeof connectorGeometry>;
}

const connectorRouteCache = new WeakMap<BoardConnector, { from: BoardPlacement; to: BoardPlacement; route: ConnectorRouteGeometry }>();

function automaticSideAgainstFixed(auto: BoardPlacement, fixed: BoardPlacement, fixedSide: AnchorSide): AnchorSide {
  const autoLeft = auto.x;
  const autoRight = auto.x + auto.width;
  const autoTop = auto.y;
  const autoBottom = auto.y + auto.height;
  const fixedLeft = fixed.x;
  const fixedRight = fixed.x + fixed.width;
  const fixedTop = fixed.y;
  const fixedBottom = fixed.y + fixed.height;
  if (fixedSide === 'top') {
    if (autoBottom > fixedTop) return 'top';
    if (autoLeft > fixedRight) return 'left';
    if (autoRight < fixedLeft) return 'right';
    return 'bottom';
  }
  if (fixedSide === 'bottom') {
    if (autoTop < fixedBottom) return 'bottom';
    if (autoRight < fixedLeft) return 'right';
    if (autoLeft > fixedRight) return 'left';
    return 'top';
  }
  if (fixedSide === 'right') {
    if (autoLeft < fixedRight) return 'right';
    if (autoBottom < fixedTop) return 'bottom';
    if (autoTop > fixedBottom) return 'top';
    return 'left';
  }
  if (autoRight > fixedLeft) return 'left';
  if (autoTop > fixedBottom) return 'top';
  if (autoBottom < fixedTop) return 'bottom';
  return 'right';
}

/** Resolve automatic attachment ports from adjacent route geometry. */
export function resolveConnectorAnchorSides(connector: BoardConnector, from: BoardPlacement, to: BoardPlacement) {
  const keypoints = connector.controlPoints ?? [];
  let fromSide = connector.fromAnchor;
  let toSide = connector.toAnchor;
  if (!fromSide && keypoints.length) fromSide = anchorSideToward(from, keypoints[0]);
  if (!toSide && keypoints.length) toSide = anchorSideToward(to, keypoints.at(-1)!);
  if (!fromSide && !toSide) {
    const horizontalOverlap = to.x + to.width > from.x && to.x < from.x + from.width;
    if (to.y + to.height < from.y && horizontalOverlap) return { fromSide: 'top' as const, toSide: 'bottom' as const };
    if (to.y > from.y + from.height && horizontalOverlap) return { fromSide: 'bottom' as const, toSide: 'top' as const };
    return to.x + to.width / 2 > from.x + from.width / 2
      ? { fromSide: 'right' as const, toSide: 'left' as const }
      : { fromSide: 'left' as const, toSide: 'right' as const };
  }
  if (!fromSide) fromSide = automaticSideAgainstFixed(from, to, toSide!);
  if (!toSide) toSide = automaticSideAgainstFixed(to, from, fromSide);
  return { fromSide, toSide };
}

export function resolvedConnectorEndpointAnchor(
  connector: BoardConnector,
  handle: 'from' | 'to',
  target: BoardPlacement,
  opposite: BoardPlacement,
  choice: AnchorChoice,
) {
  if (choice !== 'auto') return { side: choice, point: portPoint(target, choice) };
  const sides = handle === 'from'
    ? resolveConnectorAnchorSides({ ...connector, fromAnchor: undefined }, target, opposite)
    : resolveConnectorAnchorSides({ ...connector, toAnchor: undefined }, opposite, target);
  const side = handle === 'from' ? sides.fromSide : sides.toSide;
  return { side, point: portPoint(target, side) };
}

export function connectorRouteGeometry(connector: BoardConnector, placementsById: ReadonlyMap<string, BoardPlacement>) {
  const from = placementsById.get(connector.from);
  const to = placementsById.get(connector.to);
  if (!from || !to) return null;
  const cached = connectorRouteCache.get(connector);
  if (cached?.from === from && cached.to === to) return cached.route;
  const { fromSide, toSide } = resolveConnectorAnchorSides(connector, from, to);
  const start = portPoint(from, fromSide);
  const end = portPoint(to, toSide);
  const geometry = connectorGeometry(start, end, connector.lineStyle, connector.controlPoints ?? [], { start: fromSide, end: toSide });
  const route: ConnectorRouteGeometry = { from, to, fromSide, toSide, start, end, geometry };
  connectorRouteCache.set(connector, { from, to, route });
  return route;
}

export type ConnectorHandle =
  | { kind: 'from' | 'to' }
  | { kind: 'keypoint'; index: number }
  | { kind: 'insert'; index: number; point: Point; direction?: 'vertical' | 'horizontal' }
  | { kind: 'label'; index: number; point: Point; existing: boolean };
export type ConnectorPort = { placementId: string; side: AnchorChoice; point: Point };
export type ConnectorEndpointDrag = { connectorId: string; handle: 'from' | 'to'; point: Point; port?: ConnectorPort };

export function connectorTargetPortAt(point: Point, placements: BoardPlacement[], zoom = 1) {
  const connectablePlacements = placements.filter((placement) => !placement.isFrame);
  const safeZoom = Math.max(.05, zoom);
  const nearestPort = (candidates: BoardPlacement[], maxDistance = Number.POSITIVE_INFINITY) => {
    let nearest: (ConnectorPort & { distance: number }) | null = null;
    for (const placement of candidates) {
      for (const side of ANCHOR_CHOICES) {
        const port = portPoint(placement, side);
        const distance = Math.hypot(point.x - port.x, point.y - port.y);
        if (distance <= maxDistance && (!nearest || distance < nearest.distance)) {
          nearest = { placementId: placement.id, side, point: port, distance };
        }
      }
    }
    return nearest && { placementId: nearest.placementId, side: nearest.side, point: nearest.point };
  };
  const proximity = 16 / safeZoom;
  const hoveredPlacement = [...connectablePlacements].reverse().find((placement) => (
    point.x >= placement.x - proximity
    && point.x <= placement.x + placement.width + proximity
    && point.y >= placement.y - proximity
    && point.y <= placement.y + placement.height + proximity
  ));
  return hoveredPlacement
    ? nearestPort([hoveredPlacement])
    : nearestPort(connectablePlacements, 34 / safeZoom);
}

export function connectorEndpointPatch(handle: 'from' | 'to', port: ConnectorPort): Partial<BoardConnector> {
  return handle === 'from'
    ? { from: port.placementId, fromAnchor: fixedAnchor(port.side) }
    : { to: port.placementId, toAnchor: fixedAnchor(port.side) };
}

function InlineConnectorLabelEditor({ value, x, y, onCommit, onCancel }: {
  value: string;
  x: number;
  y: number;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const blurCommitTimerRef = useRef<number | null>(null);
  const width = clamp(Math.max(74, [...draft].length * 12 + 28), 74, 240);
  useEffect(() => () => {
    if (blurCommitTimerRef.current !== null) window.clearTimeout(blurCommitTimerRef.current);
  }, []);
  const cancelBlurCommit = () => {
    if (blurCommitTimerRef.current !== null) window.clearTimeout(blurCommitTimerRef.current);
    blurCommitTimerRef.current = null;
  };
  return (
    <foreignObject className="edge-label-editor-object" x={x - width / 2} y={y - 15} width={width} height="30">
      <input
        ref={inputRef}
        className="edge-label-inline-input"
        value={draft}
        aria-label="编辑连线标签"
        onPointerDown={(event) => event.stopPropagation()}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={cancelBlurCommit}
        onBlur={() => {
          cancelBlurCommit();
          blurCommitTimerRef.current = window.setTimeout(() => {
            blurCommitTimerRef.current = null;
            if (document.activeElement === inputRef.current) return;
            onCommit(draft.trim());
          }, 80);
        }}
        onKeyDown={(event) => {
          if (isComposingKeyboardEvent(event.nativeEvent)) return;
          if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
          if (event.key === 'Escape') { event.preventDefault(); cancelBlurCommit(); onCancel(); }
        }}
        autoFocus
      />
    </foreignObject>
  );
}

function EdgeControlTarget({ x, y, inverseZoom, kind, onPointerDown, onDoubleClick }: {
  x: number;
  y: number;
  inverseZoom: number;
  kind: 'endpoint' | 'keypoint' | 'insertion';
  onPointerDown: (event: React.PointerEvent<SVGGElement>) => void;
  onDoubleClick?: (event: React.MouseEvent<SVGGElement>) => void;
}) {
  const visibleRadius = kind === 'insertion' ? 4.5 : 6;
  const hitRadius = kind === 'insertion' ? 10 : 12;
  return <g
    className="edge-control-target"
    aria-hidden="true"
    onPointerDown={onPointerDown}
    onDoubleClick={onDoubleClick}
  >
    <circle className="edge-control-hit" cx={x} cy={y} r={hitRadius * inverseZoom} />
    <circle className={`edge-control ${kind === 'endpoint' ? 'edge-endpoint-control' : kind === 'keypoint' ? 'edge-keypoint-control' : 'edge-insertion-control'}`} cx={x} cy={y} r={visibleRadius * inverseZoom} />
  </g>;
}

export function Edge({ connector, placementsById, occlusionPlacements, automaticLabel, selected, related, dimmed, editingLabel, lodExpanded, onOpenMenu, onEditLabel, onCommitLabel, onCancelLabelEdit, onHandlePointerDown, onRemoveKeypoint, endpointDrag, zoom }: {
  connector: BoardConnector;
  placementsById: ReadonlyMap<string, BoardPlacement>;
  occlusionPlacements: BoardPlacement[];
  automaticLabel?: ConnectorLabelCandidate;
  selected: boolean;
  related?: boolean;
  dimmed?: boolean;
  editingLabel: boolean;
  lodExpanded?: boolean;
  onOpenMenu: (event: React.PointerEvent | React.MouseEvent | React.KeyboardEvent<SVGPathElement>, connector: BoardConnector) => void;
  onEditLabel: (event: React.MouseEvent, connector: BoardConnector) => void;
  onCommitLabel: (connector: BoardConnector, value: string) => void;
  onCancelLabelEdit: () => void;
  onHandlePointerDown: (event: React.PointerEvent, connector: BoardConnector, handle: ConnectorHandle) => void;
  onRemoveKeypoint: (event: React.MouseEvent, connector: BoardConnector, index: number) => void;
  endpointDrag: ConnectorEndpointDrag | null;
  zoom: number;
}) {
  const from = placementsById.get(connector.from);
  const to = placementsById.get(connector.to);
  if (!from || !to) return null;

  let { fromSide: resolvedFromSide, toSide: resolvedToSide } = resolveConnectorAnchorSides(connector, from, to);
  if (endpointDrag?.connectorId === connector.id && endpointDrag.handle === 'from' && endpointDrag.port) {
    const targetPlacement = placementsById.get(endpointDrag.port.placementId);
    if (targetPlacement) resolvedFromSide = resolvedConnectorEndpointAnchor(connector, 'from', targetPlacement, to, endpointDrag.port.side).side;
  }
  if (endpointDrag?.connectorId === connector.id && endpointDrag.handle === 'to' && endpointDrag.port) {
    const targetPlacement = placementsById.get(endpointDrag.port.placementId);
    if (targetPlacement) resolvedToSide = resolvedConnectorEndpointAnchor(connector, 'to', targetPlacement, from, endpointDrag.port.side).side;
  }
  let start = portPoint(from, resolvedFromSide);
  let end = portPoint(to, resolvedToSide);
  if (endpointDrag?.connectorId === connector.id && endpointDrag.handle === 'from') start = endpointDrag.point;
  if (endpointDrag?.connectorId === connector.id && endpointDrag.handle === 'to') end = endpointDrag.point;
  const worldKeypoints = connector.controlPoints?.map((point) => ({ x: point.x, y: point.y })) ?? [];
  const pad = connector.lineStyle === 'curve' || !connector.lineStyle ? 150 : 42;
  const allPoints = [start, end, ...worldKeypoints];
  const minX = Math.min(...allPoints.map((point) => point.x)) - pad;
  const minY = Math.min(...allPoints.map((point) => point.y)) - pad;
  const maxX = Math.max(...allPoints.map((point) => point.x)) + pad;
  const maxY = Math.max(...allPoints.map((point) => point.y)) + pad;
  const width = Math.max(2, maxX - minX);
  const height = Math.max(2, maxY - minY);
  const localStart = { x: start.x - minX, y: start.y - minY };
  const localEnd = { x: end.x - minX, y: end.y - minY };
  const localKeypoints = worldKeypoints.map((point) => ({ x: point.x - minX, y: point.y - minY }));
  const geometry = connectorGeometry(localStart, localEnd, connector.lineStyle, localKeypoints, { start: resolvedFromSide, end: resolvedToSide });
  const markerId = `edge-arrow-${connector.id}`;
  const arrow = connector.arrow ?? 'end';
  const style = { '--edge-color': connectorColor(connector.color) } as CSSProperties;
  const hasLabel = Boolean(connector.label) || editingLabel;
  const isOccluded = (point: Point) => occlusionPlacements.some((placement) => (
    point.x > placement.x + 6
    && point.x < placement.x + placement.width - 6
    && point.y > placement.y + 6
    && point.y < placement.y + placement.height - 6
  ));
  const preferredInsertionIndex = Math.floor((geometry.insertions.length - 1) / 2);
  const fallbackAutomaticLabelInsertionIndex = localKeypoints.length ? -1 : geometry.insertions
    .map((_, index) => index)
    .sort((left, right) => Math.abs(left - preferredInsertionIndex) - Math.abs(right - preferredInsertionIndex))
    .find((index) => {
      const point = geometry.insertions[index].point;
      return !isOccluded({ x: point.x + minX, y: point.y + minY });
    }) ?? preferredInsertionIndex;
  const automaticLabelInsertionIndex = !localKeypoints.length && automaticLabel
    ? automaticLabel.insertionIndex
    : fallbackAutomaticLabelInsertionIndex;
  const labelPoint = localKeypoints[0]
    ?? (automaticLabel ? { x: automaticLabel.point.x - minX, y: automaticLabel.point.y - minY } : undefined)
    ?? geometry.insertions[automaticLabelInsertionIndex]?.point
    ?? geometry.labelPoint;
  const inverseZoom = 1 / zoom;

  return <>
    <svg className={`edge-object ${selected ? 'selected' : ''} ${related ? 'edge-related' : ''} ${dimmed ? 'edge-muted' : ''} ${lodExpanded ? 'edge-lod-expanded' : ''}`} style={{ left: minX, top: minY, width, height, ...style }} viewBox={`0 0 ${width} ${height}`}>
      <defs><marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto-start-reverse"><path d="M0,0 L7,3.5 L0,7 Z" className="edge-arrow" /></marker></defs>
      <path
        className="edge-hitbox"
        d={geometry.d}
        role="button"
        tabIndex={0}
        aria-label={connector.label ? `连接线：${connector.label}` : '连接线'}
        aria-haspopup="menu"
        onPointerDown={(event) => { if (event.button === 0) onOpenMenu(event, connector); }}
        onContextMenu={(event) => onOpenMenu(event, connector)}
        onKeyDown={(event) => {
          if (isComposingKeyboardEvent(event.nativeEvent)) return;
          if (!shouldOpenConnectorMenu(event.key, event.shiftKey, event.target === event.currentTarget)) return;
          event.preventDefault();
          event.stopPropagation();
          onOpenMenu(event, connector);
        }}
      />
      <path className={`edge-line ${connector.dashed ? 'edge-line-dashed' : ''}`} d={geometry.d} style={{ strokeWidth: connector.width ?? 3.5 }} markerStart={arrow === 'start' || arrow === 'both' ? `url(#${markerId})` : undefined} markerEnd={arrow === 'end' || arrow === 'both' ? `url(#${markerId})` : undefined} />
      {editingLabel ? <InlineConnectorLabelEditor value={connector.label ?? ''} x={labelPoint.x} y={labelPoint.y} onCommit={(value) => onCommitLabel(connector, value)} onCancel={onCancelLabelEdit} /> : connector.label && (() => {
        const { displayLabel, width: labelWidth } = connectorLabelMetrics(connector.label);
        return <g className="edge-label-group" transform={`translate(${labelPoint.x} ${labelPoint.y})`} onPointerDown={(event) => onHandlePointerDown(event, connector, { kind: 'label', index: 0, point: { x: labelPoint.x + minX, y: labelPoint.y + minY }, existing: Boolean(localKeypoints[0]) })} onDoubleClick={(event) => onEditLabel(event, connector)}><title>{connector.label}</title><rect className="edge-label-mask" x={-labelWidth / 2} y={-11} width={labelWidth} height={22} rx="4" /><text className="edge-label" x="0" y="0" dy=".35em">{displayLabel}</text></g>;
      })()}
    </svg>
    {selected && <svg className="edge-controls-layer" style={{ left: minX, top: minY, width, height, ...style }} viewBox={`0 0 ${width} ${height}`} aria-label="连接线控制点">
      <EdgeControlTarget x={localStart.x} y={localStart.y} inverseZoom={inverseZoom} kind="endpoint" onPointerDown={(event) => onHandlePointerDown(event, connector, { kind: 'from' })} />
      {localKeypoints.map((point, index) => (hasLabel && index === 0) || isOccluded(worldKeypoints[index]) ? null : <EdgeControlTarget key={`${connector.id}-keypoint-${index}`} x={point.x} y={point.y} inverseZoom={inverseZoom} kind="keypoint" onPointerDown={(event) => onHandlePointerDown(event, connector, { kind: 'keypoint', index })} onDoubleClick={(event) => onRemoveKeypoint(event, connector, index)} />)}
      {geometry.insertions.map(({ point, index, direction }, insertionIndex) => {
        const worldPoint = { x: point.x + minX, y: point.y + minY };
        return (hasLabel && insertionIndex === automaticLabelInsertionIndex) || isOccluded(worldPoint) ? null : <EdgeControlTarget key={`${connector.id}-insert-${index}-${insertionIndex}`} x={point.x} y={point.y} inverseZoom={inverseZoom} kind="insertion" onPointerDown={(event) => onHandlePointerDown(event, connector, { kind: 'insert', index, point: worldPoint, direction })} />;
      })}
      <EdgeControlTarget x={localEnd.x} y={localEnd.y} inverseZoom={inverseZoom} kind="endpoint" onPointerDown={(event) => onHandlePointerDown(event, connector, { kind: 'to' })} />
    </svg>}
  </>;
}

export function DenseConnectorLayer({ connectors, placementsById, bounds, focusPlacementIds, focusActive = false, onPick }: {
  connectors: BoardConnector[];
  placementsById: ReadonlyMap<string, BoardPlacement>;
  bounds: { x: number; y: number; width: number; height: number };
  focusPlacementIds?: ReadonlySet<string>;
  focusActive?: boolean;
  onPick: (event: React.PointerEvent<SVGPathElement> | React.MouseEvent<SVGPathElement>, connector: BoardConnector) => void;
}) {
  type DenseRoute = { connector: BoardConnector; d: string; hitPoints: Point[] };
  type DenseMesh = {
    connectors: BoardConnector[];
    placementsById: ReadonlyMap<string, BoardPlacement>;
    routes: DenseRoute[];
    grouped: Map<string, { color: string; width: number; dashed: boolean; paths: string[] }>;
    allPaths: string;
    version: number;
  };
  const meshRef = useRef<DenseMesh | null>(null);
  const previousMesh = meshRef.current;
  const sameConnectors = previousMesh?.connectors.length === connectors.length
    && connectors.every((connector, index) => previousMesh.connectors[index] === connector);
  if (!previousMesh || previousMesh.placementsById !== placementsById || !sameConnectors) {
    const routes = connectors.flatMap((connector) => {
      const route = connectorRouteGeometry(connector, placementsById);
      return route ? [{ connector, d: route.geometry.d, hitPoints: route.geometry.hitPoints }] : [];
    });
    const grouped = new Map<string, { color: string; width: number; dashed: boolean; paths: string[] }>();
    for (const route of routes) {
      const color = connectorColor(route.connector.color);
      const width = route.connector.width ?? 3.5;
      const dashed = Boolean(route.connector.dashed);
      const key = `${color}:${width}:${dashed}`;
      const group = grouped.get(key) ?? { color, width, dashed, paths: [] };
      group.paths.push(route.d);
      grouped.set(key, group);
    }
    meshRef.current = {
      connectors: [...connectors],
      placementsById,
      routes,
      grouped,
      allPaths: routes.map((route) => route.d).join(' '),
      version: (previousMesh?.version ?? 0) + 1,
    };
  }
  const mesh = meshRef.current!;
  const { routes, grouped, allPaths } = mesh;
  if (!routes.length) return null;
  const relatedGrouped = new Map<string, { color: string; width: number; dashed: boolean; paths: string[] }>();
  if (focusPlacementIds?.size) {
    for (const route of routes) {
      if (!focusPlacementIds.has(route.connector.from) && !focusPlacementIds.has(route.connector.to)) continue;
      const color = connectorColor(route.connector.color);
      const width = route.connector.width ?? 3.5;
      const dashed = Boolean(route.connector.dashed);
      const key = `${color}:${width}:${dashed}`;
      const group = relatedGrouped.get(key) ?? { color, width, dashed, paths: [] };
      group.paths.push(route.d);
      relatedGrouped.set(key, group);
    }
  }
  const pickRoute = (event: React.PointerEvent<SVGPathElement> | React.MouseEvent<SVGPathElement>) => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return;
    const point = {
      x: bounds.x + (event.clientX - rect.left) * bounds.width / rect.width,
      y: bounds.y + (event.clientY - rect.top) * bounds.height / rect.height,
    };
    const nearest = nearestPolyline(point, routes);
    if (nearest) onPick(event, nearest.route.connector);
  };
  return <svg
    className={`dense-connector-layer dense-connector-layer-entered ${focusActive ? 'relationship-focus' : ''}`}
    style={{ left: bounds.x, top: bounds.y, width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) }}
    viewBox={`${bounds.x} ${bounds.y} ${Math.max(1, bounds.width)} ${Math.max(1, bounds.height)}`}
    aria-label={`简化显示 ${routes.length} 条密集连线`}
    data-mesh-version={mesh.version}
  >
    {[...grouped.entries()].map(([key, group]) => <path key={key} className="dense-edge-line" d={group.paths.join(' ')} style={{ stroke: group.color, strokeWidth: group.width, strokeDasharray: group.dashed ? '8 7' : undefined }} />)}
    {[...relatedGrouped.entries()].map(([key, group]) => <path key={`related-${key}`} className="dense-edge-line dense-edge-related" d={group.paths.join(' ')} style={{ stroke: group.color, strokeWidth: group.width, strokeDasharray: group.dashed ? '8 7' : undefined }} />)}
    <path
      className="dense-edge-hitbox"
      d={allPaths}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // Picking a dense route swaps this aggregate path for a detailed Edge
        // during the same gesture. Stop the canvas gesture synchronously here,
        // before that DOM replacement can make the original target disappear.
        event.preventDefault();
        event.stopPropagation();
        pickRoute(event);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        pickRoute(event);
      }}
    />
  </svg>;
}

export function DraftEdge({ from, fromAnchor, pointer, toSide }: { from: BoardPlacement; fromAnchor: AnchorChoice; pointer: Point; toSide?: AnchorChoice }) {
  const resolvedFromSide = fromAnchor === 'auto' ? anchorSideToward(from, pointer) : fromAnchor;
  const start = portPoint(from, resolvedFromSide);
  const pad = 150;
  const minX = Math.min(start.x, pointer.x) - pad;
  const minY = Math.min(start.y, pointer.y) - pad;
  const width = Math.max(2, Math.abs(start.x - pointer.x)) + pad * 2;
  const height = Math.max(2, Math.abs(start.y - pointer.y)) + pad * 2;
  const x1 = start.x - minX; const y1 = start.y - minY;
  const x2 = pointer.x - minX; const y2 = pointer.y - minY;
  const markerId = `draft-arrow-${from.id}`;
  return <svg className="edge-object edge-draft" style={{ left: minX, top: minY, width, height }} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><defs><marker id={markerId} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" className="edge-arrow" /></marker></defs><path className="edge-line" d={connectorGeometry({ x: x1, y: y1 }, { x: x2, y: y2 }, 'curve', [], { start: resolvedFromSide, end: toSide && toSide !== 'auto' ? toSide : anchorSideToward({ ...from, x: pointer.x - 1, y: pointer.y - 1, width: 2, height: 2 }, start) }).d} markerEnd={`url(#${markerId})`} /></svg>;
}
