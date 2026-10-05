import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { ImagePlus, Images } from 'lucide-react';
import { Button, Dialog, EmptyState, Segmented, ProgressBar } from '@/ui';
import { useGame } from '@/state/gameStore';
import type { AssetRole, ID } from '@/shared/types';
import { imageAssets, pickFiles, uploadImages, urlOf } from './lib';
import { toast } from '@/ui';

interface PickOpts {
  title: string;
  description?: string;
  /** Restrict the choice to these assets (e.g. a deck's card fronts). */
  only?: ID[];
  /** Role used for "Upload new". */
  role?: AssetRole;
  current?: ID | null;
}

interface Req {
  opts: PickOpts;
  resolve: (id: ID | null) => void;
}

const usePicker = create<{ req: Req | null; set: (r: Req | null) => void }>((set) => ({ req: null, set: (req) => set({ req }) }));

/** Let the user choose one of the game's images. Resolves null if cancelled. */
export function pickAsset(opts: PickOpts): Promise<ID | null> {
  return new Promise((resolve) => usePicker.getState().set({ opts, resolve }));
}

type Filter = 'all' | 'card' | 'image' | 'page';

/** Mount once per page that uses pickAsset(). */
export function AssetPickerHost() {
  const { req, set } = usePicker();
  if (!req) return null;
  return (
    <PickerDialog
      key={req.opts.title}
      opts={req.opts}
      onDone={(id) => {
        req.resolve(id);
        set(null);
      }}
    />
  );
}

function PickerDialog({ opts, onDone }: { opts: PickOpts; onDone: (id: ID | null) => void }) {
  const game = useGame((s) => s.game)!;
  const addAssets = useGame((s) => s.addAssets);
  const [filter, setFilter] = useState<Filter>('all');
  const [progress, setProgress] = useState<number | null>(null);

  const all = useMemo(() => {
    const list = imageAssets(game);
    if (!opts.only) return list;
    const keep = new Set(opts.only);
    return list.filter((a) => keep.has(a.id));
  }, [game, opts.only]);
  const counts = useMemo(() => {
    const c = { all: all.length, card: 0, image: 0, page: 0 };
    for (const a of all) {
      if (a.role === 'card') c.card++;
      else if (a.role === 'page') c.page++;
      else c.image++;
    }
    return c;
  }, [all]);
  const shown = all.filter((a) =>
    filter === 'all' ? true : filter === 'card' ? a.role === 'card' : filter === 'page' ? a.role === 'page' : a.role !== 'card' && a.role !== 'page' && a.role !== 'photo',
  );

  const uploadNew = async () => {
    const files = await pickFiles({ multiple: false });
    if (!files.length) return;
    setProgress(0);
    try {
      const assets = await uploadImages(game.id, files, opts.role ?? 'image', setProgress);
      addAssets(assets);
      if (assets[0]) onDone(assets[0].id);
    } catch (e: any) {
      toast.error('Upload failed', { description: e?.message });
    } finally {
      setProgress(null);
    }
  };

  return (
    <Dialog
      open
      size="lg"
      title={opts.title}
      description={opts.description}
      onClose={() => onDone(null)}
      footer={
        <>
          {progress != null ? (
            <div className="cmp-picker__progress">
              <ProgressBar value={progress} />
            </div>
          ) : (
            !opts.only && (
              <Button icon={ImagePlus} onClick={uploadNew} className="cmp-picker__upload">
                Upload new image…
              </Button>
            )
          )}
          <Button variant="ghost" onClick={() => onDone(null)}>
            Cancel
          </Button>
        </>
      }
    >
      {!opts.only && all.length > 0 && (
        <Segmented<Filter>
          size="sm"
          className="cmp-picker__filter"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All ${counts.all}` },
            ...(counts.card ? [{ value: 'card' as const, label: `Card art ${counts.card}` }] : []),
            ...(counts.image ? [{ value: 'image' as const, label: `Images ${counts.image}` }] : []),
            ...(counts.page ? [{ value: 'page' as const, label: `PDF pages ${counts.page}` }] : []),
          ]}
        />
      )}
      {shown.length === 0 ? (
        <EmptyState
          compact
          icon={Images}
          title={opts.only ? 'No card images yet' : 'No images in this game yet'}
          description={opts.only ? 'Add card images to this deck first.' : 'Upload an image, or cut some from a PDF on the Sources page.'}
        />
      ) : (
        <div className="cmp-picker__grid">
          {shown.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`cmp-picker__item ${opts.current === a.id ? 'is-current' : ''}`}
              onClick={() => onDone(a.id)}
              title={a.name}
            >
              <span className="cmp-picker__thumb">
                <img src={urlOf(game, a.id)} alt="" loading="lazy" draggable={false} />
              </span>
              <span className="cmp-picker__name">{a.name ?? 'Image'}</span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
