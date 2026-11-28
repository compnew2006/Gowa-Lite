import {File, FileText, Image, Link, Mic, Paperclip, Sticker, Video} from 'lucide-react';
import type {ChatPreview} from '@/lib/chat-preview';

function mediaIcon(mediaType: string) {
  const className = 'size-3.5 shrink-0';
  switch (mediaType) {
    case 'image':
      return <Image className={className} aria-hidden="true" />;
    case 'video':
      return <Video className={className} aria-hidden="true" />;
    case 'audio':
      return <Mic className={className} aria-hidden="true" />;
    case 'sticker':
      return <Sticker className={className} aria-hidden="true" />;
    case 'document':
      return <FileText className={className} aria-hidden="true" />;
    case 'link':
    case 'url':
      return <Link className={className} aria-hidden="true" />;
    case 'file':
      return <File className={className} aria-hidden="true" />;
    default:
      return <Paperclip className={className} aria-hidden="true" />;
  }
}

/**
 * The last-message preview line under the chat name in the list row (P2-2).
 * Text previews show the text; media messages with no text show a
 * media-type icon + short label. Renders nothing when there is no preview.
 */
export function ChatPreviewLine({preview}: {preview: ChatPreview | null}) {
  if (!preview) return null;
  if (preview.kind === 'text') {
    return (
      <p
        data-testid="chat-preview"
        className="mt-0.5 truncate text-[12.5px] text-muted-foreground"
      >
        {preview.text}
      </p>
    );
  }
  return (
    <p
      data-testid="chat-preview"
      className="mt-0.5 flex items-center gap-1 truncate text-[12.5px] text-muted-foreground"
    >
      {mediaIcon(preview.mediaType)}
      <span className="truncate">{preview.label}</span>
    </p>
  );
}
