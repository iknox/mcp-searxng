import { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface SearXNGWebResult {
  title: string;
  content: string;
  url: string;
  score?: number;
  engine?: string;
  engines?: string[];
  category?: string;
  publishedDate?: string;
  thumbnail?: string;
  img_src?: string;
}

export interface SearXNGWebInfobox {
  infobox: string;
  content?: string;
  urls?: Array<{ title: string; url: string }>;
}

export interface SearXNGWeb {
  query: string;
  number_of_results: number;
  results: SearXNGWebResult[];
  sourceFormat?: "json" | "html";
  suggestions?: string[];
  corrections?: string[];
  answers?: string[];
  infoboxes?: SearXNGWebInfobox[];
  unresponsive_engines?: Array<[string, string]>;
}

const VALID_TIME_RANGES = ["day", "week", "month", "year"] as const;
const VALID_SAFESEARCH_VALUES = [0, 1, 2, "0", "1", "2"] as const;
const VALID_RESPONSE_FORMATS = ["text", "json"] as const;

export function isSearXNGWebSearchArgs(args: unknown): args is {
  query: string;
  pageno?: number;
  time_range?: string;
  language?: string;
  safesearch?: number | string;
  min_score?: number;
  num_results?: number;
  categories?: string;
  engines?: string;
  response_format?: "text" | "json";
} {
  if (
    typeof args !== "object" ||
    args === null ||
    !("query" in args) ||
    typeof (args as { query: string }).query !== "string"
  ) {
    return false;
  }

  const searchArgs = args as {
    pageno?: unknown;
    time_range?: unknown;
    language?: unknown;
    safesearch?: unknown;
    min_score?: unknown;
    num_results?: unknown;
    categories?: unknown;
    engines?: unknown;
    response_format?: unknown;
  };

  if (searchArgs.pageno !== undefined && (typeof searchArgs.pageno !== "number" || searchArgs.pageno < 1)) {
    return false;
  }
  if (
    searchArgs.time_range !== undefined &&
    (typeof searchArgs.time_range !== "string" || !VALID_TIME_RANGES.includes(searchArgs.time_range as any))
  ) {
    return false;
  }
  if (searchArgs.language !== undefined && typeof searchArgs.language !== "string") {
    return false;
  }
  if (
    searchArgs.safesearch !== undefined &&
    ((typeof searchArgs.safesearch !== "number" && typeof searchArgs.safesearch !== "string") ||
      !VALID_SAFESEARCH_VALUES.includes(searchArgs.safesearch as any))
  ) {
    return false;
  }
  if (
    searchArgs.min_score !== undefined &&
    (typeof searchArgs.min_score !== "number" ||
      Number.isNaN(searchArgs.min_score) ||
      searchArgs.min_score < 0 ||
      searchArgs.min_score > 1)
  ) {
    return false;
  }
  if (
    searchArgs.num_results !== undefined &&
    (typeof searchArgs.num_results !== "number" ||
      Number.isNaN(searchArgs.num_results) ||
      !Number.isInteger(searchArgs.num_results) ||
      searchArgs.num_results < 1 ||
      searchArgs.num_results > 20)
  ) {
    return false;
  }
  if (searchArgs.categories !== undefined && typeof searchArgs.categories !== "string") {
    return false;
  }
  if (searchArgs.engines !== undefined && typeof searchArgs.engines !== "string") {
    return false;
  }
  if (
    searchArgs.response_format !== undefined &&
    (typeof searchArgs.response_format !== "string" || !VALID_RESPONSE_FORMATS.includes(searchArgs.response_format as any))
  ) {
    return false;
  }

  return true;
}

export function isSearXNGSearchSuggestionsArgs(args: unknown): args is {
  query: string;
  language?: string;
} {
  if (
    typeof args !== "object" ||
    args === null ||
    !("query" in args) ||
    typeof (args as { query: string }).query !== "string"
  ) {
    return false;
  }

  const suggestionArgs = args as { language?: unknown };
  if (suggestionArgs.language !== undefined && typeof suggestionArgs.language !== "string") {
    return false;
  }

  return true;
}

export function isSearXNGInstanceInfoArgs(args: unknown): args is {
  includeEngines?: boolean;
  includeDisabled?: boolean;
  category?: string;
  refresh?: boolean;
} {
  if (typeof args !== "object" || args === null) {
    return false;
  }

  const infoArgs = args as {
    includeEngines?: unknown;
    includeDisabled?: unknown;
    category?: unknown;
    refresh?: unknown;
  };
  if (infoArgs.includeEngines !== undefined && typeof infoArgs.includeEngines !== "boolean") {
    return false;
  }
  if (infoArgs.includeDisabled !== undefined && typeof infoArgs.includeDisabled !== "boolean") {
    return false;
  }
  if (infoArgs.category !== undefined && typeof infoArgs.category !== "string") {
    return false;
  }
  if (infoArgs.refresh !== undefined && typeof infoArgs.refresh !== "boolean") {
    return false;
  }

  return true;
}

export const WEB_SEARCH_TOOL: Tool = {
  name: "searxng_web_search",
  description:
    "Searches the web using SearXNG and returns a list of results, each with a title, URL, and content snippet. " +
    "CRITICAL: The required parameter name is exactly `query` (not `prompt`, `q`, or any other name). " +
    "Calls an external SearXNG instance; availability depends on the `SEARXNG_URL` configuration. " +
    "Use `pageno` to paginate results; combine `time_range` and `language` to narrow scope. " +
    "To read the full text of a result URL, follow up with `web_url_read`.",
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
        description: "Time range of search (day, week, month, year)",
        enum: ["day", "week", "month", "year"],
      },
      language: {
        type: "string",
        description:
          "Language code for search results (e.g., 'en', 'fr', 'de'). Default is instance-dependent.",
        default: "all",
      },
      safesearch: {
        type: "string",
        description:
          "Safe search filter level (0: None, 1: Moderate, 2: Strict)",
        enum: ["0", "1", "2"],
      },
      min_score: {
        type: "number",
        description:
          "Minimum relevance score threshold from 0.0 to 1.0. Results below this score are filtered out.",
        minimum: 0,
        maximum: 1,
      },
      num_results: {
        type: "number",
        description:
          "Maximum number of results to return (1-20). Operator cap SEARXNG_MAX_RESULTS applies as a ceiling.",
        minimum: 1,
        maximum: 20,
      },
      categories: {
        type: "string",
        description:
          "Comma-separated SearXNG categories. Live /config capabilities are aggregated across reachable instances; prefer searxng_instance_info categories.common for consistent multi-instance results. Values in categories.available are best-effort and may only be honored by some instances. Known values are normalized case-insensitively; unknown values are forwarded trimmed so SearXNG can ignore or honor them. If /config is unavailable, values are forwarded as-is with a warning. If omitted, each instance uses its server-side default.",
      },
      engines: {
        type: "string",
        description:
          "Comma-separated SearXNG engine names to query (e.g. 'google,bing,ddg'). Live /config capabilities are aggregated across reachable instances; prefer searxng_instance_info engines.common.enabled for consistent multi-instance results. Values in engines.available.enabled are best-effort and may only be honored by some instances. Known values are normalized case-insensitively; unknown values are forwarded trimmed so SearXNG can ignore or honor them. If /config is unavailable, values are forwarded as-is with a warning. If omitted, each instance uses its server-side default.",
      },
      response_format: {
        type: "string",
        description: "Response format: formatted text for agents or raw JSON for programmatic clients. Default: text.",
        enum: ["text", "json"],
        default: "text",
      },
    },
    required: ["query"],
  },
};

export const SUGGESTIONS_TOOL: Tool = {
  name: "searxng_search_suggestions",
  description:
    "Returns autocomplete suggestions from the configured SearXNG instance. " +
    "Use this to refine vague or partial queries before searching.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Partial or complete query to autocomplete.",
      },
      language: {
        type: "string",
        description: "Language code for suggestions (e.g., 'en', 'fr', 'de') or 'all'. Default: all.",
        default: "all",
      },
    },
    required: ["query"],
  },
};

export const INSTANCE_INFO_TOOL: Tool = {
  name: "searxng_instance_info",
  description:
    "Discovers capabilities from all reachable configured SearXNG instances via /config, including categories.common/available, engines.common/available, defaults, locales, and plugins.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: "object",
    properties: {
      includeEngines: {
        type: "boolean",
        description: "Include enabled engine names in the response.",
        default: false,
      },
      includeDisabled: {
        type: "boolean",
        description: "Include disabled engine names when includeEngines is true.",
        default: false,
      },
      category: {
        type: "string",
        description: "Filter categories and engines to a single category name.",
      },
      refresh: {
        type: "boolean",
        description: "Bypass the process cache and fetch fresh /config data.",
        default: false,
      },
    },
    required: [],
  },
};

export const LITE_WEB_SEARCH_TOOL: Tool = {
  name: "searxng_web_search",
  description: "Web search. Returns titles, URLs, snippets.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Search query." } },
    required: ["query"],
  },
};

export const LITE_SUGGESTIONS_TOOL: Tool = {
  name: "searxng_search_suggestions",
  description: "Autocomplete search query suggestions.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Query prefix." } },
    required: ["query"],
  },
};

export const LITE_INSTANCE_INFO_TOOL: Tool = {
  name: "searxng_instance_info",
  description: "Discover SearXNG instance capabilities.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
};

export const LITE_READ_URL_TOOL: Tool = {
  name: "web_url_read",
  description:
    "Fetch URL. Converts HTML to markdown; returns explicit JSON, plain text, YAML, TOML, and XML as readable markdown; binary/media/archive downloads are rejected.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "URL to fetch." } },
    required: ["url"],
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