import {Fragment, type ReactNode} from 'react';
import {cn} from '@/lib/utils';
import {
  parseWhatsAppText,
  type FormattedBlock,
  type FormattedLine,
  type InlineNode,
} from '@/features/chat/whatsapp-format';

function renderInline(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={index}>{node.text}</Fragment>;
      case 'link':
        return (
          <a
            key={index}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            className="break-all text-sky-600 underline decoration-sky-600/50 underline-offset-2 transition-colors hover:text-sky-500 dark:text-sky-400 dark:decoration-sky-400/50 dark:hover:text-sky-300"
          >
            {node.text}
          </a>
        );
      case 'bold':
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case 'italic':
        return <em key={index}>{renderInline(node.children)}</em>;
      case 'strike':
        return <s key={index}>{renderInline(node.children)}</s>;
      case 'code':
        return (
          <code key={index} className="rounded bg-muted px-1 font-mono text-[0.9em]">
            {node.text}
          </code>
        );
      case 'mono':
        return (
          <code key={index} className="font-mono text-[0.9em]">
            {node.text}
          </code>
        );
    }
  });
}

function renderLines(lines: FormattedLine[]): ReactNode[] {
  return lines.map((line, index) => (
    <Fragment key={index}>
      {index > 0 && '\n'}
      {renderInline(line)}
    </Fragment>
  ));
}

function renderBlock(block: FormattedBlock, index: number): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return <div key={index}>{renderLines(block.lines)}</div>;
    case 'quote':
      return (
        <blockquote key={index} className="border-s-2 border-current/30 ps-2 opacity-85">
          {renderLines(block.lines)}
        </blockquote>
      );
    case 'list':
      if (block.ordered) {
        return (
          <ol key={index} className="list-decimal ps-5">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} value={item.number}>
                {renderInline(item.content)}
              </li>
            ))}
          </ol>
        );
      }
      return (
        <ul key={index} className="list-disc ps-5">
          {block.items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item.content)}</li>
          ))}
        </ul>
      );
  }
}

export function FormattedText({text, className}: {text: string; className?: string}) {
  return (
    <div dir="auto" className={cn('break-words whitespace-pre-wrap leading-relaxed', className)}>
      {parseWhatsAppText(text).map(renderBlock)}
    </div>
  );
}
