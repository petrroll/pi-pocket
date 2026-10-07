// Invitation lifetimes in the real web app, with Chromium where it is installed.
import { type App, cleanUp, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false };
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;

type Made = {
    request: { ttlMinutes: number; role?: string };
    invite: { code: string; expiresAt: number };
};
const inPage = async <T>(script: string): Promise<T> =>
    JSON.parse(await page.evaluate(script)) as T;
const latest = () => inPage<Made | null>("return JSON.stringify(window.invites.at(-1) ?? null)");
const shownCode = () =>
    inPage<string>(
        `return JSON.stringify(document.querySelector(".invite-code-value")?.textContent.replace(/\\s/g, "") ?? "")`,
    );
const choose = (minutes: number) =>
    page.evaluate(`
    const select = document.querySelector(".sheet select");
    select.value = "${minutes}";
    select.dispatchEvent(new Event("change", { bubbles: true }));
`);

async function waitForInvite(minutes: number): Promise<Made> {
    await until(async () => {
        const made = await latest();

        return made?.request.ttlMinutes === minutes && (await shownCode()) === made.invite.code;
    }, `the ${minutes}-minute invite`);

    return (await latest())!;
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    browsers = new Browsers({
        dataDir: join(root, "invites-ui"),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(
        async () =>
            inPage<boolean>(
                `return JSON.stringify(Boolean((await import("/store.js")).store.state.me))`,
            ),
        "signed in",
    );
    await page.evaluate(`
        window.invites = [];
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            if (args[0] === "/api/invite") {
                const request = JSON.parse(args[1].body);
                window.invites.push({ request, invite: await response.clone().json() });
                if (request.ttlMinutes === window.holdMinutes) {
                    await new Promise(resolve => { window.releaseInvite = resolve; });
                }
            }
            return response;
        };
        (await import("/store.js")).openSheet({ type: "invite" });
    `);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("the invite sheet chooses a lifetime and shows the server's expiry", real, async () => {
    let previous = "";

    for (const minutes of [15, 60, 1440, 10080]) {
        if (minutes !== 15) {
            await choose(minutes);
        }

        const made = await waitForInvite(minutes);

        assert.notEqual(made.invite.code, previous);
        assert.equal(made.request.role, "guest");
        assert.ok(Math.abs(made.invite.expiresAt - Date.now() - minutes * 60_000) < 10_000);
        assert.equal(
            await inPage<boolean>(`
            const sheet = document.querySelector(".sheet");
            return JSON.stringify(sheet.textContent.includes("Expires " + new Date(${made.invite.expiresAt}).toLocaleString())
                && sheet.textContent.includes("Restarting the server")
                && sheet.querySelector(".qr svg") !== null);
        `),
            true,
        );
        previous = made.invite.code;
    }

    await page.evaluate(
        `[...document.querySelectorAll(".sheet button")].find(button => button.textContent.trim() === "New invite").click()`,
    );
    await until(
        async () => (await shownCode()) !== "" && (await shownCode()) !== previous,
        "a new invite",
    );
    assert.equal((await waitForInvite(10080)).request.ttlMinutes, 10080);
});

test("a slow response cannot replace an invite with a different lifetime", real, async () => {
    await page.evaluate("window.holdMinutes = 60");
    await choose(60);
    await until(async () => (await latest())?.request.ttlMinutes === 60, "the held invite");
    await choose(1440);
    const made = await waitForInvite(1440);

    await page.evaluate("window.releaseInvite(); window.holdMinutes = null");
    await page.evaluate("await new Promise(resolve => setTimeout(resolve, 150))");
    assert.equal(await shownCode(), made.invite.code);
});

test(
    "the device sign-in sheet also sends the chosen lifetime without collaboration",
    real,
    async () => {
        await page.evaluate(`
        const { store } = await import("/store.js");
        store.set({ server: { ...store.state.server, collab: 0 } });
    `);
        await choose(10080);
        const made = await waitForInvite(10080);

        assert.equal(made.request.role, undefined);
        assert.deepEqual(
            page.logs().filter((entry) => entry.level === "error"),
            [],
        );
    },
);
