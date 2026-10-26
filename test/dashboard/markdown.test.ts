// A run's markdown as the drawer shows it: Bun's parse, with every element built by sail, so text is escaped, raw HTML
// is text, only an http(s) link is a link, and an image is never fetched.
import { expect, test } from 'bun:test';
import { renderMarkdown } from '../../src/dashboard/markdown';

test('headings, paragraphs, emphasis, lists, task items, quotes, rules, code and aligned tables render', () => {
  expect(
    renderMarkdown(
      '# Plan\n\n## Goal *now*\n\nSome **bold**, _em_, ~~gone~~ and `a<b`.\n\n3. three\n4. four\n\n- [ ] open\n- [x] done\n- plain\n\n> quoted\n\n---\n\n```ts\nconst a = 1 < 2;\n```\n\n| a | b |\n|:--|:-:|\n| 1 | 2 |\n',
    ),
  ).toBe(
    [
      '<h1>Plan</h1>',
      '<h2>Goal <em>now</em></h2>',
      '<p>Some <strong>bold</strong>, <em>em</em>, <del>gone</del> and <code>a&lt;b</code>.</p>',
      '<ol start="3"><li>three</li><li>four</li></ol>',
      '<ul><li class="task"><input type="checkbox" disabled> open</li><li class="task"><input type="checkbox" disabled checked> done</li><li>plain</li></ul>',
      '<blockquote><p>quoted</p>',
      '</blockquote><hr>',
      '<pre class="md-code" data-lang="ts"><code>const a = 1 &lt; 2;',
      '</code></pre>',
      '<table><thead><tr><th style="text-align:left">a</th><th style="text-align:center">b</th></tr></thead><tbody><tr><td style="text-align:left">1</td><td style="text-align:center">2</td></tr></tbody></table>',
      '',
    ].join('\n'),
  );
});

test('raw HTML is text, a script is never markup, only http(s) links are links, and an image is its alt and URL', () => {
  const out = renderMarkdown(
    '<script>alert(1)</script>\n\nHi <img src=x onerror=alert(1)> [js](javascript:alert(1)) [web](https://e.com/"x) ![pic](https://e.com/p.png) ```"q```\n\n```"><script>\nx\n```',
  );
  expect(out).not.toMatch(/<(script|img)\b/);
  expect(out).not.toContain('javascript:');
  expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(out).toContain('Hi &lt;img src=x onerror=alert(1)&gt; js ');
  expect(out).toContain('<a href="https://e.com/&quot;x" target="_blank" rel="noopener noreferrer">web</a>');
  expect(out).toContain('<span class="md-img">[pic · https://e.com/p.png]</span>');
  expect(out).toContain('<pre class="md-code" data-lang="&quot;&gt;&lt;script&gt;"><code>x');
});
