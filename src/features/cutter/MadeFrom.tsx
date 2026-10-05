/** "Made from Crucible p3–4 · Change the cut" — on Components tiles and component editors. */
import { useNavigate } from 'react-router';
import { Scissors } from 'lucide-react';
import type { Game, ID } from '@/shared/types';
import { cutterLink, groupFromLabel, groupThatMade, useCutterDoc } from './provenance';

export function MadeFrom({ game, componentId, compact }: { game: Game; componentId: ID; compact?: boolean }) {
  const doc = useCutterDoc(game.id);
  const navigate = useNavigate();
  const group = groupThatMade(doc, componentId);
  if (!doc || !group) return null;
  const from = groupFromLabel(doc, game, group);
  return (
    <span className={`made-from ${compact ? 'is-compact' : ''}`} data-testid="made-from">
      <Scissors size={12} aria-hidden />
      <span className="made-from__text">Made from {from || group.name}</span>
      <span aria-hidden>·</span>
      <button
        type="button"
        className="made-from__link"
        onClick={(e) => {
          e.stopPropagation();
          navigate(cutterLink(game.id, { group: group.id }));
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        data-testid="change-the-cut"
      >
        Change the cut
      </button>
    </span>
  );
}
