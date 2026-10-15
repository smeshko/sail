// The page's one way to build HTML: the `html` tag escapes every interpolation unless it is the tag's own markup, and
// `safeHref` lets only an http(s) URL become a link. Run text is untrusted, and the page renders it with innerHTML on
// the API's own origin, so each case here is an attack a ticket title, an agent message or a log could carry.
import { expect, test } from 'bun:test';
import { escapeHtml, html, join, raw, SafeHtml, safeHref } from '../../../src/dashboard/page/html';

// biome-ignore format: TDD-PENDING TASK-001
test
  .skip // TDD-PENDING TASK-001
  ('html escapes every interpolation, as element text and inside either quote of an attribute', () => {
  expect(html`<p>${'<img src=x onerror=alert(1)>'}</p>`.value).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  expect(html`<a title="${`"'`}">`.value).toBe('<a title="&quot;&#39;">');
  expect(html`<a title='${"' onmouseover='x"}'>`.value).toBe("<a title='&#39; onmouseover=&#39;x'>");
  expect(html`${'&lt;b&gt; & </textarea><svg onload=1>'}`.value).toBe(
    '&amp;lt;b&amp;gt; &amp; &lt;/textarea&gt;&lt;svg onload=1&gt;',
  );
  const breakout = ['$', '{alert(1)}`); alert(2); (`'].join('');
  expect(html`<code>${breakout}</code>`.value).toBe(`<code>${breakout}</code>`);
  expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
});

// biome-ignore format: TDD-PENDING TASK-001
test
  .skip // TDD-PENDING TASK-001
  ('a nested html, an array of them, null, undefined and false interpolate as D5 says, and raw() is the only other way in', () => {
  const items = ['a<', 'b'].map((item) => html`<li>${item}</li>`);
  const rendered = html`<ul>${items}</ul>${null}${undefined}${false}${0}${raw('<i>✓</i>')}${'<i>'}`;
  expect(rendered).toBeInstanceOf(SafeHtml);
  expect(rendered.value).toBe('<ul><li>a&lt;</li><li>b</li></ul>0<i>✓</i>&lt;i&gt;');
  expect(String(html`<b>${[[html`<i>x</i>`, '&'], 1]}</b>`)).toBe('<b><i>x</i>&amp;1</b>');
  expect(join([html`<i>1</i>`, '<2>', null], html`<br>`).value).toBe('<i>1</i><br>&lt;2&gt;<br>');
});

// biome-ignore format: TDD-PENDING TASK-001
test
  .skip // TDD-PENDING TASK-001
  ('safeHref takes http and https URLs as given, and refuses every other scheme, a scheme-relative URL and a non-URL', () => {
  for (const url of ['https://example.com/x', 'http://127.0.0.1:3400/', 'HTTPS://example.com/a?b=1#c']) {
    expect(safeHref(url)).toBe(url);
  }
  const refused = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'fake://tickets/FAKE-1',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    '//evil.example',
    '/api/repos',
    'not a url',
    '',
    undefined,
  ];
  expect(refused.map(safeHref)).toEqual(refused.map(() => undefined));
});
