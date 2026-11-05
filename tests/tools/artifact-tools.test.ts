import { InMemoryArtifactStore } from "../../src/artifacts/index.js";
import { ArtifactReadTool, offloadLargeOutput } from "../../src/tools/artifact-tools.js";

describe("offloadLargeOutput + artifact_read", () => {
  it("keeps small outputs inline", () => {
    const store = new InMemoryArtifactStore();
    expect(offloadLargeOutput(store, "short", { tool: "t", threshold: 100 })).toEqual({ text: "short" });
    expect(store.count()).toBe(0);
  });

  it("stores a large output and leaves head/tail excerpts with a pointer", async () => {
    const store = new InMemoryArtifactStore();
    const full = Array.from(
      { length: 2_000 },
      (_, i) => `line ${i}${i === 1_500 ? " FAILED auth_spec.rb:48" : ""}`,
    ).join("\n");
    const res = offloadLargeOutput(store, full, { tool: "run_tests", threshold: 4_000, runId: "run_1" });
    expect(res.artifactId).toBeDefined();
    expect(res.text.length).toBeLessThan(4_000);
    expect(res.text).toContain("line 0");
    expect(res.text).toContain("line 1999");
    expect(res.text).toContain(`artifact_read({"artifact_id":"${res.artifactId}"`);
    expect(store.get(res.artifactId!)?.provenance.runId).toBe("run_1");

    const tool = new ArtifactReadTool(store);
    const hit = await tool.call({ artifact_id: res.artifactId, pattern: "failed" });
    expect(hit.matches).toEqual([{ line: 1501, text: "line 1500 FAILED auth_spec.rb:48" }]);
    const page = await tool.call({ artifact_id: res.artifactId, offset: 0, length: 10 });
    expect(page).toMatchObject({ content: "line 0\nlin", has_more: true, total_chars: full.length });
    expect((await tool.call({ artifact_id: "art_nope" })).error).toBe("NotFound");
  });
});
