import { marked } from "marked";
import type { Token as MarkedToken } from "marked";
import { highlight, supportsLanguage } from "cli-highlight";
import chalk from "chalk";
import { wrapText } from "./layout/truncate.js";

export interface Span {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  ansi?: boolean;
  color?: string;
  dimColor?: boolean;
  strikethrough?: boolean;
}

export interface FormattedLine {
  spans: Span[];
  indent?: number;
}

// Bounded LRU Cache for Code Block Highlighting
const CODE_CACHE = new Map<string, string[]>();
const MAX_CACHE_SIZE = 200;

export function highlightCodeBlock(code: string, lang?: string): string[] {
  const trimmedLang = lang?.trim().toLowerCase();
  const validLang = trimmedLang && supportsLanguage(trimmedLang) ? trimmedLang : undefined;
  const cacheKey = `${validLang || "none"}:${code}`;

  if (CODE_CACHE.has(cacheKey)) {
    return CODE_CACHE.get(cacheKey)!;
  }

  let result: string[];
  try {
    const highlighted = highlight(code, {
      language: validLang,
      ignoreIllegals: true,
    });
    result = highlighted.split("\n");
  } catch {
    result = code.split("\n");
  }

  if (CODE_CACHE.size >= MAX_CACHE_SIZE) {
    const firstKey = CODE_CACHE.keys().next().value;
    if (firstKey) CODE_CACHE.delete(firstKey);
  }
  CODE_CACHE.set(cacheKey, result);
  return result;
}

const INLINE_RE = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+)`)|(~~(.+?)~~)|(\[(.+?)\]\((.+?)\))/g;

export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) spans.push({ text: text.slice(last, m.index) });
    if (m[2]) spans.push({ text: m[2], bold: true });
    else if (m[4]) spans.push({ text: m[4], italic: true });
    else if (m[6]) spans.push({ text: m[6], code: true });
    else if (m[8]) spans.push({ text: m[8], strikethrough: true });
    else if (m[10] && m[11]) {
      spans.push({ text: m[10], bold: true });
      spans.push({ text: ` (${m[11]})`, color: "blue", dimColor: true });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last) });
  return spans;
}

export interface TableData {
  headers: string[];
  alignments: Array<"left" | "center" | "right">;
  rows: string[][];
}

export function renderTable(table: TableData, maxWidth: number): string[] {
  const numCols = table.headers.length;
  if (numCols === 0) return [];

  const minWidthPerCol = 4;
  const borderOverhead = numCols + 1;
  const availableWidth = Math.max(numCols * minWidthPerCol, maxWidth - borderOverhead);

  const contentWidths = new Array(numCols).fill(0);
  table.headers.forEach((h, i) => {
    contentWidths[i] = Math.max(contentWidths[i] || 0, h.length);
  });
  table.rows.forEach((row) => {
    row.forEach((cell, i) => {
      if (i < numCols) {
        contentWidths[i] = Math.max(contentWidths[i] || 0, (cell || "").length);
      }
    });
  });

  let totalRawWidth = contentWidths.reduce((a, b) => a + b, 0);
  if (totalRawWidth === 0) totalRawWidth = 1;

  const colWidths = contentWidths.map((w) => {
    const proportional = Math.floor((w / totalRawWidth) * availableWidth);
    return Math.max(minWidthPerCol, proportional);
  });

  const padCell = (text: string, width: number, align: "left" | "center" | "right") => {
    if (text.length > width) {
      return text.slice(0, Math.max(1, width - 1)) + "…";
    }
    const padTotal = width - text.length;
    if (align === "right") {
      return " ".repeat(padTotal) + text;
    }
    if (align === "center") {
      const left = Math.floor(padTotal / 2);
      const right = padTotal - left;
      return " ".repeat(left) + text + " ".repeat(right);
    }
    return text + " ".repeat(padTotal);
  };

  const topBorder = chalk.gray("┌" + colWidths.map((w) => "─".repeat(w + 2)).join("┬") + "┐");
  const headerRow =
    chalk.gray("│") +
    table.headers
      .map((h, i) => {
        const padded = padCell(h, colWidths[i], table.alignments[i]);
        return ` ${chalk.bold.cyan(padded)} ` + chalk.gray("│");
      })
      .join("");

  const midBorder = chalk.gray("├" + colWidths.map((w) => "─".repeat(w + 2)).join("┼") + "┤");

  const formattedRows = table.rows.map((row) => {
    return (
      chalk.gray("│") +
      colWidths
        .map((w, i) => {
          const cellText = row[i] || "";
          const padded = padCell(cellText, w, table.alignments[i]);
          return ` ${padded} ` + chalk.gray("│");
        })
        .join("")
    );
  });

  const bottomBorder = chalk.gray("└" + colWidths.map((w) => "─".repeat(w + 2)).join("┴") + "┘");

  return [topBorder, headerRow, midBorder, ...formattedRows, bottomBorder];
}

export function renderSimpleMarkdown(text: string, bodyWidth: number): FormattedLine[] {
  const width = Math.max(10, bodyWidth);
  const result: FormattedLine[] = [];

  let tokens: MarkedToken[];
  try {
    tokens = marked.lexer(text);
  } catch {
    for (const raw of text.split("\n")) {
      for (const line of wrapText(raw, width)) {
        result.push({ spans: parseInline(line) });
      }
    }
    return result;
  }

  for (const token of tokens) {
    switch (token.type) {
      case "code": {
        const lang = token.lang ? token.lang.trim() : "";
        const langLabel = lang ? ` ${lang} ` : " code ";
        const headerBar = chalk.gray(
          `┌──${chalk.bold.yellow(langLabel)}${"─".repeat(Math.max(0, width - 4 - langLabel.length))}┐`,
        );
        const footerBar = chalk.gray(`└${"─".repeat(Math.max(0, width - 2))}┘`);

        result.push({ spans: [{ text: headerBar, ansi: true }] });

        const highlighted = highlightCodeBlock(token.text, lang);
        for (const line of highlighted) {
          const borderLine = chalk.gray("│ ") + line;
          result.push({ spans: [{ text: borderLine, ansi: true }] });
        }

        result.push({ spans: [{ text: footerBar, ansi: true }] });
        break;
      }

      case "table": {
        const headers = (token.header || []).map((h: any) => (typeof h === "string" ? h : h.text || ""));
        const alignments: Array<"left" | "center" | "right"> = (token.align || []).map((a: any) =>
          a === "center" || a === "right" ? a : "left",
        );
        while (alignments.length < headers.length) alignments.push("left");

        const rows = (token.rows || []).map((row: any) =>
          row.map((cell: any) => (typeof cell === "string" ? cell : cell.text || "")),
        );

        const rendered = renderTable({ headers, alignments, rows }, width - 2);
        for (const line of rendered) {
          result.push({ spans: [{ text: line, ansi: true }], indent: 1 });
        }
        break;
      }

      case "heading": {
        const level = token.depth;
        const content = token.text;
        let prefix = "◈ ";
        let prefixColor = chalk.bold.cyan;

        if (level === 2) {
          prefix = "▸ ";
          prefixColor = chalk.bold.yellow;
        } else if (level === 3) {
          prefix = "• ";
          prefixColor = chalk.bold.green;
        } else if (level >= 4) {
          prefix = "◦ ";
          prefixColor = chalk.bold.magenta;
        }

        for (const line of wrapText(content, width - 4)) {
          result.push({
            spans: [{ text: prefixColor(prefix), ansi: true }, ...parseInline(line).map((s) => ({ ...s, bold: true }))],
          });
        }
        break;
      }

      case "list": {
        const isOrdered = token.ordered;
        (token.items || []).forEach((item: any, idx: number) => {
          let glyph = isOrdered ? chalk.cyan(`${idx + 1}. `) : chalk.cyan("• ");
          if (item.task) {
            glyph = item.checked ? chalk.green("✓ ") : chalk.gray("○ ");
          }

          const itemText = item.text.replace(/^\[[ xX]\]\s*/, "");
          const wrapped = wrapText(itemText, width - 4);
          wrapped.forEach((line) => {
            result.push({
              spans: [{ text: glyph, ansi: true }, ...parseInline(line)],
              indent: 2,
            });
          });
        });
        break;
      }

      case "blockquote": {
        const content = token.text;
        const quoteBar = chalk.gray("│ ");
        for (const line of wrapText(content, width - 4)) {
          result.push({
            spans: [
              { text: quoteBar, ansi: true },
              ...parseInline(line).map((s) => ({ ...s, italic: true, color: "gray" })),
            ],
            indent: 1,
          });
        }
        break;
      }

      case "hr": {
        const hrLine = chalk.gray("─".repeat(Math.max(1, width - 2)));
        result.push({ spans: [{ text: hrLine, ansi: true }] });
        break;
      }

      case "space": {
        result.push({ spans: [{ text: "" }] });
        break;
      }

      case "paragraph":
      default: {
        const textual = token as unknown as { text?: string; raw?: string };
        const rawContent = textual.text || textual.raw || "";
        for (const rawLine of rawContent.split("\n")) {
          if (!rawLine.trim()) {
            result.push({ spans: [{ text: "" }] });
          } else {
            for (const line of wrapText(rawLine, width)) {
              result.push({ spans: parseInline(line) });
            }
          }
        }
        break;
      }
    }
  }

  return result;
}
