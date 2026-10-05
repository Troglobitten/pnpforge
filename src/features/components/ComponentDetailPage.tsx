import { useNavigate, useParams } from 'react-router';
import { ChevronLeft, PackageOpen, Undo2 } from 'lucide-react';
import { Button, EmptyState, Spinner } from '@/ui';
import { useGame } from '@/state/gameStore';
import { AssetPickerHost } from './AssetPicker';
import { DeckEditor } from './deck/DeckEditor';
import { BoardEditor } from './BoardEditor';
import { TokenEditor } from './TokenEditor';
import { DieEditor } from './DieEditor';
import { CounterEditor } from './CounterEditor';
import { PieceEditor } from './PieceEditor';
import './components.css';

export default function ComponentDetailPage() {
  const { componentId, gameId } = useParams();
  const navigate = useNavigate();
  const game = useGame((s) => s.game);
  const canUndo = useGame((s) => s.past.length > 0);

  if (!game)
    return (
      <div className="cmp-loading">
        <Spinner size={22} />
      </div>
    );

  const comp = game.components.find((c) => c.id === componentId);
  if (!comp)
    return (
      <div className="cmp-page cmp-page--center">
        <EmptyState
          icon={PackageOpen}
          title="This component isn’t here any more"
          description="It may have been deleted. You can undo that, or go back to all components."
          actions={
            <>
              {canUndo && (
                <Button icon={Undo2} onClick={() => useGame.getState().undo()}>
                  Undo last change
                </Button>
              )}
              <Button variant="primary" icon={ChevronLeft} onClick={() => navigate(`/games/${gameId}/edit/components`)}>
                All components
              </Button>
            </>
          }
        />
      </div>
    );

  return (
    <>
      {comp.kind === 'deck' && <DeckEditor key={comp.id} game={game} deck={comp} />}
      {comp.kind === 'board' && <BoardEditor key={comp.id} game={game} board={comp} />}
      {comp.kind === 'tokens' && <TokenEditor key={comp.id} game={game} token={comp} />}
      {comp.kind === 'dice' && <DieEditor key={comp.id} game={game} die={comp} />}
      {comp.kind === 'counter' && <CounterEditor key={comp.id} counter={comp} />}
      {comp.kind === 'piece' && <PieceEditor key={comp.id} game={game} piece={comp} />}
      <AssetPickerHost />
    </>
  );
}
