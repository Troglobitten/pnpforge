/**
 * The one place for app-wide preferences. Mounted once in App.tsx; open it from anywhere
 * with `openSettings()`. Every switch applies instantly and is saved to the server.
 */
import type { ReactNode } from 'react';
import { create } from 'zustand';
import { CloudAlert, CloudCheck, LoaderCircle } from 'lucide-react';
import { Button, Dialog, Switch } from '@/ui';
import { useSettings } from '@/state/settings';
import { DEFAULT_SETTINGS, type AppSettings } from '@/shared/settings';
import './settings.css';

const useSettingsDialog = create<{ open: boolean }>(() => ({ open: false }));

export function openSettings() {
  useSettingsDialog.setState({ open: true });
}

function Row({ k, title, children, value: override }: { k: keyof AppSettings; title: string; children?: ReactNode; value?: boolean }) {
  const stored = useSettings((s) => s.settings[k]);
  const value = override ?? stored;
  const set = useSettings((s) => s.set);
  return (
    <Switch
      className="set-row"
      checked={value}
      onChange={(v) => set({ [k]: v })}
      label={
        <span className="set-row__text">
          <span className="set-row__title">{title}</span>
          {children && <span className="set-row__desc">{children}</span>}
        </span>
      }
    />
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="set-group" aria-label={title}>
      <h3 className="set-group__title">{title}</h3>
      <div className="set-group__rows">{children}</div>
    </section>
  );
}

export function SettingsHost() {
  const open = useSettingsDialog((s) => s.open);
  const sync = useSettings((s) => s.sync);
  // a device that said "Got it" shows tips as off, so Reset (which brings them back) must be offered
  const isDefault = useSettings((s) => !s.tipsSeen && (Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[]).every((k) => s.settings[k] === DEFAULT_SETTINGS[k]));
  const reset = useSettings((s) => s.reset);
  const tipsHere = useSettings((s) => s.settings.tableTips && !s.tipsSeen);
  if (!open) return null;
  const close = () => useSettingsDialog.setState({ open: false });

  const status =
    sync === 'saving' ? (
      <>
        <LoaderCircle size={15} className="set-status__spin" /> Saving…
      </>
    ) : sync === 'error' ? (
      <>
        <CloudAlert size={15} /> Not saved yet — applies in this browser, will retry
      </>
    ) : (
      <>
        <CloudCheck size={15} /> Saved for every device using this pnpforge
      </>
    );

  return (
    <Dialog
      open
      size="md"
      title="Settings"
      description="These apply to every game. Changes take effect straight away."
      onClose={close}
      className="set-dialog"
      footer={
        <>
          <span className={`set-status is-${sync}`} role="status" aria-live="polite">
            {status}
          </span>
          <Button variant="ghost" disabled={isDefault} onClick={reset}>
            Reset to defaults
          </Button>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <Group title="On the table">
        <Row k="showNamesPlay" title="Show names on the table">
          Labels on zones, card stacks and token supplies. When off, a name still appears when you point at a piece,
          select it, or open its menu.
        </Row>
        <Row k="tableTips" title="Show gesture tips" value={tipsHere}>
          The short “drag · double-tap · long-press” reminder when a table opens. “Got it” hides it on that device only.
        </Row>
        <Row k="sound" title="Table sounds">
          Soft sounds for flipping, shuffling, rolling and placing pieces.
        </Row>
      </Group>
      <Group title="Table setup (editor)">
        <Row k="showNamesSetup" title="Show names while arranging a table">
          Handy when you are laying out zones and decks. Does not change what players see.
        </Row>
        <Row k="snapToGrid" title="Snap pieces to a 5 mm grid">
          Keeps moved pieces and drawn zones neatly aligned.
        </Row>
      </Group>
    </Dialog>
  );
}
