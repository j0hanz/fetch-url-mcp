import { parseHTML } from 'linkedom';

import { Readability } from '@mozilla/readability';

import type {
  ExtractedArticle,
  ExtractedMetadata,
  ExtractionResult,
} from '../config/types.js';

import { truncateHtml } from '../utils/html-truncator.js';

import { logError, logWarn } from './logger.js';

type MetaSource = 'og' | 'twitter' | 'standard';
type MetaField = keyof ExtractedMetadata;

interface MetaCollectorState {
  title: Partial<Record<MetaSource, string>>;
  description: Partial<Record<MetaSource, string>>;
  author: Partial<Record<MetaSource, string>>;
}

class MetadataCollector {
  private readonly state: MetaCollectorState = {
    title: {},
    description: {},
    author: {},
  };

  constructor(private readonly document: Document) {}

  extract(): ExtractedMetadata {
    this.scanMetaTags();
    this.scanTitleTag();

    return {
      title: this.resolveField('title'),
      description: this.resolveField('description'),
      author: this.resolveField('author'),
    };
  }

  private scanMetaTags(): void {
    const metaTags = this.document.querySelectorAll('meta');

    for (const tag of metaTags) {
      const name = tag.getAttribute('name');
      const property = tag.getAttribute('property');
      const content = tag.getAttribute('content')?.trim();

      if (!content) continue;

      if (property?.startsWith('og:')) {
        this.processOpenGraph(property, content);
      } else if (name?.startsWith('twitter:')) {
        this.processTwitter(name, content);
      } else if (name) {
        this.processStandard(name, content);
      }
    }
  }

  private scanTitleTag(): void {
    if (!this.state.title.standard) {
      const titleEl = this.document.querySelector('title');
      if (titleEl?.textContent) {
        this.state.title.standard = titleEl.textContent.trim();
      }
    }
  }

  private processOpenGraph(property: string, content: string): void {
    const key = property.replace('og:', '');
    if (key === 'title') this.state.title.og = content;
    if (key === 'description') this.state.description.og = content;
  }

  private processTwitter(name: string, content: string): void {
    const key = name.replace('twitter:', '');
    if (key === 'title') this.state.title.twitter = content;
    if (key === 'description') this.state.description.twitter = content;
  }

  private processStandard(name: string, content: string): void {
    if (name === 'description') this.state.description.standard = content;
    if (name === 'author') this.state.author.standard = content;
  }

  private resolveField(field: MetaField): string | undefined {
    const sources = this.state[field];
    return sources.og ?? sources.twitter ?? sources.standard;
  }
}

class ArticleExtractor {
  constructor(private readonly document: Document) {}

  extract(): ExtractedArticle | null {
    try {
      const reader = new Readability(this.document as unknown as Document);
      const parsed = reader.parse();

      if (!parsed) return null;

      return {
        title: parsed.title ?? undefined,
        byline: parsed.byline ?? undefined,
        content: parsed.content ?? '',
        textContent: parsed.textContent ?? '',
        excerpt: parsed.excerpt ?? undefined,
        siteName: parsed.siteName ?? undefined,
      };
    } catch (error) {
      logError(
        'Failed to extract article with Readability',
        error instanceof Error ? error : undefined
      );
      return null;
    }
  }
}

export function extractContent(
  html: string,
  url: string,
  options: { extractArticle?: boolean } = { extractArticle: true }
): ExtractionResult {
  if (!html || typeof html !== 'string') {
    logWarn('extractContent called with invalid HTML input');
    return { article: null, metadata: {} };
  }

  if (!url || typeof url !== 'string') {
    logWarn('extractContent called with invalid URL');
    return { article: null, metadata: {} };
  }

  try {
    const processedHtml = truncateHtml(html);
    const { document } = parseHTML(processedHtml);

    // Set baseURI for relative link resolution
    try {
      Object.defineProperty(document, 'baseURI', {
        value: url,
        writable: true,
      });
    } catch {
      // Ignore errors in setting baseURI
    }
    const collector = new MetadataCollector(document as unknown as Document);
    const metadata = collector.extract();
    let article: ExtractedArticle | null = null;
    if (options.extractArticle) {
      const extractor = new ArticleExtractor(document as unknown as Document);
      article = extractor.extract();
    }

    return { article, metadata };
  } catch (error) {
    logError(
      'Failed to extract content',
      error instanceof Error ? error : undefined
    );
    return { article: null, metadata: {} };
  }
}
