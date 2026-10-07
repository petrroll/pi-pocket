import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Auth } from "../src/server/auth.ts";
import { ConfigStore } from "../src/server/config.ts";

function setup(t: TestContext) {
    const directory = mkdtempSync(join(tmpdir(), "pi-pocket-auth-"));

    t.after(() => rmSync(directory, { recursive: true, force: true }));
    t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
    const config = new ConfigStore(directory);

    return { config, auth: new Auth(config), owner: config.userByToken(config.ownerToken)! };
}

test("invites still default to 15 minutes and expire at their deadline", (t) => {
    const { auth, owner } = setup(t);
    const invite = auth.createInvite(owner);

    assert.equal(invite.expiresAt, Date.now() + 15 * 60_000);
    t.mock.timers.setTime(invite.expiresAt - 1);
    assert.equal(auth.inviteValid(invite.code), true);
    t.mock.timers.setTime(invite.expiresAt);
    assert.equal(auth.inviteValid(invite.code), false);
    assert.equal(auth.redeem(invite.code, "Too late"), undefined);
});

test("each invite has its own lifetime, up to 7 days", (t) => {
    const { auth, owner } = setup(t);
    const minutes = [1, 15, 60, 1440, 10080];
    const invites = minutes.map((ttl) => auth.createInvite(owner, { role: "guest" }, ttl));
    const now = Date.now();

    for (const [index, invite] of invites.entries()) {
        assert.equal(invite.expiresAt, now + minutes[index]! * 60_000);
        t.mock.timers.setTime(invite.expiresAt - 1);
        assert.equal(auth.inviteValid(invite.code), true);
        t.mock.timers.setTime(invite.expiresAt);
        assert.equal(auth.redeem(invite.code, "Too late"), undefined);
    }
});

test("a longer invite works after 15 minutes, once, with its original role and scope", (t) => {
    const { auth, owner } = setup(t);
    const invite = auth.createInvite(owner, { role: "viewer", session: "42" }, 10080);

    t.mock.timers.setTime(invite.expiresAt - 1);
    assert.deepEqual(auth.invite(invite.code), { role: "viewer", session: "42" });
    const joined = auth.redeem(invite.code, "Alex");

    assert.equal(joined?.user.role, "viewer");
    assert.deepEqual(joined?.user.sessions, ["42"]);
    assert.equal(auth.inviteValid(invite.code), false);
    assert.equal(auth.redeem(invite.code, "Again"), undefined);
});

test("invalid lifetimes cannot create an unbounded invite", (t) => {
    const { auth, owner } = setup(t);

    for (const ttl of [0, -1, 1.5, 10081, NaN, Infinity, -Infinity, "60", null, true, {}, []]) {
        assert.throws(() => auth.createInvite(owner, { role: "guest" }, ttl), {
            status: 400,
            message: /Invite lifetime/,
        });
    }
});

test("longer invites still depend on their creator's access", (t) => {
    const { config, auth } = setup(t);

    for (const change of ["remove", "viewer", "scope"] as const) {
        const creator = config.addUser("Inviter", "guest").user;
        const invite = auth.createInvite(creator, { role: "guest" }, 10080);

        if (change === "remove") {
            config.removeUser(creator.id);
        } else {
            config.updateUser(
                creator.id,
                change === "viewer" ? { role: "viewer" } : { sessions: ["42"] },
            );
        }

        assert.equal(auth.redeem(invite.code, "Not allowed"), undefined);
    }
});
