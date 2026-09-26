/**
 * Artifacts plane — versioned, provenance-carrying outputs.
 *
 * See docs/guide/artifacts.md.
 */

export type {
  ArtifactKind,
  ArtifactReference,
  ArtifactProvenance,
  Artifact,
  ArtifactSaveInput,
  ArtifactQuery,
  ArtifactStore,
} from "./store.js";
export { InMemoryArtifactStore, SqliteArtifactStore, deriveArtifact, contentHash, newArtifactId } from "./store.js";
