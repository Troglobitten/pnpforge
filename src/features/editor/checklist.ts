import type { Game } from '@/shared/types';
import { plural } from '@/features/library/util';

export type StepId = 'sources' | 'components' | 'setup' | 'play';

export interface ChecklistStep {
  id: StepId;
  n: number;
  title: string;
  desc: string;
  done: boolean;
  /** Short progress text shown when done, e.g. "2 files added". */
  summary: string;
  to: string;
  cta: string;
}

/** The getting-started flow, derived from real game state. */
export function getChecklist(game: Game, sessionCount: number | undefined) {
  const base = `/games/${game.id}/edit`;
  const pnpSources = game.sources.filter((s) => s.id !== game.rules.sourceId);
  const pages = game.sources.reduce((n, s) => n + s.pageCount, 0);
  const cards = game.components.reduce((n, c) => (c.kind === 'deck' ? n + c.cards.reduce((m, cd) => m + (cd.count ?? 1), 0) : n), 0);
  const entities = Object.keys(game.setup.entities).length;

  const cutTo =
    pnpSources.length === 1 ? `${base}/sources/${pnpSources[0].id}` : game.sources.length ? `${base}/sources` : `${base}/components`;

  const steps: ChecklistStep[] = [
    {
      id: 'sources',
      n: 1,
      title: 'Add your PnP files',
      desc: 'Upload the print-and-play PDF or images.',
      done: game.sources.length > 0,
      summary: `${plural(game.sources.length, 'file')} · ${plural(pages, 'page')}`,
      to: `${base}/sources`,
      cta: 'Add files',
    },
    {
      id: 'components',
      n: 2,
      title: 'Cut out components',
      desc: 'Mark cards, boards and tokens on your pages.',
      done: game.components.length > 0,
      summary: cards ? `${plural(game.components.length, 'component')} · ${plural(cards, 'card')}` : plural(game.components.length, 'component'),
      to: game.components.length ? `${base}/components` : cutTo,
      cta: game.sources.length ? 'Start cutting' : 'Add components',
    },
    {
      id: 'setup',
      n: 3,
      title: 'Arrange the starting table',
      desc: 'Place decks, boards and tokens where a game begins.',
      done: entities > 0,
      summary: `${plural(entities, 'piece')} placed`,
      to: `${base}/setup`,
      cta: 'Arrange table',
    },
    {
      id: 'play',
      n: 4,
      title: 'Play',
      desc: 'Try it out on the table. Progress saves automatically.',
      done: (sessionCount ?? 0) > 0,
      summary: sessionCount ? `${plural(sessionCount, 'saved game')}` : 'Played',
      to: `/games/${game.id}/play`,
      cta: 'Test play',
    },
  ];
  const next = steps.find((s) => !s.done) ?? null;
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, next, doneCount, total: steps.length };
}
