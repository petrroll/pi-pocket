// Viewers can read/download; steering is required to upload or delete. Session and private-data checks apply.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    owner as ownerUser,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    readFileSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer, request as rawRequest, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let base: string;
let id: ConversationId;
let other: ConversationId;
let owner: string;
let guest: string;
let viewer: string;
let scoped: string;
let elsewhere: string;

before(async () => {
    app = await openApp(scriptedModel());
    id = await newSession(app);
    other = await newSession(app);
    owner = app.config.ownerToken;
    guest = app.config.addUser("Guest", "guest").token;
    viewer = app.config.addUser("Viewer", "viewer").token;
    scoped = app.config.addUser("One session", "guest", [String(id)]).token;
    elsewhere = app.config.addUser("Elsewhere", "guest", [String(other)]).token;
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const headers = (token: string) => ({ authorization: `Bearer ${token}`, "x-pocket": "1" });
const upload = (
    name: string,
    body: string | Uint8Array<ArrayBuffer>,
    token = owner,
    directory = work,
    session = id,
) =>
    fetch(`${base}/api/c/${session}/upload?${new URLSearchParams({ name, directory })}`, {
        method: "POST",
        headers: headers(token),
        body,
    });
const download = (path: string, token = owner, session = id) =>
    fetch(`${base}/api/c/${session}/download?${new URLSearchParams({ path })}`, {
        headers: headers(token),
    });

test("named uploads go into the chosen folder; downloads preserve binary, Unicode and empty files", async () => {
    const directory = join(work, "nested");
    const bytes = Buffer.alloc(1024 * 1024);
    const name = 'žluťoučký #".bin';

    mkdirSync(directory);

    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = index % 256;
    }

    const written = await upload(name, bytes, scoped, directory);

    assert.equal(written.status, 200);
    assert.equal(((await written.json()) as { path: string }).path, join(directory, name));
    assert.deepEqual(readFileSync(join(directory, name)), bytes);

    if (process.platform !== "win32") {
        assert.equal(statSync(join(directory, name)).mode & 0o777, 0o666 & ~process.umask());
    }

    const saved = await download(join(directory, name), scoped);

    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get("content-type"), "application/octet-stream");
    assert.equal(saved.headers.get("content-length"), String(bytes.length));
    assert.match(
        saved.headers.get("content-disposition") ?? "",
        /attachment;.*filename\*=UTF-8''%C5/,
    );
    assert.equal(saved.headers.get("x-content-type-options"), "nosniff");
    assert.equal(saved.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await saved.arrayBuffer()), bytes);
    assert.equal((await upload("empty", "")).status, 200);
    assert.equal((await (await download("empty")).arrayBuffer()).byteLength, 0);
});

test("downloads return the whole file, not the viewer's truncated text", async () => {
    const text = "line of text\n".repeat(100_000);

    assert.equal((await upload("large.txt", text)).status, 200);
    const view = await fetch(`${base}/api/c/${id}/view?path=large.txt`, {
        headers: headers(guest),
    });

    assert.equal(((await view.json()) as { truncated: boolean }).truncated, true);
    assert.equal(await (await download("large.txt", guest)).text(), text);
});

test(
    "unreadable downloads fail before sending attachment headers",
    {
        skip: process.platform === "win32" || process.getuid?.() === 0,
    },
    async () => {
        const file = join(work, "unreadable");

        writeFileSync(file, "private");
        chmodSync(file, 0);

        try {
            const response = await download("unreadable");

            assert.equal(response.status, 403);
            assert.equal(response.headers.get("content-disposition"), null);
            assert.match(response.headers.get("content-type") ?? "", /application\/json/);
        } finally {
            chmodSync(file, 0o600);
        }
    },
);

test("viewers can browse and download, but cannot upload; writes require X-Pocket", async () => {
    assert.equal((await upload("viewer.txt", "no", viewer)).status, 403);
    assert.equal((await download("empty", viewer)).status, 200);
    const view = (path: string) =>
        fetch(`${base}/api/c/${id}/view?${new URLSearchParams({ path })}`, {
            headers: headers(viewer),
        });

    assert.equal((await view(".")).status, 200);
    assert.equal((await view("large.txt")).status, 200);
    assert.equal((await download(join(root, "agent", "auth.json"), viewer)).status, 404);
    assert.equal((await fetch(`${base}/api/c/${id}/download?path=empty`)).status, 401);
    assert.equal(
        (
            await fetch(`${base}/api/c/${id}/upload?directory=.&name=no-header`, {
                method: "POST",
                headers: { authorization: `Bearer ${owner}` },
                body: "no",
            })
        ).status,
        403,
    );
    assert.equal(existsSync(join(work, "viewer.txt")), false);
    assert.equal(existsSync(join(work, "no-header")), false);
    assert.equal(
        (
            await fetch(`${base}/api/c/${id}/download?path=empty`, {
                headers: { cookie: `pocket_auth=${guest}` },
            })
        ).status,
        200,
        "browser downloads authenticate with the sign-in cookie",
    );
});

test("single-session guests cannot transfer through another session or outside their folder", async () => {
    const outside = join(root, "outside");

    mkdirSync(outside);
    writeFileSync(join(outside, "secret"), "private");
    symlinkSync(outside, join(work, "escape"));
    assert.equal((await upload("no", "data", elsewhere)).status, 404);
    assert.equal((await download("empty", elsewhere)).status, 404);
    assert.equal((await upload("no", "data", scoped, work, other)).status, 404);
    assert.equal((await download("empty", scoped, other)).status, 404);

    for (const folder of [outside, "../outside", "escape"]) {
        assert.equal((await upload("no", "data", scoped, folder)).status, 404);
        assert.equal((await download(`${folder}/secret`, scoped)).status, 404);
    }

    assert.equal(existsSync(join(outside, "no")), false);
    symlinkSync(join(work, "nested"), join(work, "inside"));
    assert.equal((await upload("via-link", "yes", scoped, "inside")).status, 200);
    assert.equal(await (await download("inside/via-link", scoped)).text(), "yes");
});

test("Pi's and Pocket's private data remain owner-only", async () => {
    for (const directory of [join(root, "agent"), app.dataDir]) {
        writeFileSync(join(directory, "secret.txt"), "private");
        assert.equal((await download(join(directory, "secret.txt"), guest)).status, 404);
        assert.equal((await upload("forbidden", "no", guest, directory)).status, 404);
        assert.equal(existsSync(join(directory, "forbidden")), false);
        assert.equal(await (await download(join(directory, "secret.txt"))).text(), "private");
    }
});

test("invalid names, existing files and dangling symlinks cannot overwrite or escape", async () => {
    for (const name of ["", " ", ".", "..", "../escape", "/absolute", "a/b", "a\\b", "a\0b"]) {
        assert.equal((await upload(name, "no")).status, 400, name);
    }

    writeFileSync(join(work, "keep"), "original");
    symlinkSync(join(work, "missing"), join(work, "dangling"));

    for (const name of ["keep", "dangling", "nested"]) {
        assert.equal((await upload(name, "replacement")).status, 409, name);
    }

    assert.equal(readFileSync(join(work, "keep"), "utf8"), "original");
    assert.equal(existsSync(join(work, "missing")), false);
    assert.equal((await upload("no", "data", owner, "keep")).status, 400);
    assert.equal((await upload("no", "data", owner, "missing-folder")).status, 404);
    assert.equal((await download("nested")).status, 400);
    assert.equal((await download("missing-file")).status, 404);

    if (process.platform !== "win32") {
        execFileSync("mkfifo", [join(work, "pipe")]);
        assert.equal((await download("pipe")).status, 400);
    }
});

test("interrupted uploads are removed and declared oversized files are refused before creation", async () => {
    const target = join(work, "cut.bin");
    const address = `${base}/api/c/${id}/upload?directory=.&name=cut.bin`;
    const cut = rawRequest(address, {
        method: "POST",
        headers: { ...headers(owner), "content-length": "1000000" },
    });

    cut.on("error", () => {});
    cut.write(Buffer.alloc(1000));
    await until(() => existsSync(target), "the partial upload");
    cut.destroy();
    await until(() => !existsSync(target), "partial upload cleanup");
    assert.equal((await upload("cut.bin", "retry")).status, 200);
    const status = await new Promise<number>((resolve) => {
        const huge = rawRequest(`${base}/api/c/${id}/upload?directory=.&name=huge.bin`, {
            method: "POST",
            headers: { ...headers(owner), "content-length": String(101 * 1024 * 1024) },
        });

        huge.on("response", (response) => {
            response.resume();
            response.on("end", () => {
                resolve(response.statusCode ?? 0);
                huge.destroy();
            });
        });
        huge.on("error", () => resolve(-1));
        huge.write("x");
    });

    assert.equal(status, 413);
    assert.equal(existsSync(join(work, "huge.bin")), false);
});

test("viewers cannot enumerate upload stashes or download outside their shared folder", async () => {
    const uploads = app.workspace.uploadDirectory(id);
    const homeSession = await newSession(app, root);
    const onlyThis = app.config.addUser("Scoped viewer", "viewer", [String(id)]).token;

    writeFileSync(join(uploads, "known.txt"), "known attachment");
    assert.equal(
        await (await download(join(uploads, "known.txt"), viewer)).text(),
        "known attachment",
    );

    for (const session of [id, homeSession]) {
        const response = await fetch(
            `${base}/api/c/${session}/view?${new URLSearchParams({ path: uploads })}`,
            { headers: headers(viewer) },
        );

        assert.equal(response.status, 404);
    }

    assert.equal((await download("empty", onlyThis, other)).status, 404);
    assert.equal((await download("../outside/secret", viewer)).status, 404);
    assert.equal((await download("escape/secret", viewer)).status, 404);
});

test("owners and steerers delete files and empty folders, never roots or nonempty folders", async () => {
    const remove = (path: string, token = owner, session = id) =>
        fetch(`${base}/api/c/${session}/file?${new URLSearchParams({ path })}`, {
            method: "DELETE",
            headers: headers(token),
        });

    for (const token of [owner, guest, scoped]) {
        writeFileSync(join(work, "delete-me"), "data");
        assert.equal((await remove("delete-me", token)).status, 200);
        assert.equal(existsSync(join(work, "delete-me")), false);
    }

    mkdirSync(join(work, "empty-dir"));
    assert.equal((await remove("empty-dir", guest)).status, 200);
    assert.equal((await remove(".")).status, 403);
    assert.equal((await remove("nested")).status, 409);
    assert.equal((await remove("missing")).status, 404);
    writeFileSync(join(work, "protected"), "keep");
    assert.equal((await remove("protected", viewer)).status, 403);
    assert.equal((await remove("protected", elsewhere)).status, 404);
    assert.equal(
        (
            await fetch(`${base}/api/c/${id}/file?path=protected`, {
                method: "DELETE",
                headers: { authorization: `Bearer ${owner}` },
            })
        ).status,
        403,
    );
    assert.equal(
        (await fetch(`${base}/api/c/${id}/file?path=protected`, { method: "DELETE" })).status,
        401,
    );
    assert.equal((await remove("../outside/secret")).status, 403);
    assert.equal((await remove("escape/secret")).status, 403);
    assert.equal(
        (await remove("escape", scoped)).status,
        200,
        "unlink the leaf, never its escaped target",
    );
    assert.equal(readFileSync(join(root, "outside", "secret"), "utf8"), "private");
    assert.equal(readFileSync(join(work, "protected"), "utf8"), "keep");
    const entries = await app.transcripts.allEntries(id, false);

    assert.ok(
        entries.some((entry) => entry.kind === "note"),
        "Pi is told about deletions",
    );
});

test("deletion waits while Pi is working", async (t) => {
    writeFileSync(join(work, "busy-file"), "keep");
    t.mock.method(app, "isBusy", () => true);
    const response = await fetch(`${base}/api/c/${id}/file?path=busy-file`, {
        method: "DELETE",
        headers: headers(owner),
    });

    assert.equal(response.status, 409);
    assert.equal(readFileSync(join(work, "busy-file"), "utf8"), "keep");
});

test("deletion follows take-turns rules and paths preserve filename whitespace", async () => {
    writeFileSync(join(work, "name.txt"), "keep");
    assert.equal((await upload("name.txt ", "space")).status, 200);
    assert.equal(await (await download("name.txt ")).text(), "space");
    await app.collab.turns(id, ownerUser(app), { action: "on" });

    try {
        const refused = await fetch(`${base}/api/c/${id}/file?path=name.txt`, {
            method: "DELETE",
            headers: headers(guest),
        });

        assert.equal(refused.status, 409);
        assert.match(await refused.text(), /driving|take the wheel/);
    } finally {
        await app.collab.turns(id, ownerUser(app), { action: "off" });
    }

    const removed = await fetch(
        `${base}/api/c/${id}/file?${new URLSearchParams({ path: "name.txt " })}`,
        { method: "DELETE", headers: headers(owner) },
    );

    assert.equal(removed.status, 200);
    assert.equal(existsSync(join(work, "name.txt ")), false);
    assert.equal(readFileSync(join(work, "name.txt"), "utf8"), "keep");
});

test("message attachments keep their existing unique-name storage", async () => {
    const send = () =>
        fetch(`${base}/api/c/${id}/upload?name=attachment.txt`, {
            method: "POST",
            headers: headers(guest),
            body: "attachment",
        }).then((response) => response.json() as Promise<{ path: string }>);
    const first = await send();
    const second = await send();

    assert.notEqual(first.path, second.path);
    assert.ok(first.path.startsWith(app.workspace.uploadDirectory(id)));
    assert.equal(readFileSync(first.path, "utf8"), "attachment");
    assert.equal(existsSync(join(work, "attachment.txt")), false);

    if (process.platform !== "win32") {
        assert.equal(statSync(first.path).mode & 0o777, 0o600 & ~process.umask());
    }
});
