import type { ContentBlockUnion, MetadataBlock } from '../types/index.js';
import { config } from '../config/index.js';
import { truncateText } from '../utils/sanitizer.js';

function truncateBlock(block: ContentBlockUnion): ContentBlockUnion {
  const maxLength = config.extraction.maxBlockLength;

  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'code': {
      const truncated = truncateText(block.text, maxLength);
      return truncated === block.text ? block : { ...block, text: truncated };
    }
    case 'list': {
      const truncatedItems = block.items.map((item) =>
        truncateText(item, maxLength)
      );
      const hasChanges = truncatedItems.some(
        (item, i) => item !== block.items[i]
      );
      return hasChanges ? { ...block, items: truncatedItems } : block;
    }
    default:
      return block;
  }
}

export function toJsonl(
  blocks: ContentBlockUnion[],
  metadata?: MetadataBlock
): string {
  const lines: string[] = [];

  // Minimal metadata - just title and URL for context
  if (metadata) {
    try {
      const minimal = {
        type: metadata.type,
        title: metadata.title,
        url: metadata.url,
      };
      lines.push(JSON.stringify(minimal));
    } catch {
      // Skip invalid metadata
    }
  }

  for (const block of blocks) {
    try {
      lines.push(JSON.stringify(truncateBlock(block)));
    } catch {
      // Skip blocks that fail to serialize
    }
  }

  return lines.join('\n');
}
