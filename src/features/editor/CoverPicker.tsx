import { useMemo } from 'react';
import { Check, ImagePlus, Images } from 'lucide-react';
import { assetUrlById } from '@/api/client';
import type { Game, ID } from '@/shared/types';
import { Button, Dialog, EmptyState } from '@/ui';

interface Group {
  title: string;
  ids: ID[];
}

function collect(game: Game): Group[] {
  const seen = new Set<ID>();
  const isImage = (id: ID | null | undefined): id is ID => !!id && !!game.assets[id] && game.assets[id].mime.startsWith('image/');
  const take = (ids: (ID | null | undefined)[]) => {
    const out: ID[] = [];
    for (const id of ids) {
      if (isImage(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  };

  const groups: Group[] = [];
  const uploaded = take(
    Object.values(game.assets)
      .filter((a) => !a.role || a.role === 'cover' || a.role === 'image' || a.role === 'other')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((a) => a.id),
  );
  if (uploaded.length) groups.push({ title: 'Uploaded images', ids: uploaded });
  for (const c of game.components) {
    if (c.kind === 'board') {
      const ids = take([c.image]);
      if (ids.length) groups.push({ title: `Board · ${c.name}`, ids });
    } else if (c.kind === 'deck') {
      const ids = take([...c.cards.map((cd) => cd.front), c.back]);
      if (ids.length) groups.push({ title: `Cards · ${c.name}`, ids });
    } else if (c.kind === 'tokens') {
      const ids = take([c.front, c.back]);
      if (ids.length) groups.push({ title: `Tokens · ${c.name}`, ids });
    }
  }
  const pages = take(Object.values(game.assets).filter((a) => a.role === 'page').map((a) => a.id));
  if (pages.length) groups.push({ title: 'Source pages', ids: pages });
  return groups;
}

export function CoverPicker({
  open,
  game,
  onClose,
  onPick,
  onUpload,
}: {
  open: boolean;
  game: Game;
  onClose: () => void;
  onPick: (id: ID) => void;
  onUpload: () => void;
}) {
  const groups = useMemo(() => (open ? collect(game) : []), [open, game]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Choose a cover"
      description="Pick any image that’s already part of this game."
      footer={
        <>
          <Button variant="ghost" icon={ImagePlus} onClick={onUpload}>
            Upload a new image
          </Button>
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      {groups.length === 0 ? (
        <EmptyState
          compact
          icon={Images}
          title="No images in this game yet"
          description="Once you cut out cards or boards they’ll show up here. You can also upload a cover image."
          actions={
            <Button variant="primary" icon={ImagePlus} onClick={onUpload}>
              Upload an image
            </Button>
          }
        />
      ) : (
        <div className="ov-picker">
          {groups.map((g) => (
            <section key={g.title} className="ov-picker__group">
              <h3 className="ov-picker__title">
                {g.title} <span>{g.ids.length}</span>
              </h3>
              <div className="ov-picker__grid">
                {g.ids.map((id) => {
                  const on = game.cover === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`ov-picker__item ${on ? 'is-on' : ''}`}
                      aria-label={on ? 'Current cover' : 'Use as cover'}
                      aria-pressed={on}
                      onClick={() => onPick(id)}
                    >
                      <img src={assetUrlById(game, id)} alt="" loading="lazy" decoding="async" draggable={false} />
                      {on && (
                        <span className="ov-picker__check">
                          <Check size={14} strokeWidth={3} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}
