import type { ContentBlockUnion, MetadataBlock } from '../types/index.js';
import { config } from '../config/index.js';
import { truncateText } from '../utils/sanitizer.js';
import { logError } from '../services/logger.js';

function truncateBlock(block: ContentBlockUnion): ContentBlockUnion {
  const maxLength = config.extraction.maxBlockLength;

  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'code': {
      const truncated = truncateText(block.text, maxLength);
      // Avoid creating new object if no truncation occurred
      return truncated === block.text ? block : { ...block, text: truncated };
    }
    case 'list': {
      const truncatedItems = block.items.map((item) =>
        truncateText(item, maxLength)
      );
      // Check if any items were truncated by comparing lengths
      const hasChanges = truncatedItems.some(
        (item, i) => item !== block.items[i]
      );
      // Avoid creating new object if no truncation occurred
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

  if (metadata) lines.push(JSON.stringify(metadata));

  for (const block of blocks) {
    lines.push(JSON.stringify(truncateBlock(block)));
  }

  return lines.join('\n');
}

export function fromJsonl(jsonl: string): ContentBlockUnion[] {
  const lines = jsonl.split('\n').filter((line) => line.trim());
  const blocks: ContentBlockUnion[] = [];

  for (const line of lines) {
    try {
      blocks.push(JSON.parse(line) as ContentBlockUnion);
    } catch (error) {
      logError(
        'Failed to parse JSONL line',
        error instanceof Error ? error : undefined
      );
    }
  }

  return blocks;
}
