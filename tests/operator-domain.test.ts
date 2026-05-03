import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isEligible } from "../src/operator/domain/eligibility.js";
import { mintId } from "../src/operator/domain/ids.js";
import { isReachable } from "../src/operator/domain/policy.js";
import { openOperatorDatabase } from "../src/operator/storage/database.js";
import { OperatorRepository } from "../src/operator/storage/repository.js";

describe("isEligible", () => {
  it("joined sees everything", () => {
    for (const type of [
      "session.invited",
      "session.joined",
      "session.message",
      "session.left",
      "session.ended",
    ]) {
      assert.equal(isEligible("joined", type), true, `joined should see ${type}`);
    }
  });

  it("invited sees only session.invited and session.ended", () => {
    assert.equal(isEligible("invited", "session.invited"), true);
    assert.equal(isEligible("invited", "session.ended"), true);
    assert.equal(isEligible("invited", "session.message"), false);
    assert.equal(isEligible("invited", "session.joined"), false);
    assert.equal(isEligible("invited", "session.left"), false);
  });

  it("left sees nothing", () => {
    for (const type of [
      "session.invited",
      "session.joined",
      "session.message",
      "session.left",
      "session.ended",
    ]) {
      assert.equal(isEligible("left", type), false, `left should not see ${type}`);
    }
  });
});

describe("mintId", () => {
  it("includes the prefix and produces 26-char ULID-style suffix", () => {
    const id = mintId("sess");
    assert.match(id, /^sess_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("two ids minted in close succession differ", () => {
    const a = mintId("evt");
    const b = mintId("evt");
    assert.notEqual(a, b);
  });

  it("ids minted later sort lexicographically after earlier ones", async () => {
    const a = mintId("msg");
    await new Promise((r) => setTimeout(r, 5));
    const b = mintId("msg");
    assert.ok(b > a, `expected ${b} > ${a}`);
  });
});

describe("isReachable", () => {
  function freshRepo(): { repo: OperatorRepository; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "robotnet-policy-"));
    const dbPath = path.join(dir, "operator.sqlite");
    const db = openOperatorDatabase(dbPath);
    const repo = new OperatorRepository(db);
    return {
      repo,
      cleanup: () => {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  it("an `open` target is reachable from anyone", () => {
    const { repo, cleanup } = freshRepo();
    try {
      repo.agents.register({
        handle: "@target.bot",
        bearerTokenHash: "h".repeat(64),
        inboundPolicy: "open",
      });
      assert.equal(isReachable(repo, "@anyone.bot", "@target.bot"), true);
      assert.equal(isReachable(repo, "@stranger.bot", "@target.bot"), true);
    } finally {
      cleanup();
    }
  });

  it("an `allowlist` target with a matching exact entry is reachable", () => {
    const { repo, cleanup } = freshRepo();
    try {
      repo.agents.register({
        handle: "@target.bot",
        bearerTokenHash: "h".repeat(64),
        inboundPolicy: "allowlist",
      });
      repo.agents.addAllowlistEntry("@target.bot", "@friend.bot");
      assert.equal(isReachable(repo, "@friend.bot", "@target.bot"), true);
      assert.equal(isReachable(repo, "@stranger.bot", "@target.bot"), false);
    } finally {
      cleanup();
    }
  });

  it("an owner glob matches any agent under that owner", () => {
    const { repo, cleanup } = freshRepo();
    try {
      repo.agents.register({
        handle: "@target.bot",
        bearerTokenHash: "h".repeat(64),
        inboundPolicy: "allowlist",
      });
      repo.agents.addAllowlistEntry("@target.bot", "@org.*");
      assert.equal(isReachable(repo, "@org.alpha", "@target.bot"), true);
      assert.equal(isReachable(repo, "@org.beta", "@target.bot"), true);
      assert.equal(isReachable(repo, "@other.alpha", "@target.bot"), false);
    } finally {
      cleanup();
    }
  });

  it("a missing target is unreachable", () => {
    const { repo, cleanup } = freshRepo();
    try {
      assert.equal(isReachable(repo, "@anyone.bot", "@missing.bot"), false);
    } finally {
      cleanup();
    }
  });
});
