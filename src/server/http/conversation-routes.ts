/** `/api/c/:id`: one conversation's routes, for people the API has checked may see it. */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Attachment, SubmitRequest } from "../commands.ts";
import { HttpError } from "../errors.ts";
import { serveDownload, serveImage, TYPES } from "./assets.ts";
import { type ApiRequest, json, readJson, send } from "./io.ts";

const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_WORKSPACE_UPLOAD = 100 * 1024 * 1024;

const ENTRY_IMAGE_TYPES = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/bmp",
]);

function safeName(name: string): string {
    const base = basename(name)
        .replace(/[^\w.\- ()]+/g, "_")
        .trim();

    return base === "" || base.startsWith(".") ? `upload${base}` : base.slice(0, 120);
}

export async function conversationRoutes(
    api: ApiRequest,
    id: ConversationId,
    parts: string[],
): Promise<void> {
    const { app, request, response, url, user } = api;
    const method = request.method ?? "GET";
    const [, , third, fourth] = parts;

    if (third === "submit" && method === "POST") {
        const body = await readJson<SubmitRequest>(request);

        if (typeof body.text !== "string" || typeof body.requestId !== "string") {
            throw new HttpError(400, "text and requestId are required");
        }

        if (body.attachments !== undefined && !Array.isArray(body.attachments)) {
            throw new HttpError(400, "attachments must be a list");
        }

        const attachments = (body.attachments ?? []).filter((file): file is Attachment => {
            // Only files this server stored for this conversation.
            return (
                typeof file?.path === "string" &&
                resolve(file.path).startsWith(app.workspace.uploadDirectory(id) + sep)
            );
        });

        return json(response, 200, await app.commands.submit(id, user, { ...body, attachments }));
    }

    if (third === "chat" && method === "POST") {
        const body = await readJson<{
            text?: unknown;
            requestId?: unknown;
            quote?: { entryId?: unknown };
        }>(request);

        if (typeof body.text !== "string" || typeof body.requestId !== "string") {
            throw new HttpError(400, "text and requestId are required");
        }

        const quote =
            typeof body.quote === "object" && body.quote !== null
                ? { entryId: body.quote.entryId }
                : undefined;

        return json(
            response,
            200,
            await app.collab.postChat(id, user, {
                text: body.text,
                requestId: body.requestId,
                ...(quote === undefined ? {} : { quote }),
            }),
        );
    }

    if (third === "react" && method === "POST") {
        const body = await readJson<{ entryId?: unknown; emoji?: unknown }>(request);

        await app.collab.react(id, user, Number(body.entryId), String(body.emoji ?? ""));

        return json(response, 200, { ok: true });
    }

    if (third === "pin" && method === "POST") {
        return json(response, 200, await app.collab.pin(id, user, await readJson(request)));
    }

    if (third === "notes" && method === "POST") {
        const body = await readJson<{ text?: unknown; rev?: unknown }>(request);

        if (typeof body.text !== "string" || typeof body.rev !== "number") {
            throw new HttpError(400, "text and rev are required");
        }

        return json(response, 200, await app.collab.saveNotes(id, user, body.text, body.rev));
    }

    if (third === "turns" && method === "POST") {
        await app.collab.turns(id, user, await readJson(request));

        return json(response, 200, { ok: true });
    }

    if (third === "typing" && method === "POST") {
        const body = await readJson<{ where?: unknown }>(request);

        app.collab.setTyping(id, user, body.where);

        return json(response, 200, { ok: true });
    }

    if (third === "abort" && method === "POST") {
        await app.commands.abort(id, user);

        return json(response, 200, { ok: true });
    }

    if (third === "withdraw" && method === "POST") {
        const body = await readJson<{ submissionId?: number }>(request);

        return json(response, 200, {
            result: await app.commands.withdraw(id, user, Number(body.submissionId)),
        });
    }

    if (third === "configure" && method === "POST") {
        await app.commands.configure(id, user, await readJson(request));

        return json(response, 200, { ok: true });
    }

    if (third === "reset" && method === "POST") {
        const body = await readJson<{ note?: unknown }>(request);

        await app.commands.reset(id, user, body.note);

        return json(response, 200, { ok: true });
    }

    if (third === "instructions" && method === "POST") {
        const body = await readJson<{ text?: unknown }>(request);

        await app.commands.setInstructions(id, user, body.text);

        return json(response, 200, { ok: true });
    }

    if (third === "plan" && method === "POST") {
        const body = await readJson<{ on?: unknown; approve?: unknown }>(request);

        if (body.approve === true) {
            return json(response, 200, await app.commands.approvePlan(id, user));
        }

        await app.commands.setPlan(id, user, body.on);

        return json(response, 200, { ok: true });
    }

    if (third === "schedules" && fourth === undefined && method === "POST") {
        return json(response, 200, await app.commands.schedule(id, user, await readJson(request)));
    }

    if (
        third === "schedules" &&
        fourth !== undefined &&
        parts[4] === "cancel" &&
        method === "POST"
    ) {
        await app.commands.cancelSchedule(id, user, fourth);

        return json(response, 200, { ok: true });
    }

    if (third === "goal" && method === "POST") {
        const body = await readJson<{ command?: unknown; clear?: unknown }>(request);

        if (body.clear === true) {
            await app.commands.clearGoal(id, user);
        } else {
            await app.commands.setGoal(id, user, body.command);
        }

        return json(response, 200, { ok: true });
    }

    if (third === "worktree" && method === "POST") {
        const body = await readJson<{ remove?: unknown; force?: unknown }>(request);

        if (body.remove !== true) {
            throw new HttpError(400, "Only removing a worktree is asked for here");
        }

        await app.commands.removeWorktree(id, user, body.force);

        return json(response, 200, { ok: true });
    }

    if (third === "fork" && method === "POST") {
        return json(response, 200, await app.commands.fork(id, user, await readJson(request)));
    }

    if (third === "resend" && method === "POST") {
        return json(response, 200, await app.commands.resend(id, user, await readJson(request)));
    }

    if (third === "compact" && method === "POST") {
        const body = await readJson<{ instructions?: unknown }>(request);

        if (
            body.instructions !== undefined &&
            body.instructions !== null &&
            typeof body.instructions !== "string"
        ) {
            throw new HttpError(400, "instructions must be text");
        }

        await app.commands.compact(
            id,
            user,
            (body.instructions as string | null | undefined)?.trim() || undefined,
        );

        return json(response, 200, { ok: true });
    }

    if (third === "image" && fourth !== undefined && method === "GET") {
        const image = await app.transcripts.entryImage(id, Number(fourth), Number(parts[4] ?? 0));

        if (image === undefined || !ENTRY_IMAGE_TYPES.has(image.mimeType)) {
            throw new HttpError(404, "No such image");
        }

        // Stored entries never change.
        return send(response, 200, image.data, image.mimeType, {
            "cache-control": "private, max-age=31536000, immutable",
        });
    }

    if (third === "file" && method === "GET") {
        const requested = url.searchParams.get("path") ?? "";

        if (requested.trim() === "") {
            throw new HttpError(400, "path is required");
        }

        return serveImage(request, response, app.workspace.conversationFile(user, id, requested));
    }

    if (third === "download" && method === "GET") {
        const requested = url.searchParams.get("path") ?? "";

        if (requested.trim() === "") {
            throw new HttpError(400, "path is required");
        }

        await app.conversation(id);

        return serveDownload(
            response,
            app.workspace.readableFile(user, id, requested),
            basename(requested),
        );
    }

    if (third === "file" && method === "DELETE") {
        const requested = url.searchParams.get("path") ?? "";

        if (requested.trim() === "") {
            throw new HttpError(400, "path is required");
        }

        await app.workspace.deleteFile(id, user, requested);

        return json(response, 200, { ok: true });
    }

    if (third === "entry" && fourth !== undefined && method === "GET") {
        const entry = await app.transcripts.fullEntry(id, Number(fourth));

        if (entry === undefined) {
            throw new HttpError(404, "No such entry");
        }

        return json(response, 200, entry);
    }

    if (third === "export" && method === "GET") {
        const { filename, markdown } = await app.transcripts.exportMarkdown(id, user);

        return send(response, 200, markdown, "text/markdown; charset=utf-8", {
            "content-disposition": `attachment; filename="${filename}"`,
        });
    }

    if (third === "changes" && fourth === undefined && method === "GET") {
        return json(response, 200, await app.workspace.changes(id, user));
    }

    if (third === "changes" && fourth === "diff" && method === "GET") {
        return send(
            response,
            200,
            await app.workspace.changeDiff(id, user, url.searchParams.get("path") ?? ""),
            "text/plain; charset=utf-8",
        );
    }

    // The folder's files for `@` mentions. A browser that has the newest list says so with `since` and gets only
    // that; a whole list goes compressed when the browser takes it so.
    if (third === "files" && method === "GET") {
        const listing = await app.workspace.fileList(id, user);

        if (url.searchParams.get("since") === listing.version) {
            return json(response, 200, { version: listing.version, same: true });
        }

        if (!/\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""))) {
            return send(response, 200, listing.json, "application/json");
        }

        return send(response, 200, await listing.gzipped(), "application/json", {
            "content-encoding": "gzip",
            vary: "accept-encoding",
        });
    }

    // Prompt templates and skills, for the message box's slash commands.
    if (third === "prompts" && method === "GET") {
        const templates = app.promptTemplates(id).map(({ name, description, argumentHint }) => ({
            name,
            description,
            ...(argumentHint === undefined ? {} : { argumentHint }),
        }));
        const skills = app.skillCommands(id).map(({ name, description }) => ({
            name: `skill:${name}`,
            description,
            argumentHint: "[what to do]",
            skill: true,
        }));

        return json(response, 200, [...templates, ...skills]);
    }

    if (third === "view" && method === "GET") {
        const requested = url.searchParams.get("path") ?? "";

        if (requested.trim() === "") {
            throw new HttpError(400, "path is required");
        }

        return json(response, 200, await app.workspace.viewFile(id, user, requested));
    }

    if (third === "changes" && fourth === "revert" && method === "POST") {
        const body = await readJson<{ path?: unknown }>(request);

        if (typeof body.path !== "string" || body.path === "") {
            throw new HttpError(400, "path is required");
        }

        await app.workspace.revertChange(id, user, body.path);

        return json(response, 200, { ok: true });
    }

    if (third === "branches" && fourth === undefined && method === "GET") {
        return json(response, 200, await app.workspace.branches(id, user));
    }

    if (third === "branch" && fourth === undefined && method === "POST") {
        return json(
            response,
            200,
            await app.workspace.switchBranch(id, user, (await readJson(request)) ?? {}),
        );
    }

    if (third === "shell" && fourth === undefined && method === "POST") {
        return json(response, 200, await app.shell.start(id, user, await readJson(request)));
    }

    if (third === "shell" && fourth !== undefined && parts[4] === "stop" && method === "POST") {
        await app.shell.stop(id, user, Number(fourth));

        return json(response, 200, { ok: true });
    }

    if (third === "history" && method === "GET") {
        return json(
            response,
            200,
            await app.transcripts.history(
                id,
                Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER),
            ),
        );
    }

    if (third === "upload" && method === "POST") {
        app.requireSteer(user);

        const directory = url.searchParams.get("directory");
        const limit = directory === null ? MAX_UPLOAD : MAX_WORKSPACE_UPLOAD;
        const tooLarge = `Files can be up to ${limit / 1024 / 1024} MiB`;

        if (Number(request.headers["content-length"] ?? 0) > limit) {
            throw new HttpError(413, tooLarge);
        }

        await app.conversation(id);
        const given = url.searchParams.get("name") ?? "upload";
        const name = directory === null ? safeName(given) : given;
        // Attachments keep unique names; Files uploads keep their names, without overwriting anything.
        const file =
            directory === null
                ? join(
                      app.workspace.uploadDirectory(id),
                      `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${name}`,
                  )
                : app.workspace.uploadPath(user, id, directory, name);
        // Reserve the name before piping: a failed open must not destroy the HTTP socket.
        const target = await open(file, "wx", directory === null ? 0o600 : 0o666).catch(
            (error: NodeJS.ErrnoException) => {
                if (error.code === "EEXIST") {
                    throw new HttpError(409, `${name} already exists. Nothing was overwritten.`);
                }

                throw error;
            },
        );
        let size = 0;

        try {
            // Keep the socket alive when rejecting a chunked upload, so the browser
            // receives the error rather than a failed network request.
            for await (const chunk of request.iterator({ destroyOnReturn: false })) {
                size += chunk.length;

                if (size > limit) {
                    throw new HttpError(413, tooLarge);
                }

                await target.writeFile(chunk);
            }

            if (!request.complete) {
                throw new HttpError(400, "The upload stopped before it finished");
            }
        } catch (error) {
            // A cut-off or oversized upload leaves nothing behind; this file was created by this request.
            request.resume();
            rmSync(file, { force: true });

            if (error instanceof HttpError || request.complete) {
                throw error;
            }

            throw new HttpError(400, "The upload stopped before it finished");
        } finally {
            await target.close();
        }

        const mime =
            String(request.headers["content-type"] ?? "") ||
            TYPES[extname(name).toLowerCase()] ||
            "application/octet-stream";
        const attachment: Attachment = {
            path: file,
            name,
            mime: mime.split(";")[0]!.trim(),
            size,
        };

        return json(response, 200, attachment);
    }

    throw new HttpError(404, "Unknown API route");
}
