import { describe, expect, it } from 'vitest';
import type { BoardConnector, BoardPlacement } from '../../types';
import { connectorEndpointPatch, connectorFocusState, connectorRouteGeometry, connectorTargetPortAt, resolveConnectorAnchorSides, resolvedConnectorEndpointAnchor } from './ConnectorLayer';

const placement = (id: string, x: number): BoardPlacement => ({
  id,
  kind: 'card',
  entityId: `${id}-card`,
  x,
  y: 40,
  width: 240,
  height: 160,
  color: 'paper',
});

describe('connector route geometry cache', () => {
  it('reuses geometry while connector and endpoint placement identities stay unchanged', () => {
    const connector: BoardConnector = { id: 'edge', from: 'left', to: 'right', lineStyle: 'curve' };
    const left = placement('left', 0);
    const right = placement('right', 500);
    const placements = new Map([['left', left], ['right', right]]);
    const first = connectorRouteGeometry(connector, placements);
    const second = connectorRouteGeometry(connector, new Map(placements));
    expect(second).toBe(first);
  });

  it('invalidates only when an endpoint or connector object changes', () => {
    const connector: BoardConnector = { id: 'edge', from: 'left', to: 'right', lineStyle: 'curve' };
    const left = placement('left', 0);
    const right = placement('right', 500);
    const first = connectorRouteGeometry(connector, new Map([['left', left], ['right', right]]));
    const movedLeft = { ...left, x: 80 };
    const moved = connectorRouteGeometry(connector, new Map([['left', movedLeft], ['right', right]]));
    const restyled = connectorRouteGeometry({ ...connector, lineStyle: 'straight' }, new Map([['left', movedLeft], ['right', right]]));
    expect(moved).not.toBe(first);
    expect(moved?.start.x).not.toBe(first?.start.x);
    expect(restyled).not.toBe(moved);
    expect(restyled?.geometry.d).not.toBe(moved?.geometry.d);
  });
});

describe('connector automatic anchor resolution', () => {
  it('uses vertical ports for separated cards that overlap horizontally', () => {
    const top = { ...placement('top', 100), y: 0 };
    const bottom = { ...placement('bottom', 180), y: 300 };
    expect(resolveConnectorAnchorSides({ id: 'edge', from: top.id, to: bottom.id }, top, bottom)).toEqual({
      fromSide: 'bottom', toSide: 'top',
    });
  });

  it('uses horizontal ports for diagonal cards without horizontal overlap', () => {
    const left = { ...placement('left', 0), y: 0 };
    const right = { ...placement('right', 500), y: 500 };
    expect(resolveConnectorAnchorSides({ id: 'edge', from: left.id, to: right.id }, left, right)).toEqual({
      fromSide: 'right', toSide: 'left',
    });
  });

  it('aims automatic endpoints at the first and last manual keypoints', () => {
    const from = placement('from', 100);
    const to = placement('to', 700);
    const connector: BoardConnector = {
      id: 'edge', from: from.id, to: to.id,
      controlPoints: [{ id: 'first', x: 210, y: -180 }, { id: 'last', x: 820, y: 360 }],
    };
    expect(resolveConnectorAnchorSides(connector, from, to)).toEqual({ fromSide: 'top', toSide: 'bottom' });
  });

  it('keeps a fixed endpoint while an automatic reattachment follows its adjacent keypoint', () => {
    const target = placement('target', 0);
    const opposite = placement('opposite', 600);
    const connector: BoardConnector = {
      id: 'edge', from: 'old', to: opposite.id, toAnchor: 'left',
      controlPoints: [{ id: 'first', x: 120, y: 380 }],
    };
    expect(resolvedConnectorEndpointAnchor(connector, 'from', target, opposite, 'auto')).toEqual({
      side: 'bottom', point: { x: 120, y: 200 },
    });
  });
});

describe('connector relationship focus', () => {
  const connector: BoardConnector = { id: 'edge', from: 'left', to: 'right' };

  it('emphasizes every connector touching a selected placement', () => {
    expect(connectorFocusState(connector, new Set(['left']))).toEqual({ related: true, dimmed: false });
    expect(connectorFocusState(connector, new Set(['unrelated']))).toEqual({ related: false, dimmed: true });
  });

  it('isolates a selected connector without requiring selected placements', () => {
    expect(connectorFocusState(connector, new Set(), 'edge')).toEqual({ related: true, dimmed: false });
    expect(connectorFocusState({ ...connector, id: 'other' }, new Set(), 'edge')).toEqual({ related: false, dimmed: true });
    expect(connectorFocusState(connector, new Set())).toEqual({ related: false, dimmed: false });
  });
});

describe('connector endpoint reattachment', () => {
  it('keeps port acquisition screen-space stable at extreme zoom levels', () => {
    const target = placement('target', 400);
    for (const zoom of [.2, 1, 2.4]) {
      const edge = { x: target.x - 30 / zoom, y: target.y + target.height / 2 };
      expect(connectorTargetPortAt(edge, [target], zoom)?.placementId).toBe(target.id);
      const outside = { x: target.x - 36 / zoom, y: target.y + target.height / 2 };
      expect(connectorTargetPortAt(outside, [target], zoom)).toBeNull();
    }
  });

  it('reattaches either endpoint and keeps the center port automatic', () => {
    expect(connectorEndpointPatch('from', { placementId: 'third', side: 'top', point: { x: 0, y: 0 } })).toEqual({
      from: 'third', fromAnchor: 'top',
    });
    expect(connectorEndpointPatch('to', { placementId: 'fourth', side: 'auto', point: { x: 0, y: 0 } })).toEqual({
      to: 'fourth', toAnchor: undefined,
    });
  });

  it('never lets a surrounding section steal a card connection target', () => {
    const card = { ...placement('card', 100), y: 100 };
    const section: BoardPlacement = {
      id: 'section', kind: 'text', text: 'Section', isFrame: true,
      x: 0, y: 0, width: 800, height: 600, color: 'transparent',
    };
    expect(connectorTargetPortAt({ x: 220, y: 180 }, [card, section])?.placementId).toBe(card.id);
    expect(connectorTargetPortAt({ x: 400, y: 300 }, [section])).toBeNull();
  });
});
