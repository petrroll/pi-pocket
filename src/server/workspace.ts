/**
 * A conversation's folder on this machine, as people reach it through the app: which files a person may load or read,
 * the file viewer, the files for `@` mentions, Changes, its git branch, uploads, and new folders from the folder picker. The
 * operations people call directly check who may do them; the path helpers (`conversationPath`, `conversationFile`,
 * `readableFile`, `uploadPath`, `uploadDirectory`) leave seeing the conversation to their callers.
 */
import { lstatSync, mkdirSync, realpathSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import {
    type Branches,
    branchesIn,
    gitDirOf,
    type Head,
    headOf,
    isRemoteBranch,
    localName,
    switchBranch,
    validBranchName,
} from "./branches.ts";
import { type Changes, changesIn, diffOf, revertFile } from "./changes.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { FileLists, type FileListing, type FileView, viewFile } from "./files.ts";
import { displayPath, expandHome } from "./paths.ts";

function inside(root: string, file: string): boolean {
    const rel = relative(root, file);

    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export class Workspace {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The files in each folder, for `@` mentions. */
    readonly #files = new FileLists();

    /**
     * Where each folder's repository keeps its files, for a minute: views ask on every update. A folder in none is
     * asked about again after a few seconds, so one Pi has just run `git init` in shows its branch soon.
     */
    readonly #gitDirs = new Map<string, { gitDir: string | undefined; at: number }>();

    #gitDir(cwd: string): string | undefined {
        const known = this.#gitDirs.get(cwd);

        if (
            known !== undefined &&
            Date.now() - known.at < (known.gitDir === undefined ? 5000 : 60_000)
        ) {
            return known.gitDir;
        }

        const gitDir = gitDirOf(cwd);

        this.#gitDirs.set(cwd, { gitDir, at: Date.now() });

        return gitDir;
    }

    /** Whether a folder is in a git repository. */
    inRepository(cwd: string): boolean {
        return this.#gitDir(cwd) !== undefined;
    }

    /** What a conversation's folder has checked out, for its view: its repository's HEAD file, read as it is now. */
    head(id: ConversationId): Head | undefined {
        const gitDir = this.#gitDir(this.#app.cwdOf(id));

        return gitDir === undefined ? undefined : headOf(gitDir);
    }

    /** The branches of a session's repository, for the branch sheet: for people who can steer, as Changes is. */
    async branches(id: ConversationId, user: User): Promise<Branches> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        const cwd = this.#app.cwdOf(id);

        if (this.#gitDir(cwd) === undefined) {
            throw new HttpError(404, "This session's folder is not in a git repository.");
        }

        return branchesIn(cwd).catch((error: unknown) => {
            throw new HttpError(409, describe(error));
        });
    }

    /**
     * Switch a session's folder to another branch: one there already, a new one from what is checked out (`create`),
     * or a new one following a remote branch (`track`). It changes the files under Pi, so as with moving the session to
     * another folder it takes the right to drive, someone not invited to one session only, and Pi not working; Pi is
     * told with its next message.
     */
    async switchBranch(
        id: ConversationId,
        user: User,
        request: { name?: unknown; create?: unknown; track?: unknown },
    ): Promise<{ branch: string }> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session.");
        }

        await this.#app.requireDriver(id, user);

        const track = typeof request.track === "string" ? request.track : undefined;
        const name =
            typeof request.name === "string" ? request.name.trim() : track && localName(track);
        const cwd = this.#app.cwdOf(id);

        if (track !== undefined && !(await isRemoteBranch(cwd, track))) {
            throw new HttpError(400, `${track} is not a remote branch here.`);
        }

        if (!name || !(await validBranchName(cwd, name))) {
            throw new HttpError(400, `${name ? `“${name}”` : "That"} cannot be a branch name.`);
        }

        if (this.#app.isBusy(id)) {
            throw new HttpError(
                409,
                "Pi is working here: wait for it, or stop it, before switching branches.",
            );
        }

        const before = this.head(id);

        await switchBranch(cwd, {
            name,
            create: request.create === true,
            ...(track ? { track } : {}),
        }).catch((error: unknown) => {
            throw new HttpError(409, describe(error));
        });
        const from = before !== undefined && "branch" in before ? ` from ${before.branch}` : "";
        const what =
            request.create === true || track !== undefined
                ? `made the branch ${name}${track ? `, following ${track},` : ""} and switched to it${from}`
                : `switched the branch${from} to ${name}`;

        await this.#app.commands.note(id, user, what);
        await this.#app.collab.activity(id, user, what);

        return { branch: name };
    }

    /** A folder to work in, as its whole path: a 404 when it is not there, so the folder picker can offer to make it. */
    checkDirectory(path: string): string {
        const absolute = resolve(expandHome(path.trim() === "" ? "~" : path.trim()));
        let found;

        try {
            found = statSync(absolute);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            if (code === "ENOTDIR") {
                throw new HttpError(400, `${absolute} is inside a file, not a folder.`);
            }

            if (code === "ELOOP") {
                throw new HttpError(400, `${absolute} is a link to nothing.`);
            }

            if (code !== "ENOENT") {
                throw new HttpError(400, `Could not open ${absolute}: ${describe(error)}`);
            }

            // Not there, unless it is a link to nowhere: that cannot be made a folder either.
            throw lstatSync(absolute, { throwIfNoEntry: false }) === undefined
                ? new HttpError(404, `${absolute} isn't there.`)
                : new HttpError(400, `${absolute} is a link to nothing.`);
        }

        if (!found.isDirectory()) {
            throw new HttpError(400, `${absolute} is a file, not a folder.`);
        }

        return absolute;
    }

    /**
     * Make a folder to start a session in or move one to, with any folders missing above it, for someone who may browse
     * folders (`/api/fs`): who can steer, and was not invited to one session. A folder already there is fine: it is the
     * one asked for. Returns its path.
     */
    makeFolder(user: User, path: string): string {
        this.#app.requireSteer(user);

        if (user.sessions !== undefined) {
            throw new HttpError(403, "You were invited to one session.");
        }

        const written = path.trim();

        if (written === "" || written.includes("\0")) {
            throw new HttpError(400, "Name the folder to make.");
        }

        const expanded = expandHome(written);

        if (!isAbsolute(expanded)) {
            throw new HttpError(400, "Give the folder's whole path, from / or ~.");
        }

        const absolute = resolve(expanded);

        try {
            mkdirSync(absolute, { recursive: true });
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;

            // A file in the way, or a link that leads nowhere (or in a loop): the path cannot be a folder.
            throw new HttpError(
                409,
                code === "EEXIST" || code === "ENOTDIR"
                    ? `${absolute} is a file, or inside one.`
                    : code === "ENOENT" || code === "ELOOP"
                      ? `${absolute} is a broken link, or inside one.`
                      : `Could not make ${absolute}: ${describe(error)}`,
            );
        }

        // Made, or a folder already: either way it must be a folder now.
        return this.checkDirectory(absolute);
    }

    /** A path as a conversation means it: absolute, `~/…`, or relative to the conversation's working directory. */
    conversationPath(id: ConversationId, path: string): string {
        // File paths are literal: trimming could read or delete a different file.
        return resolve(this.#app.cwdOf(id), expandHome(path));
    }

    /**
     * A file a person may load through a conversation. People who can steer reach the whole machine through Pi anyway;
     * viewers and people invited to one session get only files under the conversation's folder or its uploads.
     */
    conversationFile(user: User, id: ConversationId, path: string): string {
        const file = this.conversationPath(id, path);

        if (user.role !== "viewer" && user.sessions === undefined) {
            return file;
        }

        const real = (target: string) => {
            try {
                return realpathSync(target);
            } catch {
                return undefined;
            }
        };

        const target = real(file);
        const cwd = this.#app.cwdOf(id);
        // A fork shows the messages it inherited, with the files attached to them in the sessions it came from. Their
        // later uploads are in the same folders, but an upload's name has random bits in it and shows only in its
        // message, so nobody who cannot read that message can name the file.
        const uploads = this.#lineage(id).map((each) =>
            join(this.#app.dataDir, "uploads", String(each)),
        );
        const roots = [cwd, ...uploads]
            .map(real)
            .filter((root): root is string => root !== undefined);

        if (target === undefined || !roots.some((root) => inside(root, target))) {
            throw new HttpError(404, "Image not found");
        }

        return target;
    }

    /**
     * A file a person may read whole through a session: the viewer, and files sent along with a message. As
     * `conversationFile`, but Pi's own folder (sign-ins, settings) and this app's data (people, tokens, the database)
     * are the owner's alone. Uploads and worktrees, which sessions use, are not kept back.
     */
    readableFile(user: User, id: ConversationId, path: string): string {
        const file = this.conversationFile(user, id, path);

        if (user.role === "owner") {
            return file;
        }

        const real = (target: string) => {
            try {
                return realpathSync(target);
            } catch {
                return resolve(target);
            }
        };

        const target = real(file);
        const data = real(this.#app.dataDir);

        if (
            inside(real(getAgentDir()), target) ||
            (inside(data, target) &&
                !inside(join(data, "uploads"), target) &&
                !inside(join(data, "worktrees"), target))
        ) {
            throw new HttpError(404, "Not found");
        }

        return file;
    }

    /** This session and the sessions it was forked from, nearest first. */
    #lineage(id: ConversationId): ConversationId[] {
        const lineage = [id];

        for (
            let meta = this.#app.sessionMeta(id);
            meta?.forkedFrom !== undefined && lineage.length < 64;
        ) {
            const parent = meta.forkedFrom.id as unknown as ConversationId;

            if (lineage.includes(parent)) {
                break;
            }

            lineage.push(parent);
            meta = this.#app.sessionMeta(parent);
        }

        return lineage;
    }

    /** The session's recursive file index, for steerers' search and @ mentions. */
    async fileList(id: ConversationId, user: User): Promise<FileListing> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);
        await this.#app.conversation(id);

        return this.#files.get(this.#app.cwdOf(id));
    }

    /** A readable file or folder: text, an image, a folder's entries, or binary. */
    async viewFile(
        id: ConversationId,
        user: User,
        path: string,
    ): Promise<{ path: string; display: string } & FileView> {
        this.#app.requireSee(user, id);
        await this.#app.conversation(id);
        let file: string;

        try {
            file = this.readableFile(user, id, path);
            const content = await viewFile(file);

            if (user.role === "viewer" && content.kind === "folder") {
                const root = realpathSync(this.#app.cwdOf(id));
                const uploads = await realpath(join(this.#app.dataDir, "uploads")).catch(
                    () => null,
                );

                // A viewer may open known attachments, but must not enumerate the
                // upload stash (including a parent session's uploads after a fork).
                if (!inside(root, file) || (uploads !== null && inside(uploads, file))) {
                    throw new HttpError(404, "Folder not found");
                }
            }

            return {
                path: file,
                display: displayPath(file, this.#app.cwdOf(id)),
                ...content,
            };
        } catch (error) {
            if (error instanceof HttpError || (error as NodeJS.ErrnoException).code === "ENOENT") {
                throw new HttpError(404, `${path} is not there.`);
            }

            throw new HttpError(409, describe(error));
        }
    }

    /**
     * Undo the uncommitted changes to one file of a session's repository. It changes files under Pi, so it takes the
     * right to drive and waits until Pi is not working; Pi is told, with its next message.
     */
    async revertChange(id: ConversationId, user: User, path: string): Promise<void> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);

        if (this.#app.isBusy(id)) {
            throw new HttpError(
                409,
                "Pi is working here: wait for it, or stop it, before undoing a file.",
            );
        }

        const kind = await revertFile(this.#app.cwdOf(id), path, user.sessions !== undefined).catch(
            (error: unknown) => {
                throw new HttpError(409, describe(error));
            },
        );
        const what =
            kind === "new" || kind === "added"
                ? `deleted ${path}, which was new since the last commit`
                : `undid the uncommitted changes to ${path}`;

        await this.#app.commands.note(id, user, what);
        await this.#app.collab.activity(id, user, what);
    }

    /** What changed in a session's folder: Pi's edits, and the uncommitted changes of its git repository. */
    async changes(id: ConversationId, user: User): Promise<Changes> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        // Someone invited to this session only sees the files in its folder, here as in `conversationFile`.
        return changesIn(
            this.#app.cwdOf(id),
            await this.#app.transcripts.allEntries(id, false),
            user.sessions !== undefined,
        );
    }

    /** The diff of one changed file in a session's repository. */
    async changeDiff(id: ConversationId, user: User, path: string): Promise<string> {
        this.#app.requireSee(user, id);
        this.#app.requireSteer(user);

        try {
            return await diffOf(this.#app.cwdOf(id), path, user.sessions !== undefined);
        } catch (error) {
            throw new HttpError(404, describe(error));
        }
    }

    /** Delete a file or empty folder in this session, with the same driving/busy safeguards as undoing an edit. */
    async deleteFile(id: ConversationId, user: User, path: string): Promise<void> {
        this.#app.requireSee(user, id);
        await this.#app.requireDriver(id, user);
        await this.#app.conversation(id);

        if (this.#app.isBusy(id)) {
            throw new HttpError(
                409,
                "Pi is working here: wait for it, or stop it, before deleting a file.",
            );
        }

        const requested = this.conversationPath(id, path);
        let file: string;

        try {
            const root = realpathSync(this.#app.cwdOf(id));
            const parent = realpathSync(this.readableFile(user, id, dirname(requested)));

            file = join(parent, basename(requested));

            if (file === root || !inside(root, file)) {
                throw new HttpError(
                    403,
                    "Only files inside this session's folder can be deleted, not the folder itself.",
                );
            }

            const info = lstatSync(file);

            // Remove a link itself, not its target. Non-links still obey the private-data boundary.
            if (!info.isSymbolicLink()) {
                this.readableFile(user, id, file);
            }

            if (info.isDirectory()) {
                rmdirSync(file);
            } else if (info.isFile() || info.isSymbolicLink()) {
                unlinkSync(file);
            } else {
                throw new HttpError(400, "Only files, links and empty folders can be deleted.");
            }
        } catch (error) {
            if (error instanceof HttpError) {
                throw error;
            }

            const code = (error as NodeJS.ErrnoException).code;

            if (code === "ENOENT" || code === "ENOTDIR") {
                throw new HttpError(404, "File not found");
            }

            if (code === "ENOTEMPTY" || code === "EEXIST") {
                throw new HttpError(409, "Folder is not empty. Nothing was deleted.");
            }

            throw new HttpError(409, describe(error));
        }

        const what = `deleted ${displayPath(file, this.#app.cwdOf(id))}`;

        await this.#app.commands.note(id, user, what);
        await this.#app.collab.activity(id, user, what);
    }

    /** A new file in a readable folder. The route checks session access and steering, as for attachment uploads. */
    uploadPath(user: User, id: ConversationId, directory: string, name: string): string {
        if (name.trim() === "" || name === "." || name === ".." || /[/\\\0]/.test(name)) {
            throw new HttpError(400, "Give the file's name, without a path.");
        }

        try {
            const folder = realpathSync(this.readableFile(user, id, directory));

            if (!statSync(folder).isDirectory()) {
                throw new HttpError(400, "Upload to a folder, not a file.");
            }

            return join(folder, name);
        } catch (error) {
            if (error instanceof HttpError) {
                throw error;
            }

            throw new HttpError(404, "Folder not found");
        }
    }

    uploadDirectory(id: ConversationId): string {
        const directory = join(this.#app.dataDir, "uploads", String(id));

        mkdirSync(directory, { recursive: true });

        return directory;
    }
}
