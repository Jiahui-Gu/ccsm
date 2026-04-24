import type { ImageAttachment } from '../../../types';
import { attachmentToDataUrl, formatSize } from '../../../lib/attachments';

export function UserBlock({ text, images }: { text: string; images?: ImageAttachment[] }) {
  return (
    <div className="flex gap-3 text-base">
      <span className="text-fg-tertiary select-none w-3 shrink-0 font-mono">&gt;</span>
      <div className="min-w-0 flex-1 flex flex-col gap-1.5">
        {images && images.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {images.map((img) => (
              <a
                key={img.id}
                href={attachmentToDataUrl(img)}
                target="_blank"
                rel="noreferrer"
                title={`${img.name} · ${formatSize(img.size)}`}
                className="group relative block overflow-hidden rounded-sm border border-border-subtle hover:border-border-strong transition-colors duration-150 ease-out"
              >
                <img
                  src={attachmentToDataUrl(img)}
                  alt={img.name}
                  className="h-20 w-20 object-cover transition-transform duration-200 ease-out group-hover:scale-[1.02]"
                  draggable={false}
                />
              </a>
            ))}
          </div>
        )}
        {text && <span className="text-fg-secondary whitespace-pre-wrap">{text}</span>}
      </div>
    </div>
  );
}
