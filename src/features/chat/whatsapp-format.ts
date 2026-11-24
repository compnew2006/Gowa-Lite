/**
 * Parser for WhatsApp text formatting. Pure AST builder so message text is
 * rendered strictly as React elements and never injected as HTML.
 */
export type InlineNode =
  | {type: 'text'; text: string}
  | {type: 'link'; text: string; href: string}
  | {type: 'bold' | 'italic' | 'strike'; children: InlineNode[]}
  | {type: 'code'; text: string}
  | {type: 'mono'; text: string};

export type FormattedLine = InlineNode[];

export interface ListItem {
  number?: number;
  content: FormattedLine;
}

export type FormattedBlock =
  | {type: 'paragraph'; lines: FormattedLine[]}
  | {type: 'quote'; lines: FormattedLine[]}
  | {type: 'list'; ordered: boolean; items: ListItem[]};

type Piece = {kind: 'text'; value: string} | {kind: 'mono'; value: string};

const INLINE_MARKERS: Record<string, 'bold' | 'italic' | 'strike' | 'code'> = {
  '*': 'bold',
  _: 'italic',
  '~': 'strike',
  '`': 'code',
};

const FENCE = '```';
const WORD_CHAR = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const QUOTE_PREFIX = /^> /;
const BULLET_PREFIX = /^[-*] /;
const ORDERED_PREFIX = /^(\d+)\. /;

function splitFences(text: string): Piece[] {
  const pieces: Piece[] = [];
  let rest = text;
  let plain = '';
  while (rest.length > 0) {
    const start = rest.indexOf(FENCE);
    if (start === -1) break;
    const end = rest.indexOf(FENCE, start + FENCE.length);
    if (end === -1) break;
    const inner = rest.slice(start + FENCE.length, end);
    if (!/\S/.test(inner)) {
      plain += rest.slice(0, start + FENCE.length);
      rest = rest.slice(start + FENCE.length);
      continue;
    }
    plain += rest.slice(0, start);
    if (plain) pieces.push({kind: 'text', value: plain});
    plain = '';
    pieces.push({kind: 'mono', value: inner});
    rest = rest.slice(end + FENCE.length);
  }
  plain += rest;
  if (plain) pieces.push({kind: 'text', value: plain});
  return pieces;
}

function splitLines(pieces: Piece[]): Piece[][] {
  const lines: Piece[][] = [[]];
  for (const piece of pieces) {
    if (piece.kind === 'mono') {
      lines[lines.length - 1].push(piece);
      continue;
    }
    piece.value.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({kind: 'text', value: part});
    });
  }
  return lines;
}

function canOpen(text: string, index: number): boolean {
  const next = text[index + 1];
  if (next === undefined || next === text[index] || SPACE.test(next)) return false;
  const prev = text[index - 1];
  return prev === undefined || !WORD_CHAR.test(prev);
}

function canClose(text: string, index: number): boolean {
  const prev = text[index - 1];
  if (prev === undefined || prev === text[index] || SPACE.test(prev)) return false;
  const next = text[index + 1];
  return next === undefined || !WORD_CHAR.test(next);
}

function findClose(text: string, marker: string, openIndex: number): number {
  for (let index = openIndex + 2; index < text.length; index++) {
    if (text[index] === marker && canClose(text, index)) return index;
  }
  return -1;
}

const URL_REGEX = /(https?:\/\/[^\s<>]+|www\.[^\s<>]+)/i;
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '"', "'", '،', '؛', '؟']);

function trimTrailingPunctuation(rawUrl: string): string {
  let url = rawUrl;
  while (url.length > 0) {
    const last = url[url.length - 1];
    if (!TRAILING_PUNCTUATION.has(last)) break;
    if (last === ')') {
      const openCount = (url.match(/\(/g) ?? []).length;
      const closeCount = (url.match(/\)/g) ?? []).length;
      if (closeCount <= openCount) break;
    }
    if (last === ']') {
      const openCount = (url.match(/\[/g) ?? []).length;
      const closeCount = (url.match(/\]/g) ?? []).length;
      if (closeCount <= openCount) break;
    }
    url = url.slice(0, -1);
  }
  return url;
}

function normalizeUrlHref(url: string): string {
  return url.toLowerCase().startsWith('www.') ? `https://${url}` : url;
}

export function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const unclosed = new Set<string>();
  let buffer = '';
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    const prev = text[index - 1];
    if (
      (prev === undefined || !WORD_CHAR.test(prev)) &&
      (rest.startsWith('http://') ||
        rest.startsWith('https://') ||
        rest.startsWith('HTTP://') ||
        rest.startsWith('HTTPS://') ||
        rest.startsWith('www.') ||
        rest.startsWith('WWW.'))
    ) {
      const match = URL_REGEX.exec(rest);
      if (match && match.index === 0) {
        const cleanUrl = trimTrailingPunctuation(match[0]);
        if (cleanUrl) {
          if (buffer) nodes.push({type: 'text', text: buffer});
          buffer = '';
          nodes.push({type: 'link', text: cleanUrl, href: normalizeUrlHref(cleanUrl)});
          index += cleanUrl.length;
          continue;
        }
      }
    }

    const char = text[index];
    const type = INLINE_MARKERS[char];
    if (type && !unclosed.has(char) && canOpen(text, index)) {
      const close = findClose(text, char, index);
      if (close === -1) unclosed.add(char);
      if (close !== -1) {
        if (buffer) nodes.push({type: 'text', text: buffer});
        buffer = '';
        const inner = text.slice(index + 1, close);
        nodes.push(
          type === 'code' ? {type: 'code', text: inner} : {type, children: parseInline(inner)},
        );
        index = close + 1;
        continue;
      }
    }
    buffer += char;
    index++;
  }
  if (buffer) nodes.push({type: 'text', text: buffer});
  return nodes;
}

function parseLine(pieces: Piece[]): FormattedLine {
  return pieces.flatMap((piece): InlineNode[] =>
    piece.kind === 'mono' ? [{type: 'mono', text: piece.value}] : parseInline(piece.value),
  );
}

function stripPrefix(pieces: Piece[], length: number): Piece[] {
  const [first, ...rest] = pieces;
  if (!first || first.kind !== 'text') return pieces;
  const value = first.value.slice(length);
  return value ? [{kind: 'text', value}, ...rest] : rest;
}

type LineKind =
  | {kind: 'plain'}
  | {kind: 'quote'; length: number}
  | {kind: 'bullet'; length: number}
  | {kind: 'ordered'; length: number; number: number};

function classifyLine(pieces: Piece[]): LineKind {
  const first = pieces[0];
  if (!first || first.kind !== 'text') return {kind: 'plain'};
  const quote = QUOTE_PREFIX.exec(first.value);
  if (quote) return {kind: 'quote', length: quote[0].length};
  const bullet = BULLET_PREFIX.exec(first.value);
  if (bullet) return {kind: 'bullet', length: bullet[0].length};
  const ordered = ORDERED_PREFIX.exec(first.value);
  if (ordered) return {kind: 'ordered', length: ordered[0].length, number: Number(ordered[1])};
  return {kind: 'plain'};
}

export function parseWhatsAppText(text: string): FormattedBlock[] {
  const blocks: FormattedBlock[] = [];
  for (const pieces of splitLines(splitFences(text))) {
    const line = classifyLine(pieces);
    const last = blocks[blocks.length - 1];
    if (line.kind === 'plain') {
      const content = parseLine(pieces);
      if (last?.type === 'paragraph') last.lines.push(content);
      else blocks.push({type: 'paragraph', lines: [content]});
      continue;
    }
    const content = parseLine(stripPrefix(pieces, line.length));
    if (line.kind === 'quote') {
      if (last?.type === 'quote') last.lines.push(content);
      else blocks.push({type: 'quote', lines: [content]});
      continue;
    }
    const ordered = line.kind === 'ordered';
    const item: ListItem = line.kind === 'ordered' ? {number: line.number, content} : {content};
    if (last?.type === 'list' && last.ordered === ordered) last.items.push(item);
    else blocks.push({type: 'list', ordered, items: [item]});
  }
  return blocks;
}
