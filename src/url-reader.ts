import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isIP } from "node:net";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { fetch as undiciFetch } from "undici";
import { createProxyAgent, createDefaultAgent, ProxyType } from "./proxy.js";
import { logMessage } from "./logging.js";
import { urlCache } from "./cache.js";
import { getHttpSecurityConfig } from "./http-security.js";
import {
  createURLFormatError,
  createURLSecurityPolicyError,
  createNetworkError,
  createServerError,
  createContentError,
  createConversionError,
  createTimeoutError,
  createEmptyContentWarning,
  createUnexpectedError,
  type ErrorContext
} from "./error-handler.js";

interface PaginationOptions {
  startChar?: number;
  maxLength?: number;
  section?: string;
  paragraphRange?: string;
  readHeadings?: boolean;
  extractMainContent?: boolean;
  extractMetadata?: boolean;
}

interface PageMetadata {
  title?: string;
  author?: string;
  publishedDate?: string;
  description?: string;
  siteName?: string;
}

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, "");
  return lower === "localhost" || lower.endsWith(".localhost");
}

function isPrivateIpv4(hostname: string): boolean {
  if (isIP(hostname) !== 4) {
    return false;
  }

  return (
    hostname.startsWith("10.") ||
    hostname.startsWith("127.") ||
    hostname.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname) ||
    hostname.startsWith("169.254.")
  );
}

function isPrivateIPv6(hostname: string): boolean {
  // url.hostname wraps IPv6 in brackets (e.g. "[::1]") — strip them first
  const addr = (hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
  ).toLowerCase();

  if (isIP(addr) !== 6) return false;

  if (addr === "::1") return true;                        // loopback
  if (addr === "::") return true;                         // unspecified
  if (/^f[cd]/i.test(addr)) return true;                 // ULA fc00::/7
  if (/^fe[89ab][0-9a-f]:/i.test(addr)) return true;    // link-local fe80::/10

  // IPv4-mapped ::ffff:<ipv4> — delegate to the IPv4 check
  const mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);

  return false;
}

function assertUrlAllowed(url: URL): void {
  const security = getHttpSecurityConfig();
  if (!security.harden || security.allowPrivateUrls) {
    return;
  }

  if (isPrivateHostname(url.hostname) || isPrivateIpv4(url.hostname) || isPrivateIPv6(url.hostname)) {
    throw createURLSecurityPolicyError(url.toString());
  }
}

function applyCharacterPagination(content: string, startChar: number = 0, maxLength?: number): string {
  if (startChar >= content.length) {
    return "";
  }

  const start = Math.max(0, startChar);
  const end = maxLength ? Math.min(content.length, start + maxLength) : content.length;

  return content.slice(start, end);
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(markdownContent: string, sectionHeading: string): string {
  const lines = markdownContent.split('\n');
  const sectionRegex = new RegExp(`^#{1,6}\\s*.*${escapeRegExp(sectionHeading)}.*$`, 'i');

  let startIndex = -1;
  let currentLevel = 0;

  // Find the section start
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (sectionRegex.test(line)) {
      startIndex = i;
      currentLevel = (line.match(/^#+/) || [''])[0].length;
      break;
    }
  }

  if (startIndex === -1) {
    return "";
  }

  // Find the section end (next heading of same or higher level)
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^#+/);
    if (match && match[0].length <= currentLevel) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(startIndex, endIndex).join('\n');
}

function extractParagraphRange(markdownContent: string, range: string): string {
  const paragraphs = markdownContent.split('\n\n').filter(p => p.trim().length > 0);

  // Parse range (e.g., "1-5", "3", "10-")
  const rangeMatch = range.match(/^(\d+)(?:-(\d*))?$/);
  if (!rangeMatch) {
    return "";
  }

  const start = parseInt(rangeMatch[1]) - 1; // Convert to 0-based index
  const endStr = rangeMatch[2];

  if (start < 0 || start >= paragraphs.length) {
    return "";
  }

  if (endStr === undefined) {
    // Single paragraph (e.g., "3")
    return paragraphs[start] || "";
  } else if (endStr === "") {
    // Range to end (e.g., "10-")
    return paragraphs.slice(start).join('\n\n');
  } else {
    // Specific range (e.g., "1-5")
    const end = parseInt(endStr);
    return paragraphs.slice(start, end).join('\n\n');
  }
}

function extractHeadings(markdownContent: string): string {
  const lines = markdownContent.split('\n');
  const headings = lines.filter(line => /^#{1,6}\s/.test(line));

  if (headings.length === 0) {
    return "No headings found in the content.";
  }

  return headings.join('\n');
}

const DEFAULT_MAX_LENGTH = 8000;

function isTargetedFetch(options: PaginationOptions): boolean {
  return options.readHeadings === true
    || options.section !== undefined
    || options.paragraphRange !== undefined;
}

export function extractMainContent(html: string, url: string): string | null {
  const doc = new JSDOM(html, { url });
  const reader = new Readability(doc.window.document);
  const article = reader.parse();
  if (!article?.content) {
    return null;
  }
  return article.content;
}

function getMeta(doc: Document, name: string): string | undefined {
  // Try name attribute first, then property (og:), then itemprop
  const el = doc.querySelector(`meta[name="${name}"], meta[property="${name}"], meta[itemprop="${name}"]`);
  return el?.getAttribute("content")?.trim() || undefined;
}

export function extractMetadata(html: string, url: string): PageMetadata {
  const doc = new JSDOM(html, { url }).window.document;

  const title = getMeta(doc, "og:title")
    || getMeta(doc, "twitter:title")
    || doc.querySelector("title")?.textContent?.trim()
    || undefined;

  const author = getMeta(doc, "author")
    || getMeta(doc, "article:author")
    || getMeta(doc, "og:article:author")
    || undefined;

  const publishedDate = getMeta(doc, "article:published_time")
    || getMeta(doc, "og:article:published_time")
    || getMeta(doc, "date")
    || getMeta(doc, "pubdate")
    || undefined;

  const description = getMeta(doc, "description")
    || getMeta(doc, "og:description")
    || getMeta(doc, "twitter:description")
    || undefined;

  const siteName = getMeta(doc, "og:site_name")
    || undefined;

  // Only include keys that have values
  const result: PageMetadata = {};
  if (title) result.title = title;
  if (author) result.author = author;
  if (publishedDate) result.publishedDate = publishedDate;
  if (description) result.description = description;
  if (siteName) result.siteName = siteName;
  return result;
}

function formatMetadataBlock(metadata: PageMetadata): string {
  const lines: string[] = [];
  if (metadata.title) lines.push(`title: ${metadata.title}`);
  if (metadata.author) lines.push(`author: ${metadata.author}`);
  if (metadata.publishedDate) lines.push(`published: ${metadata.publishedDate}`);
  if (metadata.description) lines.push(`description: ${metadata.description}`);
  if (metadata.siteName) lines.push(`site: ${metadata.siteName}`);
  return lines.length > 0 ? `---\n${lines.join("\n")}\n---\n\n` : "";
}

function applyPaginationOptions(markdownContent: string, options: PaginationOptions): string {
  let result = markdownContent;

  // Apply heading extraction first if requested
  if (options.readHeadings) {
    return extractHeadings(result);
  }

  // Apply section extraction
  if (options.section) {
    result = extractSection(result, options.section);
    if (result === "") {
      return `Section "${options.section}" not found in the content.`;
    }
  }

  // Apply paragraph range filtering
  if (options.paragraphRange) {
    result = extractParagraphRange(result, options.paragraphRange);
    if (result === "") {
      return `Paragraph range "${options.paragraphRange}" is invalid or out of bounds.`;
    }
  }

  // Apply character-based pagination. When the caller specified no
  // pagination at all (bare full-page fetch), apply a default cap to
  // prevent accidentally pulling huge pages into context.
  if (options.maxLength !== undefined || options.startChar !== undefined) {
    result = applyCharacterPagination(result, options.startChar, options.maxLength);
  } else if (!isTargetedFetch(options) && result.length > DEFAULT_MAX_LENGTH) {
    result = applyCharacterPagination(result, 0, DEFAULT_MAX_LENGTH);
  }

  return result;
}

export async function fetchAndConvertToMarkdown(
  mcpServer: McpServer,
  url: string,
  timeoutMs: number = 10000,
  paginationOptions: PaginationOptions = {}
) {
  const startTime = Date.now();
  logMessage(mcpServer, "info", `Fetching URL: ${url}`);

  // Check cache first
  const cachedEntry = urlCache.get(url);
  if (cachedEntry) {
    logMessage(mcpServer, "info", `Using cached content for URL: ${url}`);
    const result = applyPaginationOptions(cachedEntry.markdownContent, paginationOptions);
    const duration = Date.now() - startTime;
    logMessage(mcpServer, "info", `Processed cached URL: ${url} (${result.length} chars in ${duration}ms)`);
    return result;
  }
  
  // Validate URL format
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    logMessage(mcpServer, "error", `Invalid URL format: ${url}`);
    throw createURLFormatError(url);
  }

  assertUrlAllowed(parsedUrl);

  // Create an AbortController instance
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // Prepare request options with proxy support
    const requestOptions: RequestInit = {
      signal: controller.signal,
    };

    // Add proxy or default dispatcher (includes system CA certs for TLS)
    const proxyAgent = createProxyAgent(url, ProxyType.URL_READER);
    const dispatcher = proxyAgent ?? createDefaultAgent();
    if (dispatcher) {
      (requestOptions as any).dispatcher = dispatcher;
    }

    // Add User-Agent header if configured (URL_READER_USER_AGENT takes priority over USER_AGENT)
    const userAgent = process.env.URL_READER_USER_AGENT || process.env.USER_AGENT;
    if (userAgent) {
      requestOptions.headers = {
        ...requestOptions.headers,
        'User-Agent': userAgent
      };
    }

    let response: Response;
    try {
      // Fetch the URL with the abort signal.
      // Use undici's own fetch so it shares the same internal version as the
      // Agent/ProxyAgent dispatcher — avoids the Node.js bundled-undici vs
      // npm-undici version mismatch that breaks Content-Encoding decompression.
      response = await (undiciFetch as unknown as typeof fetch)(url, requestOptions);
    } catch (error: any) {
      const context: ErrorContext = {
        url,
        proxyAgent: !!dispatcher,
        timeout: timeoutMs
      };
      throw createNetworkError(error, context);
    }

    if (!response.ok) {
      let responseBody: string;
      try {
        responseBody = await response.text();
      } catch {
        responseBody = '[Could not read response body]';
      }

      const context: ErrorContext = { url };
      throw createServerError(response.status, response.statusText, responseBody, context);
    }

    // Retrieve HTML content
    let htmlContent: string;
    try {
      htmlContent = await response.text();
    } catch (error: any) {
      throw createContentError(
        `Failed to read website content: ${error.message || 'Unknown error reading content'}`,
        url
      );
    }

    if (!htmlContent || htmlContent.trim().length === 0) {
      throw createContentError("Website returned empty content.", url);
    }

    // Extract metadata from raw HTML before readability strips <head>.
    let metadataBlock = "";
    if (paginationOptions.extractMetadata !== false) {
      try {
        const metadata = extractMetadata(htmlContent, url);
        metadataBlock = formatMetadataBlock(metadata);
      } catch (metaErr: any) {
        logMessage(mcpServer, "warning", `Metadata extraction failed for ${url}: ${metaErr.message}`);
      }
    }

    // Extract main content with Readability when enabled (default: on).
    // Falls back to full HTML on non-article pages (no content extracted).
    if (paginationOptions.extractMainContent !== false) {
      try {
        const extracted = extractMainContent(htmlContent, url);
        if (extracted) {
          htmlContent = extracted;
          logMessage(mcpServer, "info", `Readability extracted main content for: ${url}`);
        }
      } catch (readabilityErr: any) {
        logMessage(mcpServer, "warning", `Readability failed for ${url} (falling back to full HTML): ${readabilityErr.message}`);
      }
    }

    // Convert HTML to Markdown
    let markdownContent: string;
    try {
      markdownContent = NodeHtmlMarkdown.translate(htmlContent);
    } catch (error: any) {
      throw createConversionError(error, url, htmlContent);
    }

    if (!markdownContent || markdownContent.trim().length === 0) {
      logMessage(mcpServer, "warning", `Empty content after conversion: ${url}`);
      // DON'T cache empty/failed conversions - return warning directly
      return createEmptyContentWarning(url, htmlContent.length, htmlContent);
    }

    // Only cache successful markdown conversion (without metadata, which
    // is prepended at read time so pagination options still work on body).
    urlCache.set(url, htmlContent, markdownContent);

    // Apply pagination options
    const result = applyPaginationOptions(markdownContent, paginationOptions);

    // Prepend metadata block after pagination so startChar/maxLength
    // only apply to body content, not the metadata header.
    const finalResult = metadataBlock + result;

    const duration = Date.now() - startTime;
    logMessage(mcpServer, "info", `Successfully fetched and converted URL: ${url} (${finalResult.length} chars in ${duration}ms)`);
    return finalResult;
  } catch (error: any) {
    if (error.name === "AbortError") {
      logMessage(mcpServer, "error", `Timeout fetching URL: ${url} (${timeoutMs}ms)`);
      throw createTimeoutError(timeoutMs, url);
    }
    // Re-throw our enhanced errors
    if (error.name === 'MCPSearXNGError') {
      logMessage(mcpServer, "error", `Error fetching URL: ${url} - ${error.message}`);
      throw error;
    }
    
    // Catch any unexpected errors
    logMessage(mcpServer, "error", `Unexpected error fetching URL: ${url}`, error);
    const context: ErrorContext = { url };
    throw createUnexpectedError(error, context);
  } finally {
    // Clean up the timeout to prevent memory leaks
    clearTimeout(timeoutId);
  }
}
