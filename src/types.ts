import { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface SearXNGWeb {
  results: Array<{
    title: string;
    content: string;
    url: string;
    score: number;
  }>;
}

export function isSearXNGWebSearchArgs(args: unknown): args is {
  query: string;
  pageno?: number;
  time_range?: string;
  language?: string;
  safesearch?: number;
} {
  return (
    typeof args === "object" &&
    args !== null &&
    "query" in args &&
    typeof (args as { query: string }).query === "string"
  );
}

export const WEB_SEARCH_TOOL: Tool = {
  name: "searxng_web_search",
  description:
    "Searches the web using SearXNG. " +
    "CRITICAL: The parameter name MUST be exactly `query` (not `prompt`, `q`, or any other name). " +
    "Pass your search terms as the value of the `query` parameter.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The search query string. This is the required parameter name — use exactly `query`, not `prompt` or `q`.",
      },
      pageno: {
        type: "number",
        description: "Search page number (starts at 1)",
        default: 1,
      },
      time_range: {
        type: "string",
        description: "Time range of search (day, month, year)",
        enum: ["day", "month", "year"],
      },
      language: {
        type: "string",
        description:
          "Language code for search results (e.g., 'en', 'fr', 'de'). Default is instance-dependent.",
        default: "all",
      },
      safesearch: {
        type: "number",
        description:
          "Safe search filter level (0: None, 1: Moderate, 2: Strict)",
        enum: [0, 1, 2],
        default: 0,
      },
    },
    required: ["query"],
  },
};

export const READ_URL_TOOL: Tool = {
  name: "web_url_read",
  description:
    "PREFER A TWO-PASS APPROACH for pages that look large or have obvious structure: " +
    "first call with readHeadings=true (cheap, returns only the heading outline), " +
    "then call with section or paragraphRange to pull only the relevant parts. " +
    "This saves significant tokens on long pages. " +
    "Use a single full fetch only for short or unstructured pages. " +
    "By default, extracts the main article content using Mozilla Readability (strips navigation, sidebars, footers) " +
    "and prepends a YAML metadata block (title, author, publish date, description, site name). " +
    "Pages over 5MB are rejected early with a suggestion to use readHeadings or section instead.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "URL to fetch",
      },
      readHeadings: {
        type: "boolean",
        description:
          "Return ONLY the heading outline of the page (no body text). " +
          "Use this FIRST on any page with obvious section structure " +
          "to identify which sections are relevant before fetching full content. " +
          "Extremely cheap — headings are typically under 500 characters.",
      },
      section: {
        type: "string",
        description:
          "Return only the content under a specific heading. " +
          "Call readHeadings first to find the exact heading text, " +
          "then pass that heading here to pull just that section.",
      },
      paragraphRange: {
        type: "string",
        description:
          "Return only specific paragraphs by number (e.g., '1-3' for the first three, " +
          "'5' for just the fifth, '10-' for paragraph 10 onward). " +
          "Use after skimming headings or when you only need the lede.",
      },
      startChar: {
        type: "number",
        description:
          "Zero-based character offset to start reading from. " +
          "Use maxLength instead unless you need to resume a previous partial read.",
        minimum: 0,
      },
      maxLength: {
        type: "number",
description:
          "Maximum characters to return. " +
          "Defaults to 8000 on bare full-page fetches to avoid token waste. " +
          "Set explicitly for larger or smaller limits. " +
          "Combine with startChar to paginate through very long content.",
        minimum: 1,
      },
      extractMainContent: {
        type: "boolean",
        description: "Use Mozilla Readability to extract the main article content, stripping navigation, sidebars, and other chrome. Defaults to true. Set to false to fetch the full page.",
      },
      extractMetadata: {
        type: "boolean",
        description: "Extract page metadata (title, author, publish date, description, site name) from meta tags and prepend it as a YAML block. Defaults to true. Set to false to skip metadata extraction.",
      },
    },
    required: ["url"],
  },
};