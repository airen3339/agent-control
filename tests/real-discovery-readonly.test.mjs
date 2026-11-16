import assert from "node:assert/strict";
import test from "node:test";
import { readAntigravityIndexedThreads } from "../src/providers/antigravity-history.mjs";
import { ClaudeSessionHistoryIndex } from "../src/providers/claude-history.mjs";
import { readIndexedThreads } from "../src/providers/codex-thread-index.mjs";
import {
  discoverAntigravityProfiles,
  discoverClaudeProfiles,
  discoverCodexProfiles,
} from "../src/providers/profile-discovery.mjs";

test("read-only local environment discovery safely inspects Codex, Claude, and Antigravity stores", async () => {
  const [codexProfiles, claudeProfiles, agyProfiles] = await Promise.all([
    discoverCodexProfiles(),
    discoverClaudeProfiles(),
    discoverAntigravityProfiles(),
  ]);

  assert.ok(codexProfiles.length >= 1);
  assert.ok(claudeProfiles.length >= 1);
  assert.ok(agyProfiles.length >= 1);

  for (const prof of codexProfiles) {
    const rows = readIndexedThreads(prof.home, { limit: 10 });
    if (rows !== null) {
      assert.ok(Array.isArray(rows));
    }
  }

  const claudeIndex = new ClaudeSessionHistoryIndex();
  for (const prof of claudeProfiles) {
    const rows = await claudeIndex.listSessions(prof.home, { limit: 10 });
    assert.ok(Array.isArray(rows));
  }

  for (const prof of agyProfiles) {
    const rows = readAntigravityIndexedThreads(prof.home, {
      profileType: prof.profileType || prof.id,
      limit: 10,
    });
    if (rows !== null) {
      assert.ok(Array.isArray(rows));
    }
  }
});
