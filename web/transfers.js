// File transfers shared by the Files tree, previews, file sheets and Changes. The server rechecks every action.
import { useEffect, useRef, useState } from "preact/hooks";
import { actions, canSteer, notify, store } from "./store.js";
import { html } from "./ui.js";

export const FILES_CHANGED = "pocket-files-changed";
const MAX_UPLOAD = 100 * 1024 * 1024;

function changed(id, path) {
    dispatchEvent(new CustomEvent(FILES_CHANGED, { detail: { id, path } }));
}

/** Upload into the chosen folder, or the folder/file row under a drop. Viewers never upload. */
export function UploadArea({ path, children, onUploaded }) {
    const [busy, setBusy] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [message, setMessage] = useState("");
    const input = useRef(null);
    const selection = useRef(null);
    const controller = useRef(null);

    useEffect(() => () => controller.current?.abort(), []);

    const upload = async (files, destination) => {
        if (!files.length || controller.current || !canSteer() || !destination) {
            return;
        }

        const abort = new AbortController();

        controller.current = abort;
        setBusy(true);
        let count = 0;

        try {
            for (const file of files) {
                if (file.size > MAX_UPLOAD) {
                    throw new Error(`${file.name}: files can be up to 100 MiB.`);
                }

                setMessage(`Uploading ${file.name}…`);
                await actions.upload(file, { ...destination, signal: abort.signal });
                count++;
            }

            const text = `Uploaded ${count} ${count === 1 ? "file" : "files"}.`;

            setMessage(text);
            notify("info", text);
        } catch (error) {
            const text = abort.signal.aborted ? "Upload cancelled." : error.message;

            setMessage(text);
            notify(abort.signal.aborted ? "info" : "error", text);
        } finally {
            controller.current = null;
            setBusy(false);
            // A lost response can still mean the file arrived: refresh even after a failure.
            changed(destination.id, destination.directory);
            onUploaded?.();
        }
    };

    const hasFiles = (event) => [...(event.dataTransfer?.types ?? [])].includes("Files");

    return html`<div
        class=${`file-upload-area ${dragging ? "dragging" : ""}`}
        data-drop-path=${path}
        onDragOver=${(event) => {
            if (hasFiles(event)) {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = canSteer() && !busy ? "copy" : "none";
                setDragging(canSteer() && !busy);
            }
        }}
        onDragLeave=${(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
                setDragging(false);
            }
        }}
        onDrop=${(event) => {
            if (!hasFiles(event)) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            setDragging(false);
            const row = event.target.closest?.(".ft-row[data-path]");
            const destination = row
                ? row.classList.contains("dir")
                    ? row.dataset.path
                    : row.dataset.path.slice(0, row.dataset.path.lastIndexOf("/"))
                : path;

            void upload([...event.dataTransfer.files], {
                id: store.state.conversationId,
                directory: destination,
            });
        }}
    >
        ${
            canSteer() &&
            html`<div class="file-upload-tools">
                <input
                    ref=${input}
                    type="file"
                    multiple
                    hidden
                    aria-label="Upload workspace files"
                    onChange=${(event) => {
                        const files = [...event.currentTarget.files];

                        event.currentTarget.value = "";
                        void upload(files, selection.current);
                    }}
                />
                <button
                    class="button small"
                    type="button"
                    title=${`Upload into ${path}`}
                    disabled=${busy}
                    onClick=${() => {
                        selection.current = { id: store.state.conversationId, directory: path };
                        input.current.click();
                    }}
                >
                    Upload
                </button>
                <span class="muted small file-upload-hint" title=${path}>
                    Drop files here · ${path} · 100 MiB/file
                </span>
                ${
                    busy &&
                    html`<button
                        class="button small"
                        type="button"
                        onClick=${() => controller.current?.abort()}
                    >
                        Cancel upload
                    </button>`
                }
                <span class="file-transfer-status small" role="status" aria-live="polite">
                    ${message}
                </span>
            </div>`
        }
        ${dragging && html`<div class="file-drop-overlay">Drop files to upload</div>`}
        ${children}
    </div>`;
}

/** The same Download/Delete menu everywhere a file is shown. Delete always names the selected link, not its target. */
export function FileMenu({ path, kind = "file", onDeleted }) {
    const id = store.state.conversationId;
    const root = store.state.view.agent?.cwd ?? store.state.view.conversation?.cwd;
    const regular = ["file", "text", "image", "binary"].includes(kind);
    const removable = canSteer() && (regular || kind === "folder") && path !== root && path !== ".";
    const [busy, setBusy] = useState(false);
    const [position, setPosition] = useState("");
    const menu = useRef(null);
    const name = path.replace(/\/$/, "").split("/").pop();

    useEffect(() => {
        const outside = (event) => {
            if (!menu.current?.contains(event.target) && menu.current) {
                menu.current.open = false;
            }
        };

        document.addEventListener("pointerdown", outside);

        return () => document.removeEventListener("pointerdown", outside);
    }, []);

    if (!regular && !removable) {
        return null;
    }

    const remove = async () => {
        menu.current.open = false;

        if (
            !confirm(
                `Delete “${path}”? This cannot be undone.${kind === "folder" ? " Only empty folders can be deleted." : ""}`,
            )
        ) {
            return;
        }

        setBusy(true);

        try {
            await actions.deleteFile(path, id);
            notify("info", `Deleted ${name}.`);
            changed(id, path);
            onDeleted?.();
        } catch (error) {
            notify("error", error.message);
        } finally {
            setBusy(false);
        }
    };

    return html`<details
        class="file-menu"
        ref=${menu}
        onToggle=${(event) => {
            if (event.currentTarget.open) {
                const box = event.currentTarget.getBoundingClientRect();

                setPosition(
                    `left:${Math.max(8, Math.min(innerWidth - 188, box.right - 180))}px;top:${Math.max(8, Math.min(innerHeight - 104, box.bottom + 3))}px`,
                );
            }
        }}
        onKeyDown=${(event) => {
            if (
                menu.current.open &&
                ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(
                    event.key,
                )
            ) {
                event.preventDefault();
                event.stopPropagation();
                const items = [
                    ...menu.current.querySelectorAll('[role="menuitem"]:not(:disabled)'),
                ];
                const at = items.indexOf(document.activeElement);
                const next =
                    event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? items.length - 1
                          : event.key === "ArrowUp"
                            ? Math.max(0, at - 1)
                            : Math.min(items.length - 1, at + 1);

                items[next]?.focus();
            } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                menu.current.open = false;
            }
        }}
    >
        <summary
            class="icon-button"
            aria-label=${`Actions for ${name}`}
            title=${`Actions for ${name}`}
        >
            ⋯
        </summary>
        <div class="file-menu-actions" role="menu" style=${position}>
            ${
                regular &&
                html`<a
                    role="menuitem"
                    href=${`/api/c/${id}/download?path=${encodeURIComponent(path)}`}
                    download=${name}
                    onClick=${() => {
                        menu.current.open = false;
                    }}
                >
                    Download
                </a>`
            }
            ${
                removable &&
                html`<button
                    class="danger"
                    type="button"
                    role="menuitem"
                    disabled=${busy || store.state.view.live?.busy}
                    onClick=${remove}
                >
                    Delete${kind === "folder" ? " empty folder" : ""}
                </button>`
            }
        </div>
    </details>`;
}
