// The Files tile's transfers at desktop and phone sizes, against the real app with a scripted model.
import {
    type App,
    cleanUp,
    newSession,
    openApp,
    root,
    scriptedModel,
    until,
    work,
} from "./helpers.ts";
import assert from "node:assert/strict";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { VIEWPORTS } from "../src/server/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let id: ConversationId;
let base: string;
const directory = join(work, "nested");

before(async () => {
    if (chromium === undefined) {
        return;
    }

    mkdirSync(directory);
    app = await openApp(scriptedModel());
    id = await newSession(app);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: join(root, "browser"),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.evaluate('localStorage.setItem("pocket.filesWidth", "760")');
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

async function read<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Select bytes as the system picker would. Clicking the real button first captures its destination. */
async function upload(directory: string, name: string, bytes: number[], scope = ".files-tile") {
    if (scope === ".files-tile") {
        await page.evaluate(`
            const area = document.querySelector('.files-tile .file-upload-area');
            if (area.dataset.dropPath !== ${JSON.stringify(directory)}) {
                const row = [...area.querySelectorAll('.ft-row.dir')].find(row => row.dataset.path === ${JSON.stringify(directory)});
                (row ?? area.querySelector('.ft-root')).click();
            }
        `);
    }

    await until(
        async () =>
            read<boolean>(
                `return JSON.stringify([...document.querySelectorAll(${JSON.stringify(`${scope} .file-upload-area`)})].some(area => area.dataset.dropPath === ${JSON.stringify(directory)}))`,
            ),
        "upload destination",
    );
    await page.evaluate(`
        const area = [...document.querySelectorAll(${JSON.stringify(`${scope} .file-upload-area`)})].find(area => area.dataset.dropPath === ${JSON.stringify(directory)});
        const button = area.querySelector('.file-upload-tools button');
        const input = area.querySelector('input[type=file]');
        input.click = () => {};
        button.click();
        const selected = new DataTransfer();
        selected.items.add(new File([new Uint8Array(${JSON.stringify(bytes)})], ${JSON.stringify(name)}));
        input.files = selected.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    `);
}

for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900, scale: 1, mobile: false }],
    ["phone", VIEWPORTS.mobile],
] as const) {
    test(
        `Files uploads and downloads work on ${name}, including folder targets and conflicts`,
        real,
        async () => {
            await page.setViewport(viewport);
            await page.evaluate("sessionStorage.clear()");
            await page.navigate(`${base}/s/${id}`);
            await until(
                async () =>
                    read<boolean>(
                        `return JSON.stringify(!!document.querySelector('.topbar [aria-label="Files"]'))`,
                    ),
                "Files button",
            );
            await page.evaluate(`document.querySelector('.topbar [aria-label="Files"]').click()`);
            await until(
                async () =>
                    read<boolean>(
                        `return JSON.stringify(!!document.querySelector('.ft-row[title="nested"]'))`,
                    ),
                "folder tree",
            );
            const filename = `${name}-žluťoučký.bin`;
            const bytes = [0, 1, 127, 128, 255];

            await upload(directory, filename, bytes);
            await until(() => existsSync(join(directory, filename)), "uploaded file");
            await until(
                async () =>
                    read<boolean>(
                        `return JSON.stringify(!!document.querySelector('.ft-row[title=${JSON.stringify(filename)}]'))`,
                    ),
                "refreshed tree",
            );
            assert.deepEqual(readFileSync(join(directory, filename)), Buffer.from(bytes));
            assert.equal(existsSync(join(work, filename)), false);
            await upload(directory, filename, [42]);
            await until(
                async () =>
                    read<boolean>(
                        `return JSON.stringify(document.body.textContent.includes('Nothing was overwritten'))`,
                    ),
                "name conflict notice",
            );
            assert.deepEqual(readFileSync(join(directory, filename)), Buffer.from(bytes));
            await page.evaluate(
                `document.querySelector('.ft-row[title=${JSON.stringify(filename)}]').click()`,
            );
            await until(
                async () =>
                    read<boolean>(
                        `return JSON.stringify(!!document.querySelector('.file-tools a[download]'))`,
                    ),
                "Download link",
            );
            const downloaded = await read<{ status: number; bytes: number[] }>(`
            const response = await fetch(document.querySelector('.file-tools a[download]').href);
            return JSON.stringify({ status: response.status, bytes: [...new Uint8Array(await response.arrayBuffer())] });
        `);

            assert.equal(downloaded.status, 200);
            assert.deepEqual(downloaded.bytes, bytes);

            if (name === "phone") {
                await page.evaluate(
                    `document.querySelector('[aria-label="Back to the files"]').click()`,
                );
            }

            await upload(work, `${name}-root.txt`, [65]);
            await until(
                () => existsSync(join(work, `${name}-root.txt`)),
                "upload into the session root",
            );
            await until(
                async () =>
                    read<boolean>(
                        `return JSON.stringify(!document.querySelector('.file-upload-tools button').disabled)`,
                    ),
                "upload finished",
            );
            await page.evaluate(`
                const row = document.querySelector('.ft-row[title="nested"]');
                const transfer = new DataTransfer();
                transfer.items.add(new File([new Uint8Array([0, 128, 255])], ${JSON.stringify(`${name}-drop.bin`)}));
                row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
                row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
            `);
            await until(
                () => existsSync(join(directory, `${name}-drop.bin`)),
                "drop into the pointed folder",
            );
            await until(
                async () =>
                    read<boolean>(
                        `return JSON.stringify(!document.querySelector('.file-upload-tools button').disabled)`,
                    ),
                "drop finished",
            );
            assert.deepEqual(
                readFileSync(join(directory, `${name}-drop.bin`)),
                Buffer.from([0, 128, 255]),
            );
        },
    );
}

test("an upload can be cancelled without losing the Files pane", real, async () => {
    await page.evaluate(`
        window.transferFetch = window.fetch;
        window.fetch = (url, options) => {
            if (String(url).includes('name=cancel-me')) {
                return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
            }
            return window.transferFetch(url, options);
        };
    `);

    try {
        await upload(work, "cancel-me", [65]);
        await until(
            async () =>
                read<boolean>(
                    `return JSON.stringify([...document.querySelectorAll('.file-upload-tools button')].some(button => button.textContent.trim() === 'Cancel upload'))`,
                ),
            "cancel control",
        );
        await page.evaluate(
            `[...document.querySelectorAll('.file-upload-tools button')].find(button => button.textContent.trim() === 'Cancel upload').click()`,
        );
        await until(
            async () =>
                read<boolean>(
                    `return JSON.stringify(document.querySelector('.file-transfer-status').textContent === 'Upload cancelled.')`,
                ),
            "cancelled upload",
        );
        assert.equal(existsSync(join(work, "cancel-me")), false);
        assert.equal(
            await read<boolean>(
                `return JSON.stringify(document.querySelector('.file-upload-tools button').disabled)`,
            ),
            false,
        );
    } finally {
        await page.evaluate("window.fetch = window.transferFetch; delete window.transferFetch");
    }
});

test("the folder viewer's own Upload button refreshes its entries", real, async () => {
    await page.evaluate(
        `(await import('/store.js')).openSheet({ type: 'file', id: ${JSON.stringify(directory)} })`,
    );
    await until(
        async () =>
            read<boolean>(
                `return JSON.stringify(!!document.querySelector('.sheet-body .file-upload-tools input[type="file"]'))`,
            ),
        "folder viewer",
    );
    await upload(directory, "from-folder-view.txt", [65, 66], ".sheet-body");
    await until(
        async () =>
            read<boolean>(
                `return JSON.stringify([...document.querySelectorAll('.sheet-body .file-entry')].some(entry => entry.textContent.includes('from-folder-view.txt')))`,
            ),
        "refreshed folder viewer",
    );
    assert.deepEqual(readFileSync(join(directory, "from-folder-view.txt")), Buffer.from([65, 66]));
    await page.evaluate("(await import('/store.js')).closeSheet()");
});

test(
    "viewers can browse and download on desktop and phone, without upload/delete/Changes controls",
    real,
    async () => {
        const viewer = app.config.addUser("Viewer", "viewer");
        const other = await browsers.open(2);

        writeFileSync(join(work, "shared.txt"), "shared file");
        await other.navigate(`${base}/login?token=${encodeURIComponent(viewer.token)}`);

        for (const viewport of [
            { width: 1440, height: 900, scale: 1, mobile: false },
            VIEWPORTS.mobile,
        ]) {
            await other.setViewport(viewport);
            await other.evaluate(
                'sessionStorage.clear(); sessionStorage.setItem("pocket.filesTab", "changes")',
            );
            await other.navigate(`${base}/s/${id}`);
            await until(
                async () =>
                    JSON.parse(
                        await other.evaluate(
                            `return JSON.stringify(!!document.querySelector('.topbar [aria-label="Files"]'))`,
                        ),
                    ),
                "viewer Files button",
            );
            await other.evaluate(`
            window.fileRequests = [];
            const original = window.fetch;
            window.fetch = (url, options) => {
                if (/\\/api\\/c\\/\\d+\\/(changes|files)(\\?|$)/.test(String(url))) window.fileRequests.push(url);
                return original(url, options);
            };
            document.querySelector('.topbar [aria-label="Files"]').click();
        `);
            await until(
                async () =>
                    JSON.parse(
                        await other.evaluate(
                            `return JSON.stringify(!!document.querySelector('.ft-row[title="shared.txt"]'))`,
                        ),
                    ),
                "viewer file tree",
            );
            await other.evaluate(`document.querySelector('.ft-row[title="shared.txt"]').click()`);
            await until(
                async () =>
                    JSON.parse(
                        await other.evaluate(
                            `return JSON.stringify(!!document.querySelector('.file-tools a[download]'))`,
                        ),
                    ),
                "viewer download",
            );
            assert.equal(
                JSON.parse(
                    await other.evaluate(
                        `return JSON.stringify(await (await fetch(document.querySelector('.file-tools a[download]').href)).text())`,
                    ),
                ),
                "shared file",
            );
            assert.equal(
                JSON.parse(
                    await other.evaluate(
                        `return JSON.stringify(!!document.querySelector('.file-upload-tools, .ft-filter, [role="tabpanel"][aria-label="Changes"]'))`,
                    ),
                ),
                false,
            );
            assert.equal(
                JSON.parse(
                    await other.evaluate(
                        `return JSON.stringify([...document.querySelectorAll('.file-tools button')].some(button => /Delete|Mention|Upload/.test(button.textContent)))`,
                    ),
                ),
                false,
            );
            assert.deepEqual(
                JSON.parse(await other.evaluate("return JSON.stringify(window.fileRequests)")),
                [],
            );
        }
    },
);

test(
    "a scoped steerer confirms deletion, and deleting a link never deletes its target",
    real,
    async () => {
        const scoped = app.config.addUser("Scoped", "guest", [String(id)]);
        const other = await browsers.open(3);
        const link = join(work, "selected-link.txt");
        const target = join(work, "link-target.txt");

        writeFileSync(target, "keep");
        symlinkSync(target, link);
        await other.navigate(`${base}/login?token=${encodeURIComponent(scoped.token)}`);
        await other.navigate(`${base}/s/${id}`);
        await until(
            async () =>
                JSON.parse(
                    await other.evaluate(
                        `return JSON.stringify(!!document.querySelector('.topbar [aria-label="Files"]'))`,
                    ),
                ),
            "steerer Files button",
        );
        await other.evaluate(`document.querySelector('.topbar [aria-label="Files"]').click()`);
        await until(
            async () =>
                JSON.parse(
                    await other.evaluate(
                        `return JSON.stringify(!!document.querySelector('.ft-row[title="selected-link.txt"]'))`,
                    ),
                ),
            "link in tree",
        );
        await other.evaluate(
            `document.querySelector('.ft-row[title="selected-link.txt"]').click()`,
        );
        await until(
            async () =>
                JSON.parse(
                    await other.evaluate(
                        `return JSON.stringify([...document.querySelectorAll('.file-tools button')].some(button => button.textContent.trim() === 'Delete'))`,
                    ),
                ),
            "Delete button",
        );
        await other.evaluate(
            `document.querySelector('.file-tools .file-menu summary').click(); window.confirm = () => false; [...document.querySelectorAll('.file-tools button')].find(button => button.textContent.trim() === 'Delete').click()`,
        );
        assert.equal(lstatSync(link).isSymbolicLink(), true);
        await other.evaluate(
            `document.querySelector('.file-tools .file-menu summary').click(); window.confirm = () => true; [...document.querySelectorAll('.file-tools button')].find(button => button.textContent.trim() === 'Delete').click()`,
        );
        await until(() => !existsSync(link), "link deleted");
        assert.equal(readFileSync(target, "utf8"), "keep");
    },
);
