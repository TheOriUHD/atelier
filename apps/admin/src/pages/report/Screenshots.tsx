/** The report's screenshots as a grid, and a lightbox. Pictures come only from the panel's own /api. */
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { bytes } from '../../lib/format';

interface Info {
  name: string;
  mime: string;
  width: number;
  height: number;
  bytes: number;
}

export function Screenshots({
  id,
  files,
  info,
}: {
  id: string;
  files: { name: string; size: number }[];
  info: Info[];
}) {
  const [open, setOpen] = useState<number | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const meta = (file: string) => info.find((s) => file.startsWith(`${s.name}.`));
  const url = (file: string) => `/api/reports/${id}/files/${encodeURIComponent(file)}`;

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open !== null && !d.open) d.showModal();
    if (open === null && d.open) d.close();
  }, [open]);

  const step = (by: number) => setOpen((i) => (i === null ? i : (i + by + files.length) % files.length));
  const current = open !== null ? files[open] : undefined;

  return (
    <>
      <ul className="grid gap-4 sm:grid-cols-2">
        {files.map((f, i) => {
          const m = meta(f.name);
          return (
            <li key={f.name}>
              <button
                type="button"
                onClick={() => setOpen(i)}
                className="group block w-full overflow-hidden rounded-xl bg-bg-sunken text-left shadow-card-ring"
              >
                <img
                  src={url(f.name)}
                  alt={`Screenshot ${i + 1}`}
                  loading="lazy"
                  className="block w-full object-contain"
                  style={m ? { aspectRatio: `${m.width} / ${m.height}` } : undefined}
                />
                <span className="flex justify-between px-3 py-1.5 text-caption text-fg-muted">
                  <span>{f.name}</span>
                  <span className="tabular">
                    {m ? `${m.width} × ${m.height}, ` : ''}
                    {bytes(f.size)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <dialog
        ref={dialog}
        onClose={() => setOpen(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') step(1);
          if (e.key === 'ArrowLeft') step(-1);
        }}
        className="m-auto h-[calc(100vh-32px)] max-h-none w-[calc(100vw-32px)] max-w-none bg-transparent p-0 backdrop:bg-[rgba(0,0,0,0.85)]"
      >
        {current && (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between gap-2 px-2 py-2 text-footnote text-[rgba(255,255,255,0.8)]">
              <span>
                {current.name} · {open! + 1} of {files.length}
              </span>
              <div className="flex gap-1">
                {files.length > 1 && (
                  <>
                    <Button
                      variant="overlay"
                      aria-label="Previous"
                      icon={<ChevronLeft size={16} />}
                      onClick={() => step(-1)}
                    />
                    <Button
                      variant="overlay"
                      aria-label="Next"
                      icon={<ChevronRight size={16} />}
                      onClick={() => step(1)}
                    />
                  </>
                )}
                <Button variant="overlay" aria-label="Close" icon={<X size={16} />} onClick={() => setOpen(null)} />
              </div>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center p-2">
              <img
                src={url(current.name)}
                alt={`Screenshot ${open! + 1}`}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
