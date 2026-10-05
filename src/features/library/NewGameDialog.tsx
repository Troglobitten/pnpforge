import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { FileText, FileUp, Image as ImageIcon, X } from 'lucide-react';
import { Button, Dialog, Field, TextInput, toast } from '@/ui';
import { createGameFromFiles } from './actions';
import { dragHasFiles } from './useFileDrop';
import { formatBytes, isImageFile, isSourceFile, nameFromFiles, pickFiles } from './util';

export function NewGameDialog({ open, onClose, initialFiles }: { open: boolean; onClose: () => void; initialFiles?: File[] }) {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setNameTouched(false);
    setFiles(initialFiles ?? []);
    setBusy(false);
    setOver(false);
  }, [open, initialFiles]);

  const addFiles = (incoming: File[]) => {
    const ok = incoming.filter(isSourceFile);
    const rejected = incoming.length - ok.length;
    if (rejected) toast.warning(`${rejected === 1 ? 'One file was' : `${rejected} files were`} skipped`, { description: 'Add PDFs or images (PNG, JPG, WebP).' });
    if (!ok.length) return;
    setFiles((prev) => {
      const next = [...prev, ...ok.filter((f) => !prev.some((p) => p.name === f.name && p.size === f.size))];
      return next;
    });
  };

  const suggested = files.length ? nameFromFiles(files) : '';
  const effectiveName = nameTouched ? name : name || suggested;

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const game = await createGameFromFiles(files, effectiveName.trim() || 'Untitled game');
      onClose();
      navigate(`/games/${game.id}/edit/${files.length ? 'sources' : 'overview'}`);
    } catch (e: any) {
      toast.error('Couldn’t create the game', { description: e?.message });
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      title="New game"
      description="Give it a name — you can change everything later."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} loading={busy}>
            {files.length ? 'Create & add files' : 'Create game'}
          </Button>
        </>
      }
    >
      <form
        className="lib-newgame"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" htmlFor="newgame-name">
          <TextInput
            id="newgame-name"
            autoFocus
            value={effectiveName}
            placeholder="e.g. Lantern Keep"
            maxLength={120}
            onChange={(e) => {
              setName(e.target.value);
              setNameTouched(true);
            }}
          />
        </Field>

        <Field label={<>Print-and-play files <span className="lib-newgame__opt">optional</span></>}>
          <div
            className={`lib-dropzone ${over ? 'is-over' : ''} ${files.length ? 'has-files' : ''}`}
            onDragEnter={(e) => {
              if (!dragHasFiles(e)) return;
              e.preventDefault();
              setOver(true);
            }}
            onDragOver={(e) => {
              if (!dragHasFiles(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false);
            }}
            onDrop={(e) => {
              if (!dragHasFiles(e)) return;
              e.preventDefault();
              setOver(false);
              addFiles(Array.from(e.dataTransfer.files));
            }}
          >
            <button
              type="button"
              className="lib-dropzone__hit"
              onClick={async () => addFiles(await pickFiles({ accept: 'application/pdf,image/*', multiple: true }))}
            >
              <span className="lib-dropzone__icon">
                <FileUp size={20} />
              </span>
              <span className="lib-dropzone__text">
                <strong>Drop your PDF or images here</strong>
                <span>or click to browse — you can also add them later</span>
              </span>
            </button>
            {files.length > 0 && (
              <ul className="lib-filelist">
                {files.map((f, i) => {
                  const Icon = isImageFile(f) ? ImageIcon : FileText;
                  return (
                    <li key={`${f.name}-${i}`} className="lib-filelist__item">
                      <Icon size={16} className="lib-filelist__icon" />
                      <span className="lib-filelist__name" title={f.name}>
                        {f.name}
                      </span>
                      <span className="lib-filelist__size">{formatBytes(f.size)}</span>
                      <button
                        type="button"
                        className="lib-filelist__remove"
                        aria-label={`Remove ${f.name}`}
                        onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
