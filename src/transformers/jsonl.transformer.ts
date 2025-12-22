import { config } from '../config/index.js';
import type { ContentBlockUnion, MetadataBlock } from '../config/types.js';

import { truncateText } from '../utils/sanitizer.js';

const TEXT_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'code',
  'blockquote',
]);

function isTextBlock(
  block: ContentBlockUnion
): block is Extract<ContentBlockUnion, { text: string }> {
  return 'text' in block;
}

function isListBlock(
  block: ContentBlockUnion
): block is Extract<ContentBlockUnion, { items: string[] }> {
  return block.type === 'list';
}

function truncateTextBlock(
  block: Extract<ContentBlockUnion, { text: string }>,
  maxLength: number
): ContentBlockUnion {
  const truncated = truncateText(block.text, maxLength);
  return truncated === block.text ? block : { ...block, text: truncated };
}

function truncateListBlock(
  block: Extract<ContentBlockUnion, { items: string[] }>,
  maxLength: number
): ContentBlockUnion {
  const truncatedItems = block.items.map((item) =>
    truncateText(item, maxLength)
  );
  const hasChanges = truncatedItems.some(
    (item, index) => item !== block.items[index]
  );
  return hasChanges ? { ...block, items: truncatedItems } : block;
}

function truncateBlock(block: ContentBlockUnion): ContentBlockUnion {
  const maxLength = config.extraction.maxBlockLength;

  if (TEXT_BLOCK_TYPES.has(block.type) && isTextBlock(block)) {
    return truncateTextBlock(block, maxLength);
  }

  if (isListBlock(block)) {
    return truncateListBlock(block, maxLength);
  }

  return block;
}

function serializeBlock(block: ContentBlockUnion): string | null {
  try {
    return JSON.stringify(truncateBlock(block));
  } catch {
    return null;
  }
}

export function toJsonl(
  blocks: readonly ContentBlockUnion[],
  metadata?: MetadataBlock
): string {
  const lines: string[] = [];

  if (metadata) {
    try {
      const minimalMetadata = {
        type: metadata.type,
        title: metadata.title,
        url: metadata.url,
      };
      lines.push(JSON.stringify(minimalMetadata));
    } catch {
      /* skip */
    }
  }

  for (const block of blocks) {
    const serialized = serializeBlock(block);
    if (serialized) {
      lines.push(serialized);
    }
  }

  return lines.join('\n');
}
