/**
 * <TableView> — the reusable virtual table (used by Play and the Setup editor).
 * See src/features/play/README.md for the API.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import type { Game, TableState } from '@/shared/types';
import { IconButton } from '@/ui';
import { useSettings } from '@/state/settings';
import { renderOrder } from '../engine';
import { TableController, type TableViewCallbacks } from './controller';
import { DropLandMarker, EntityView, GhostEntity, RefuseHint } from './entities';
import { EndlessGrids } from './grids';
import { HandTray } from './HandTray';
import { DiceSelectionBar, RollReadout } from './DiceHud';
import { BrowseDialog, ContextMenuHost, InspectOverlay, LongPressRing, ShortcutsDialog } from './overlays';
import { TableCtx, useCtl, useUi, type TableMode } from './store';
import { lightingImage, themeInfo } from './theme';
import '../play.css';

export interface TableViewProps extends Omit<TableViewCallbacks, 'mode'> {
  game: Game;
  state: TableState;
  mode: TableMode;
  /** Receives the controller (camera, actions) once mounted; null on unmount. */
  controllerRef?: (ctl: TableController | null) => void;
  /** Hide the built-in zoom buttons (bottom-right). */
  hideZoomControls?: boolean;
  /** Extra overlay content rendered above the table (coach marks, empty states…). */
  children?: ReactNode;
  className?: string;
}

export function TableView(props: TableViewProps) {
  const { game, state, mode, controllerRef, hideZoomControls, children, className, ...rest } = props;
  const cbs: TableViewCallbacks = { ...rest, mode };
  const [ctl] = useState(() => new TableController(cbs, { game, state }));

  useLayoutEffect(() => {
    ctl.sync(cbs, game, state);
  });

  const names = useSettings((s) => (mode === 'setup' ? s.settings.showNamesSetup : s.settings.showNamesPlay));
  useLayoutEffect(() => {
    ctl.setNames(names);
  }, [ctl, names]);

  useLayoutEffect(() => {
    ctl.attach(state.camera ?? null);
    controllerRef?.(ctl);
    const root = ctl.root!;
    let prev = { p: false, s: false };
    const unsub = ctl.ui.subscribe((s) => {
      if (s.panning !== prev.p || s.spaceHeld !== prev.s) {
        prev = { p: s.panning, s: s.spaceHeld };
        root.classList.toggle('is-panning', s.panning);
        root.classList.toggle('is-space', s.spaceHeld);
      }
    });
    return () => {
      unsub();
      controllerRef?.(null);
      ctl.detach();
    };
  }, [ctl]); // eslint-disable-line react-hooks/exhaustive-deps

  const theme = game.table?.theme ?? 'felt-green';
  const info = themeInfo(theme);
  return (
    <TableCtx.Provider value={ctl}>
      <div
        ref={ctl.setRoot}
        className={`play-table ${info.dark ? 'is-dark' : 'is-light'} ${className ?? ''}`}
        data-mode={mode}
        onPointerDown={(e) => ctl.onPointerDown(e.nativeEvent)}
        onPointerMove={(e) => ctl.onHover(e.nativeEvent)}
        onPointerLeave={(e) => ctl.onLeave(e.nativeEvent)}
      >
        {/* the controller fills this with one element per material band; see paintSurface() */}
        <div ref={ctl.setSurface} className="play-surface" style={{ backgroundColor: info.swatch }} />
        <div className="play-lighting" style={{ backgroundImage: lightingImage(theme) }} />
        <EndlessGrids />
        <World />
        <div ref={ctl.setMarqueeEl} className="play-marquee" hidden />
        <GhostLayer />
        <RefuseHint />
        <LongPressRing />
        {mode === 'play' && <HandTray />}
        {!hideZoomControls && <ZoomControls />}
        <DiceSelectionBar />
        <RollReadout />
        {children}
        <InspectOverlay />
        <ContextMenuHost />
        <BrowseDialog />
        <ShortcutsDialog />
      </div>
    </TableCtx.Provider>
  );
}

function World() {
  const ctl = useCtl();
  const order = useUi((s) => renderOrder(s.state));
  const names = useUi((s) => s.names);
  // Names switched on/off: re-solve every label before the frame paints, so the new set
  // appears already placed instead of popping in at its default spot and jumping.
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    ctl.resolveLabels();
  }, [ctl, names]);
  return (
    <div ref={ctl.setWorld} className="play-world">
      {order.map((id) => (
        <EntityView key={id} id={id} />
      ))}
      <DropLandMarker />
    </div>
  );
}

function GhostLayer() {
  const ctl = useCtl();
  const ghost = useUi((s) => s.ghost);
  const game = useUi((s) => s.game);
  const mode = useUi((s) => s.mode);
  return (
    <div ref={ctl.setGhostEl} className="play-ghost" hidden={!ghost} aria-hidden>
      <div ref={ctl.setGhostScaleEl} className="play-ghost__scale">
        <div ref={ctl.setGhostTiltEl} className="play-ghost__tilt">
          {ghost && (
            <div key={ghost.seq} className="play-ghost__lift">
              {ghost.items.map((it) => (
                <GhostEntity key={it.key} game={game} e={it.entity} dx={it.dx} dy={it.dy} mode={mode} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ZoomControls() {
  const ctl = useCtl();
  return (
    <div className="play-zoom" data-ui>
      <IconButton icon={Plus} label="Zoom in" variant="glass" tooltipPlacement="left" onClick={() => ctl.zoomBy(1.25)} />
      <IconButton icon={Minus} label="Zoom out" variant="glass" tooltipPlacement="left" onClick={() => ctl.zoomBy(0.8)} />
      <IconButton icon={Maximize} label="Show everything" shortcut="0" variant="glass" tooltipPlacement="left" onClick={() => ctl.fitAll(true)} />
    </div>
  );
}
