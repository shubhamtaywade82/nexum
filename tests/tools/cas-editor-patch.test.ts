/**
 * apply_patch semantics: a hunk applies only where its old side matches the
 * file exactly. A mismatch is refused, never spliced at the declared line.
 */
import { applyUnifiedDiffToContent, PatchApplicationError } from "../../src/tools/mutations/cas-editor.js";

const patchOf = (...lines: string[]) => lines.join("\n") + "\n";

describe("applyUnifiedDiffToContent", () => {
  it("applies a clean single-hunk patch", () => {
    const out = applyUnifiedDiffToContent(
      "one\ntwo\nthree\n",
      patchOf("--- a/f", "+++ b/f", "@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"),
    );
    expect(out).toBe("one\nTWO\nthree\n");
  });

  it("applies multiple hunks whose line numbers drift", () => {
    const content = "a\nb\nc\nd\ne\nf\n";
    const out = applyUnifiedDiffToContent(
      content,
      patchOf("--- a/f", "+++ b/f", "@@ -1,2 +1,3 @@", " a", "+a2", " b", "@@ -4,3 +5,3 @@", " d", "-e", "+E", " f"),
    );
    expect(out).toBe("a\na2\nb\nc\nd\nE\nf\n");
  });

  it("refuses a hunk whose context is not in the file, rather than splicing it at the declared line", () => {
    const content = "alpha\nbeta\ngamma\n";
    expect(() =>
      applyUnifiedDiffToContent(content, patchOf("--- a/f", "+++ b/f", "@@ -2,1 +2,1 @@", "-delta", "+DELTA")),
    ).toThrow(PatchApplicationError);
  });

  it("refuses an ambiguous match that is equally near two locations", () => {
    // "v" occurs at indexes 1 and 3; the declared line 3 (index 2) is one line from each.
    expect(() =>
      applyUnifiedDiffToContent("k\nv\nk\nv\n", patchOf("--- a/f", "+++ b/f", "@@ -3,1 +3,1 @@", "-v", "+V")),
    ).toThrow(/more than one location/);
  });

  it("prefers the nearest of several matches", () => {
    const out = applyUnifiedDiffToContent(
      "v\nk\nv\nk\nv\n",
      patchOf("--- a/f", "+++ b/f", "@@ -5,1 +5,1 @@", "-v", "+V"),
    );
    expect(out).toBe("v\nk\nv\nk\nV\n");
  });

  it("treats a removed line that begins with '--' as body, not a file header", () => {
    const out = applyUnifiedDiffToContent(
      "-- note\nkeep\n",
      patchOf("--- a/q.sql", "+++ b/q.sql", "@@ -1,2 +1,1 @@", "--- note", " keep"),
    );
    expect(out).toBe("keep\n");
  });

  it("applies a pure insertion at its declared position", () => {
    const out = applyUnifiedDiffToContent("one\ntwo\n", patchOf("--- a/f", "+++ b/f", "@@ -1,0 +2,1 @@", "+inserted"));
    expect(out).toBe("one\ninserted\ntwo\n");
  });

  it("rejects a hunk whose body has more lines than its header declares", () => {
    expect(() =>
      applyUnifiedDiffToContent("one\n", patchOf("--- a/f", "+++ b/f", "@@ -1,1 +1,1 @@", "-one", "-two", "+ONE")),
    ).toThrow(/more lines than its header/);
  });

  it("rejects a body line after a hunk that the header does not cover, instead of dropping it", () => {
    expect(() =>
      applyUnifiedDiffToContent(
        "one\ntwo\n",
        patchOf("--- a/f", "+++ b/f", "@@ -1,1 +1,1 @@", "-one", "+ONE", "+sneaky"),
      ),
    ).toThrow(PatchApplicationError);
  });

  it("rejects a truncated hunk", () => {
    expect(() =>
      applyUnifiedDiffToContent("one\ntwo\n", patchOf("--- a/f", "+++ b/f", "@@ -1,2 +1,2 @@", "-one", "+ONE")),
    ).toThrow(/truncated/);
  });

  it("leaves the content unchanged when no hunks are present", () => {
    expect(() => applyUnifiedDiffToContent("one\n", "just prose\n")).toThrow(/no hunks/);
  });
});
