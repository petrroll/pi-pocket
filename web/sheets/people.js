// People with access to this server, and invites for more.
import { useEffect, useState } from "preact/hooks";
import { Avatar } from "../avatar.js";
import {
    actions,
    api,
    attempt,
    canSteer,
    closeSheet,
    collab,
    notify,
    openSheet,
    scoped,
    store,
} from "../store.js";
import { copyText, html, Icon, Loader, Sheet, timeAgo } from "../ui.js";

const ROLE_TEXT = {
    guest: "Can steer Pi, which can run commands on this machine",
    viewer: "Can read along, react, and chat, but not steer Pi",
};

export function InviteSheet({ session = null }) {
    const { view } = store.state;
    const here = view.conversation?.kind === "session" ? view.conversation : null;
    const [role, setRole] = useState("guest");
    const [only, setOnly] = useState(session !== null);
    const [ttlMinutes, setTtlMinutes] = useState(15);
    const [invite, setInvite] = useState(null);
    const [generation, setGeneration] = useState(0);
    const create = () => setGeneration((value) => value + 1);

    useEffect(() => {
        let cancelled = false;

        attempt(async () => {
            setInvite(null);
            const result = await api("invite", {
                ...(collab() ? { role, ...(only && here ? { session: here.id } : {}) } : {}),
                ttlMinutes,
            });

            // A slower response for old options must not replace the invite now requested.
            if (!cancelled) {
                setInvite(result);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [role, only, ttlMinutes, generation]);
    const where = only && here ? `only “${here.title}”` : "every session";

    return html`<${Sheet} title="Invite someone" onClose=${closeSheet}>
        ${
            collab() &&
            html`<div class="field">
                <div class="label">They can</div>
                <div class="segmented">
                    <button class=${role === "guest" ? "on" : ""} onClick=${() => setRole("guest")}>
                        Steer
                    </button>
                    <button
                        class=${role === "viewer" ? "on" : ""}
                        onClick=${() => setRole("viewer")}
                    >
                        View only
                    </button>
                </div>
                <div class="muted small">
                    ${ROLE_TEXT[role]}.${role === "guest" && only ? " Seeing one session in the app does not limit what Pi can reach on the machine." : ""}
                </div>
            </div>
            ${
                here &&
                html`<div class="field">
                    <div class="label">In</div>
                    <div class="segmented">
                        <button class=${!only ? "on" : ""} onClick=${() => setOnly(false)}>
                            Every session
                        </button>
                        <button class=${only ? "on" : ""} onClick=${() => setOnly(true)}>
                            Only this session
                        </button>
                    </div>
                </div>`
            }`
        }
        <div class="field">
            <label class="label" for="invite-ttl">Expires after</label>
            <select
                id="invite-ttl"
                value=${ttlMinutes}
                onChange=${(event) => setTtlMinutes(Number(event.currentTarget.value))}
            >
                <option value="15">15 minutes</option>
                <option value="60">1 hour</option>
                <option value="1440">1 day</option>
                <option value="10080">7 days</option>
            </select>
            <div class="muted small">Changing these options makes a new invite.</div>
        </div>
        <p class="muted small">
            Scan this on the other device, or send it the link. It works once. Whoever joins sees ${where}.
        </p>
        <p class="muted small">
            ${invite && `Expires ${new Date(invite.expiresAt).toLocaleString()}. `}Restarting the server also expires unused invites.
        </p>
        ${
            invite?.access?.url &&
            html`<p class="muted small">Other devices connect through ${invite.access.label}.</p>`
        }
        ${
            invite
                ? html`<div class="invite">
                    ${
                        invite.local &&
                        html`<div class="error-box">
                            This link only works on this device. To let other devices in, press <span class="mono">a</span> in the Pi Pocket terminal (or start it with <span class="mono">--access</span>) and pick Local network, Cloudflare Tunnel, or Tailscale. Then make a new invite.
                        </div>`
                    }
                    <div class="qr" dangerouslySetInnerHTML=${{ __html: invite.svg }}></div>
                    <div class="invite-code">
                        <div class="invite-code-head">
                            <span>Invite code</span>
                            <button
                                class="link small"
                                onClick=${() =>
                                    copyText(invite.code).then(
                                        () => notify("info", "Code copied."),
                                        () => notify("error", "Could not copy."),
                                    )}
                            >
                                Copy
                            </button>
                        </div>
                        <div
                            class="invite-code-value"
                            aria-label=${`Invite code ${invite.code.split("").join(" ")}`}
                        >
                            <span>${invite.code.slice(0, 5)}</span>
                            <span>${invite.code.slice(5)}</span>
                        </div>
                        <div class="muted small">
                            Or enter it on the other device's sign-in screen.
                        </div>
                    </div>
                    <div class="row">
                        <input
                            class="mono"
                            readonly
                            value=${invite.url}
                            onFocus=${(event) => event.currentTarget.select()}
                        />
                        <button
                            class="button"
                            onClick=${() =>
                                copyText(invite.url).then(
                                    () => notify("info", "Link copied."),
                                    () => notify("error", "Could not copy."),
                                )}
                        >
                            Copy
                        </button>
                    </div>
                    ${
                        invite.alternatives?.length > 0 &&
                        html`<p class="muted small">
                            Also reachable at: ${invite.alternatives.map(
                                (url) => html`<span class="mono">${url} </span>`,
                            )}
                        </p>`
                    }
                </div>`
                : html`<${Loader} label="Making an invite" />`
        }
        <button class="button wide" onClick=${create}>New invite</button>
        ${!collab() && html`<${PeopleList} />`}
    <//>`;
}

function lastSeen(person) {
    if (person.online) {
        return "here now";
    }

    if (!person.lastSeen) {
        return "not seen yet";
    }

    return `seen ${timeAgo(person.lastSeen)}${timeAgo(person.lastSeen) === "now" ? "" : " ago"}`;
}

/** Everyone with access: who is online, when the others were last here, and (for the owner) what each may do. */
function PeopleList() {
    const { me, users, sessions } = store.state;
    const owner = me?.role === "owner";
    const sessionTitle = (id) => sessions.find((each) => each.id === id)?.title ?? `session ${id}`;
    const ordered = [...users].sort(
        (a, b) =>
            Number(Boolean(b.online)) - Number(Boolean(a.online)) ||
            (b.lastSeen ?? 0) - (a.lastSeen ?? 0),
    );
    const change = (person, patch) =>
        attempt(async () => store.set({ users: await actions.setAccess(person.id, patch) }));

    return html`<div class="group">
        <div class="group-title">People</div>
        ${ordered.map(
            (person) => html`<div class="person-row" key=${person.id}>
                <span class=${`online-dot ${person.online ? "on" : ""}`}></span>
                <${Avatar} person=${person} size=${26} />
                <div class="person-main">
                    <div>
                        ${person.name}
                        ${person.id === me?.id ? html` <span class="muted small">(you)</span>` : ""}
                    </div>
                    <div class="muted small">
                        ${person.role === "owner" ? "owner" : person.role === "viewer" ? "view only" : "can steer"}
                        ${person.sessions ? ` · only ${person.sessions.map(sessionTitle).join(", ")}` : ""} · ${lastSeen(person)}
                    </div>
                </div>
                ${
                    owner &&
                    person.role !== "owner" &&
                    html`<div class="person-actions">
                        ${
                            collab() &&
                            html`<button
                                class="button small"
                                title="Change what they can do"
                                onClick=${() => change(person, { role: person.role === "viewer" ? "guest" : "viewer" })}
                            >
                                ${person.role === "viewer" ? "Let steer" : "View only"}
                            </button>`
                        }
                        ${
                            collab() &&
                            person.sessions &&
                            html`<button
                                class="button small"
                                title="Let them see every session"
                                onClick=${() => change(person, { sessions: null })}
                            >
                                All sessions
                            </button>`
                        }
                        <button
                            class="button small ghost"
                            onClick=${() =>
                                confirm(`Remove ${person.name}? Their devices are signed out.`) &&
                                attempt(async () => {
                                    await api(`users/${person.id}/remove`, {});
                                    store.set({
                                        users: store.state.users.filter(
                                            (each) => each.id !== person.id,
                                        ),
                                    });
                                })}
                        >
                            Remove
                        </button>
                    </div>`
                }
            </div>`,
        )}
    </div>`;
}

export function PeopleSheet() {
    const canInvite = canSteer() && !scoped();

    return html`<${Sheet} title="People" onClose=${closeSheet}>
        ${
            canInvite &&
            html`<button class="button primary wide" onClick=${() => openSheet({ type: "invite" })}>
                <${Icon} name="plus" size=${16} /> Invite someone
            </button>`
        }
        <${PeopleList} />
        <button class="button wide" onClick=${() => openSheet({ type: "notifications" })}>
            Notifications on this device…
        </button>
    <//>`;
}
