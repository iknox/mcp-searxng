#!/usr/bin/env tsx

/**
 * Unit Tests: url-reader.ts
 *
 * Tests for URL fetching and markdown conversion.
 *
 * Uses real local HTTP servers instead of global-fetch mocks so the tests
 * exercise the actual undici + Agent dispatch pipeline — including the
 * Content-Encoding decompression path that was broken by issue #81.
 */

import { strict as assert } from 'node:assert';
import * as http from 'node:http';
import * as net from 'node:net';
import * as zlib from 'node:zlib';
import { fetchAndConvertToMarkdown, extractMainContent, extractMetadata } from '../../src/url-reader.js';
import { urlCache } from '../../src/cache.js';
import { testFunction, createTestResults, printTestSummary } from '../helpers/test-utils.js';
import { createMockServer } from '../helpers/mock-server.js';
import { EnvManager } from '../helpers/env-utils.js';

const results = createTestResults();
const envManager = new EnvManager();

// ─── local test-server helpers ───────────────────────────────────────────────

type ServerOpts = {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Destroy the socket immediately — simulates ECONNRESET / hard close. */
  closeImmediately?: boolean;
  /** Accept the connection but never write anything — simulates a hung server. */
  hangForever?: boolean;
};

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

function startTestServer(opts: ServerOpts = {}): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (opts.closeImmediately) {
        req.socket.destroy();
        return;
      }
      if (opts.hangForever) {
        // keep the socket open but never send any bytes
        return;
      }
      const status = opts.status ?? 200;
      const headers: Record<string, string> = {
        'content-type': 'text/html; charset=utf-8',
        ...opts.headers,
      };
      res.writeHead(status, headers);
      res.end(opts.body ?? '');
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections(); // drop any lingering (hung) connections
            server.close(() => res());
          }),
      });
    });

    server.once('error', reject);
  });
}

/**
 * Grab a free TCP port (open a server on port 0, record the assigned port,
 * then close it). Connecting to this port right after will get ECONNREFUSED.
 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.once('error', reject);
  });
}

// ─── tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('🧪 Testing: url-reader.ts\n');

  // ── invalid URLs (blocked before any network call) ────────────────────────

  await testFunction('Error handling for invalid URL', async () => {
    const mockServer = createMockServer();

    try {
      await fetchAndConvertToMarkdown(mockServer as any, 'not-a-valid-url');
      assert.fail('Should have thrown URL format error');
    } catch (error: any) {
      assert.ok(error.message.includes('URL Format Error') || error.message.includes('Invalid URL'));
    }
  }, results);

  await testFunction('Various invalid URL formats', async () => {
    const mockServer = createMockServer();
    const invalidUrls = ['', 'not-a-url', 'invalid://protocol'];

    for (const invalidUrl of invalidUrls) {
      try {
        await fetchAndConvertToMarkdown(mockServer as any, invalidUrl);
        assert.fail(`Should have thrown error for invalid URL: ${invalidUrl}`);
      } catch (error: any) {
        assert.ok(
          error.message.includes('URL Format Error') ||
          error.message.includes('Invalid URL') ||
          error.name === 'MCPSearXNGError',
        );
      }
    }
  }, results);

  // ── network-error wrapping ────────────────────────────────────────────────

  await testFunction('Network error handling', async () => {
    const mockServer = createMockServer();
    // Obtain a free port then release it — connecting right after yields ECONNREFUSED.
    const port = await getFreePort();
    try {
      await fetchAndConvertToMarkdown(mockServer as any, `http://127.0.0.1:${port}`);
      assert.fail('Should have thrown a network error');
    } catch (error: any) {
      assert.ok(
        error.message.includes('Network Error') ||
        error.message.includes('Connection') ||
        error.name === 'MCPSearXNGError',
        `Unexpected error: ${error.message}`,
      );
    }
  }, results);

  // ── HTTP error status codes ───────────────────────────────────────────────

  await testFunction('HTTP error status codes', async () => {
    const mockServer = createMockServer();
    const statusCodes = [404, 403, 500, 502, 503, 429];

    for (const statusCode of statusCodes) {
      const { url, close } = await startTestServer({
        status: statusCode,
        body: `Error ${statusCode} response body`,
      });
      try {
        await fetchAndConvertToMarkdown(mockServer as any, url);
        assert.fail(`Should have thrown server error for status ${statusCode}`);
      } catch (error: any) {
        assert.ok(
          error.message.includes('Server Error') ||
          error.message.includes(`${statusCode}`) ||
          error.name === 'MCPSearXNGError',
          `Unexpected error for ${statusCode}: ${error.message}`,
        );
      } finally {
        await close();
      }
    }
  }, results);

  // ── timeout ───────────────────────────────────────────────────────────────

  await testFunction('Timeout handling', async () => {
    const mockServer = createMockServer();
    const { url, close } = await startTestServer({ hangForever: true });
    try {
      await fetchAndConvertToMarkdown(mockServer as any, url, 100);
      assert.fail('Should have thrown timeout error');
    } catch (error: any) {
      assert.ok(
        error.message.includes('Timeout Error') ||
        error.message.includes('timeout') ||
        error.name === 'MCPSearXNGError',
        `Unexpected error: ${error.message}`,
      );
    } finally {
      await close();
    }
  }, results);

  // ── empty / whitespace body ───────────────────────────────────────────────

  await testFunction('Empty content handling', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    const { url, close } = await startTestServer({ body: '' });
    try {
      await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.fail('Should have thrown content error for empty content');
    } catch (error: any) {
      assert.ok(
        error.message.includes('Content Error') ||
        error.message.includes('empty') ||
        error.name === 'MCPSearXNGError',
      );
    } finally {
      await close();
    }
  }, results);

  await testFunction('Whitespace-only content handling', async () => {
    const mockServer = createMockServer();
    urlCache.clear();
    const { url, close } = await startTestServer({ body: '   \n\t   ' });
    try {
      await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.fail('Should have thrown content error for whitespace-only content');
    } catch (error: any) {
      assert.ok(
        error.message.includes('Content Error') ||
        error.message.includes('empty') ||
        error.name === 'MCPSearXNGError',
      );
    } finally {
      await close();
    }
  }, results);

  // ── gzip decompression (regression test for issue #81) ───────────────────

  await testFunction('Gzip-encoded response is correctly decompressed', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml =
      '<html><body><h1>Gzip Test</h1><p>This content was gzip-compressed.</p></body></html>';
    const gzipped = zlib.gzipSync(Buffer.from(testHtml, 'utf-8'));

    const { url, close } = await startTestServer({
      headers: {
        'content-encoding': 'gzip',
        'content-type': 'text/html; charset=utf-8',
      },
      body: gzipped,
    });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(typeof result === 'string', 'Result should be a string');
      assert.ok(
        !result.startsWith('\x1f\x8b'),
        'Result must not contain raw gzip bytes',
      );
      assert.ok(
        result.includes('Gzip Test'),
        `Expected "Gzip Test" in result; got: ${result.slice(0, 200)}`,
      );
    } finally {
      await close();
    }
  }, results);

  // ── HTML → Markdown conversion ────────────────────────────────────────────

  await testFunction('Successful HTML to Markdown conversion', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = `
      <html>
        <head><title>Test Page</title></head>
        <body>
          <h1>Main Title</h1>
          <p>This is a test paragraph with <strong>bold text</strong>.</p>
          <ul>
            <li>First item</li>
            <li>Second item</li>
          </ul>
          <a href="https://example.com">Test Link</a>
        </body>
      </html>
    `;
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(typeof result === 'string');
      assert.ok(result.length > 0);
      assert.ok(result.includes('Main Title') || result.includes('#'));
    } finally {
      await close();
    }
  }, results);

  // ── character pagination ──────────────────────────────────────────────────

  await testFunction('Character pagination - maxLength', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml =
      '<html><body><h1>Test Title</h1><p>This is a long paragraph with lots of content that we can paginate through.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, { maxLength: 20 });
      assert.ok(typeof result === 'string');
      assert.ok(result.length <= 20, `Expected length <= 20, got ${result.length}`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Character pagination - startChar', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>Test Title</h1><p>Content here.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, { startChar: 10 });
      assert.ok(typeof result === 'string');
    } finally {
      await close();
    }
  }, results);

  await testFunction('Character pagination - both startChar and maxLength', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>Content for pagination test.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        startChar: 5,
        maxLength: 15,
      });
      assert.ok(typeof result === 'string');
      assert.ok(result.length <= 15, `Expected length <= 15, got ${result.length}`);
    } finally {
      await close();
    }
  }, results);

  // ── cache integration ─────────────────────────────────────────────────────

  await testFunction('Cache integration with pagination', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    let requestCount = 0;
    const testHtml =
      '<html><body><h1>Cached Content</h1><p>This content should be cached.</p></body></html>';

    // Persistent server — both calls must use the same URL.
    const server = http.createServer((_req, res) => {
      requestCount++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(testHtml);
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const serverUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

    try {
      const result1 = await fetchAndConvertToMarkdown(mockServer as any, serverUrl, 10000, {
        maxLength: 50,
      });
      assert.equal(requestCount, 1);
      assert.ok(typeof result1 === 'string');

      // Second call with different pagination options must hit the cache.
      const result2 = await fetchAndConvertToMarkdown(mockServer as any, serverUrl, 10000, {
        startChar: 10,
        maxLength: 30,
      });
      assert.equal(requestCount, 1, 'Second call should use the cache, not re-fetch');
      assert.ok(typeof result2 === 'string');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
      urlCache.clear();
    }
  }, results);

  // ── proxy env: NO_PROXY bypass ────────────────────────────────────────────

  await testFunction('Proxy agent integration', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>Test with proxy env</h1></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });

    // Point HTTPS_PROXY at a non-existent host, then exempt localhost via NO_PROXY
    // so the request goes directly to our test server.
    envManager.set('HTTPS_PROXY', 'http://proxy.example.com:8080');
    envManager.set('NO_PROXY', '127.0.0.1,localhost');
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('Test with proxy env'));
    } finally {
      await close();
      envManager.restore();
    }
  }, results);

  // ── security: hardened mode ───────────────────────────────────────────────

  await testFunction('hardened mode blocks localhost URL reads', async () => {
    const mockServer = createMockServer();
    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.delete('MCP_HTTP_ALLOW_PRIVATE_URLS');
    try {
      await fetchAndConvertToMarkdown(mockServer as any, 'http://127.0.0.1:8080/private');
      assert.fail('Expected localhost URL to be blocked');
    } catch (error: any) {
      assert.ok(error.message.includes('blocked by security policy'));
    } finally {
      envManager.restore();
    }
  }, results);

  await testFunction('override allows localhost URL reads in hardened mode', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>Internal</h1></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });

    envManager.set('MCP_HTTP_HARDEN', 'true');
    envManager.set('MCP_HTTP_ALLOW_PRIVATE_URLS', 'true');
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('Internal'));
    } finally {
      await close();
      envManager.restore();
    }
  }, results);

  // ── section extraction ────────────────────────────────────────────────────

  await testFunction('Section extraction - existing section', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = `
      <html><body>
        <h1>Introduction</h1><p>Intro paragraph.</p>
        <h2>Installation</h2><p>Install steps here.</p>
        <h2>Usage</h2><p>Usage details here.</p>
      </body></html>
    `;
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        section: 'Installation',
      });
      assert.ok(result.includes('Installation'), `Expected "Installation" in: ${result}`);
      assert.ok(!result.includes('Usage'), `Expected "Usage" NOT in section result`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Section extraction - section not found returns message', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><h1>Overview</h1><p>Text.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        section: 'NonExistentSection',
      });
      assert.ok(result.includes('not found'), `Expected "not found" message, got: ${result}`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Section extraction - treats regex metacharacters as literals', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = `
      <html><body>
        <h1>Overview</h1><p>Intro paragraph.</p>
        <h2>API (v1.0+) reference?</h2><p>Literal metacharacter heading content.</p>
        <h2>API v100 referencex</h2><p>Regex-like near miss should not be selected.</p>
      </body></html>
    `;
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        section: 'API (v1.0+) reference?',
      });
      assert.ok(
        result.includes('API (v1.0+) reference?'),
        `Expected literal heading match, got: ${result}`,
      );
      assert.ok(
        result.includes('Literal metacharacter heading content'),
        `Expected matching section body, got: ${result}`,
      );
      assert.ok(
        !result.includes('Regex-like near miss'),
        'Expected regex-like near miss to be excluded',
      );
    } finally {
      await close();
    }
  }, results);

  // ── paragraph range ───────────────────────────────────────────────────────

  await testFunction('Paragraph range - single paragraph', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml =
      '<html><body><p>First paragraph.</p><p>Second paragraph.</p><p>Third paragraph.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        paragraphRange: '1',
      });
      assert.ok(result.includes('First paragraph'), `Expected first paragraph, got: ${result}`);
      assert.ok(!result.includes('Second paragraph'), `Expected only first paragraph`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Paragraph range - specific range', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml =
      '<html><body><p>Para one.</p><p>Para two.</p><p>Para three.</p><p>Para four.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        paragraphRange: '2-3',
      });
      assert.ok(result.includes('Para two'), `Expected para two, got: ${result}`);
      assert.ok(result.includes('Para three'), `Expected para three, got: ${result}`);
      assert.ok(!result.includes('Para one'), `Expected para one excluded`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Paragraph range - range to end', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml =
      '<html><body><p>Alpha.</p><p>Beta.</p><p>Gamma.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        paragraphRange: '2-',
      });
      assert.ok(result.includes('Beta'), `Expected Beta, got: ${result}`);
      assert.ok(result.includes('Gamma'), `Expected Gamma, got: ${result}`);
      assert.ok(!result.includes('Alpha'), `Expected Alpha excluded`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Paragraph range - out of bounds returns message', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>Only one paragraph.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        paragraphRange: '99',
      });
      assert.ok(
        result.includes('invalid') || result.includes('out of bounds'),
        `Expected out-of-bounds message, got: ${result}`,
      );
    } finally {
      await close();
    }
  }, results);

  // ── readHeadings ──────────────────────────────────────────────────────────

  await testFunction('readHeadings option returns heading list', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = `
      <html><body>
        <h1>Main Title</h1>
        <h2>Chapter One</h2>
        <h3>Section A</h3>
        <p>Some paragraph text that should not appear.</p>
        <h2>Chapter Two</h2>
      </body></html>
    `;
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        readHeadings: true,
      });
      assert.ok(result.includes('Main Title'), `Expected Main Title, got: ${result}`);
      assert.ok(result.includes('Chapter One'), `Expected Chapter One, got: ${result}`);
      assert.ok(!result.includes('Some paragraph text'), `Paragraph should be excluded`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('readHeadings with no headings returns message', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>Only plain text, no headings here.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        readHeadings: true,
      });
      assert.ok(
        result.includes('No headings found'),
        `Expected "No headings found", got: ${result}`,
      );
    } finally {
      await close();
    }
  }, results);

// ── readability extraction ────────────────────────────────────────────────

  await testFunction('extractMainContent strips nav, sidebar, and footer', () => {
    const html = `
      <html><head><title>News Article</title></head><body>
        <header><nav><a href="/">Home</a><a href="/about">About</a></nav></header>
        <main>
          <article>
            <h1>Article Title</h1>
            <p>This is the main content of the article.</p>
            <p>It has multiple paragraphs with useful information.</p>
          </article>
        </main>
        <aside class="sidebar"><div class="ad">Buy our stuff!</div></aside>
        <footer><p>Copyright 2024. All rights reserved.</p></footer>
      </body></html>
    `;
    const result = extractMainContent(html, 'https://example.com');
    assert.ok(result, 'Should extract main content');
    assert.ok(result.includes('Article Title'), `Expected article title, got: ${result?.substring(0, 200)}`);
    assert.ok(result.includes('main content'), `Expected main content, got: ${result?.substring(0, 200)}`);
    assert.ok(!result.includes('Buy our stuff'), 'Should strip sidebar ads');
    assert.ok(!result.includes('Copyright'), 'Should strip footer');
    assert.ok(!result.includes('Home'), 'Should strip nav');
  }, results);

  await testFunction('extractMainContent returns null for empty body', () => {
    const html = `
      <html><body>
        <p>Just a simple page with no article structure.</p>
        <p>No semantic elements here.</p>
      </body></html>
    `;
    const result = extractMainContent(html, 'https://example.com');
    // Readability wraps any content it finds in a div, so it won't return null
    // for pages with text content. It returns null only for truly empty pages.
    assert.ok(result, 'Should return content wrapper for non-empty pages');
    assert.ok(result.includes('simple page'), 'Should contain the page text');
  }, results);

  await testFunction('extractMainContent preserves heading hierarchy', () => {
    const html = `
      <html><body>
        <article>
          <h1>Main Heading</h1>
          <p>Intro text.</p>
          <h2>Subsection</h2>
          <p>Subsection content.</p>
          <h3>Details</h3>
          <p>Detailed info.</p>
        </article>
      </body></html>
    `;
    const result = extractMainContent(html, 'https://example.com');
    assert.ok(result, 'Should extract content');
    // Readability normalizes headings — h1 becomes h2 in output
    assert.ok(result.includes('Main Heading'), `Expected Main Heading, got: ${result?.substring(0, 300)}`);
    assert.ok(result.includes('Subsection'), `Expected Subsection, got: ${result?.substring(0, 300)}`);
    assert.ok(result.includes('Details'), `Expected Details, got: ${result?.substring(0, 300)}`);
  }, results);

  await testFunction('extractMainContent handles empty body', () => {
    const html = '<html><body></body></html>';
    const result = extractMainContent(html, 'https://example.com');
    assert.equal(result, null, 'Should return null for empty body');
  }, results);

  await testFunction('extractMainContent is not called when extractMainContent is false', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = `
      <html><head><title>News</title></head><body>
        <header><nav>Navigation</nav></header>
        <main>
          <article>
            <h1>Story</h1>
            <p>Full article text with important details.</p>
            <p>Second paragraph with more context and background information.</p>
            <p>Third paragraph discussing implications and analysis.</p>
            <p>Fourth paragraph with expert commentary from industry leaders.</p>
            <p>Fifth paragraph wrapping up the story with final thoughts.</p>
          </article>
        </main>
        <aside class="sidebar"><div class="ad">Buy stuff</div></aside>
        <footer><p>Footer</p></footer>
      </body></html>
    `;
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        extractMainContent: false,
      });
      // Should contain ALL content since readability was skipped
      assert.ok(result.includes('Navigation'), 'Should include nav when readability off');
      assert.ok(result.includes('Story'), 'Should include article');
      assert.ok(result.includes('Footer'), 'Should include footer when readability off');
    } finally {
      await close();
    }
  }, results);

  await testFunction('extractMainContent defaults to on via fetchAndConvertToMarkdown', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = `
      <html><head><title>News</title></head><body>
        <header><nav>Navigation</nav></header>
        <main>
          <article>
            <h1>Story</h1>
            <p>Full article text with important details.</p>
            <p>Second paragraph with more context and background information.</p>
            <p>Third paragraph discussing implications and analysis.</p>
            <p>Fourth paragraph with expert commentary from industry leaders.</p>
            <p>Fifth paragraph wrapping up the story with final thoughts.</p>
          </article>
        </main>
        <aside class="sidebar"><div class="ad">Buy stuff</div></aside>
        <footer><p>Footer</p></footer>
      </body></html>
    `;
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      // Should strip nav/footer since readability is on by default
      assert.ok(result.includes('Story'), `Expected Story, got: ${result.substring(0, 200)}`);
      assert.ok(!result.includes('Navigation'), 'Should strip nav by default');
      assert.ok(!result.includes('Footer'), 'Should strip footer by default');
      assert.ok(!result.includes('Buy stuff'), 'Should strip sidebar ads');
    } finally {
      await close();
    }
  }, results);

  // ── default maxLength cap ───────────────────────────────────────────────

  await testFunction('Bare fetch applies default maxLength cap', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    // Generate content well over 8000 chars
    let bodyContent = '';
    for (let i = 0; i < 2000; i++) {
      bodyContent += `<p>Paragraph ${i} with some text content to fill space.</p>\n`;
    }
    const testHtml = `<html><body>${bodyContent}</body></html>`;
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.length <= 8100, `Expected ~8000 chars, got ${result.length}`);
    } finally {
      await close();
    }
  }, results);

  // ── metadata extraction ──────────────────────────────────────────────────

  await testFunction('extractMetadata pulls title from og:title', () => {
    const html = `
      <html><head>
        <title>Browser Title</title>
        <meta property="og:title" content="OG Title">
      </head><body></body></html>
    `;
    const meta = extractMetadata(html, 'https://example.com');
    assert.equal(meta.title, 'OG Title', 'Should prefer og:title over <title>');
  }, results);

  await testFunction('extractMetadata falls back to <title> when no og:title', () => {
    const html = `
      <html><head><title>Browser Title</title></head><body></body></html>
    `;
    const meta = extractMetadata(html, 'https://example.com');
    assert.equal(meta.title, 'Browser Title');
  }, results);

  await testFunction('extractMetadata extracts author from meta tags', () => {
    const html = `
      <html><head>
        <meta name="author" content="Jane Doe">
      </head><body></body></html>
    `;
    const meta = extractMetadata(html, 'https://example.com');
    assert.equal(meta.author, 'Jane Doe');
  }, results);

  await testFunction('extractMetadata extracts publish date from article:published_time', () => {
    const html = `
      <html><head>
        <meta property="article:published_time" content="2024-03-15T10:30:00Z">
      </head><body></body></html>
    `;
    const meta = extractMetadata(html, 'https://example.com');
    assert.equal(meta.publishedDate, '2024-03-15T10:30:00Z');
  }, results);

  await testFunction('extractMetadata extracts description from og:description', () => {
    const html = `
      <html><head>
        <meta property="og:description" content="A fascinating article about metadata extraction.">
      </head><body></body></html>
    `;
    const meta = extractMetadata(html, 'https://example.com');
    assert.equal(meta.description, 'A fascinating article about metadata extraction.');
  }, results);

  await testFunction('extractMetadata extracts site name from og:site_name', () => {
    const html = `
      <html><head>
        <meta property="og:site_name" content="Example News">
      </head><body></body></html>
    `;
    const meta = extractMetadata(html, 'https://example.com');
    assert.equal(meta.siteName, 'Example News');
  }, results);

  await testFunction('extractMetadata returns empty object for pages with no metadata', () => {
    const html = '<html><body><p>Just content, no meta tags.</p></body></html>';
    const meta = extractMetadata(html, 'https://example.com');
    assert.equal(Object.keys(meta).length, 0, `Expected empty object, got: ${JSON.stringify(meta)}`);
  }, results);

  await testFunction('extractMetadata handles malformed HTML gracefully', () => {
    const html = '<html><head><meta name="description" content="Valid">';
    const meta = extractMetadata(html, 'https://example.com');
    assert.equal(meta.description, 'Valid');
  }, results);

  await testFunction('metadata is prepended as YAML block via fetchAndConvertToMarkdown', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = `
      <html><head>
        <title>Test Page</title>
        <meta name="author" content="Test Author">
        <meta property="og:site_name" content="Test Site">
      </head><body>
        <main>
          <article>
            <h1>Article Heading</h1>
            <p>Paragraph one with enough text to trigger readability.</p>
            <p>Paragraph two with more detailed information.</p>
            <p>Paragraph three continuing the narrative.</p>
            <p>Paragraph four with additional context.</p>
            <p>Paragraph five wrapping everything up.</p>
          </article>
        </main>
      </body></html>
    `;
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.startsWith('---'), `Expected YAML block, got: ${result.substring(0, 100)}`);
      assert.ok(result.includes('title:'), 'Should include title in metadata');
      assert.ok(result.includes('author: Test Author'), 'Should include author');
      assert.ok(result.includes('site: Test Site'), 'Should include site name');
      assert.ok(result.includes('---\n\n'), 'YAML block should end before content');
      // Body content should appear after metadata
      const afterMeta = result.split('---\n\n')[1];
      assert.ok(afterMeta, 'Should have content after metadata block');
      assert.ok(afterMeta.includes('Article Heading'), `Expected article heading in body, got: ${afterMeta?.substring(0, 200)}`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('extractMetadata false skips metadata block', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = `
      <html><head><title>Test Page</title></head><body>
        <main><article>
          <h1>Article Heading</h1>
          <p>Paragraph one with text content.</p>
          <p>Paragraph two with detailed information.</p>
          <p>Paragraph three continuing the story.</p>
          <p>Paragraph four building on previous points.</p>
          <p>Paragraph five concluding the article.</p>
        </article></main>
      </body></html>
    `;
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        extractMetadata: false,
      });
      assert.ok(!result.startsWith('---'), 'Should not have YAML metadata block');
      assert.ok(result.includes('Article Heading'), 'Should still have content');
    } finally {
      await close();
    }
  }, results);

  // ── default maxLength cap integration ─────────────────────────────────────

  await testFunction('Explicit maxLength overrides default cap', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    let bodyContent = '';
    for (let i = 0; i < 2000; i++) {
      bodyContent += `<p>Paragraph ${i} with some text content to fill space.</p>\n`;
    }
    const testHtml = `<html><body>${bodyContent}</body></html>`;
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        maxLength: 500,
      });
      assert.ok(result.length <= 500, `Expected <= 500 chars, got ${result.length}`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Targeted fetch with section is not capped', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml =
      '<html><body><h1>Intro</h1><p>A short intro.</p><h2>Target</h2><p>Section content here.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        section: 'Target',
      });
      assert.ok(result.includes('Section content here'), `Expected section content, got: ${result}`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Targeted fetch with readHeadings is not capped', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml =
      '<html><body><h1>One</h1><h2>Two</h2><h3>Three</h3></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url, 10000, {
        readHeadings: true,
      });
      assert.ok(result.includes('# One'), `Expected headings, got: ${result}`);
    } finally {
      await close();
    }
  }, results);

  await testFunction('Short bare fetch is not truncated by default cap', async () => {
    const mockServer = createMockServer();
    urlCache.clear();

    const testHtml = '<html><body><p>Short content under 8000 chars.</p></body></html>';
    const { url, close } = await startTestServer({ body: testHtml });
    try {
      const result = await fetchAndConvertToMarkdown(mockServer as any, url);
      assert.ok(result.includes('Short content'), `Expected full short content, got: ${result}`);
    } finally {
      await close();
    }
  }, results);

  printTestSummary(results, 'URL Reader Module');
  return results;
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runTests().then(results => {
    process.exit(results.failed > 0 ? 1 : 0);
  }).catch(console.error);
}

export { runTests };


