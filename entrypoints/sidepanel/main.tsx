import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ActionResult, PageInfo, Settings, ToContent } from '../../src/core/messages';
import { SETTINGS_KEY } from '../../src/core/messages';
import type { DraftSession, Note, NoteState } from '../../src/core/model';
import { threadLabel, unreadReplies } from '../../src/core/model';
import { adfToFragment } from '../../src/core/rich-text';
import type { AdfDoc } from '../../src/core/model';
import { isEmptyQuery, matches, parseQuery, SEARCH_HELP, snippet, type Query } from '../../src/core/search';
import { NoteStore, type ExportFile } from '../../src/core/store';
import { markThreadSeen, unpublishQuestion } from '../../src/confluence/comments';
import { readSyncConfig, readSyncState, SYNC_CONFIG_KEY, SYNC_STATE_KEY, type SyncConfig, type SyncState } from '../../src/sync/service';
import { createEditor, EDITOR_CSS, type Editor } from '../../src/ui/editor';
import './style.css';

const store = new NoteStore(browser.storage.local);

/** When opened as a normal tab (for testing), ?tab=<id> pins the target tab. */
const pinnedTab = Number(new URLSearchParams(location.search).get('tab')) || null;

async function targetTabId(): Promise<number | null> {
  if (pinnedTab) return pinnedTab;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function toTab<T>(msg: ToContent): Promise<T | null> {
  const id = await targetTabId();
  if (id === null) return null;
  try {
    return (await browser.tabs.sendMessage(id, msg)) as T;
  } catch {
    return null;
  }
}

/** Sends an action to the Confluence tab and returns its error, or a hint when there is no such tab. */
async function act(msg: ToContent, site?: string): Promise<string | null> {
  const r = await toTab<ActionResult>(msg);
  if (r) return r.error;
  return `Open a Confluence page${site ? ` on ${site}` : ''} in this tab first.`;
}

/** Opens a URL in the target tab, or a new tab when there is none. */
async function openInTab(url: string): Promise<void> {
  const id = await targetTabId();
  if (id !== null) await browser.tabs.update(id, { url });
  else await browser.tabs.create({ url });
}

type Filter = 'all' | NoteState | 'attention';
type View = 'page' | 'all' | 'settings';

const STATE_LABEL: Record<NoteState, string> = { private: 'Private', draft: 'Draft comment', published: 'Published' };
const NEEDS_ATTENTION = new Set(['orphaned', 'ambiguous', 'changed']);

function needsAttention(n: Note): boolean {
  return n.state !== 'published' && NEEDS_ATTENTION.has(n.anchorStatus);
}

function useStorageTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    browser.storage.onChanged.addListener(l);
    return () => browser.storage.onChanged.removeListener(l);
  }, []);
  return tick;
}

function usePageInfo(tick: number): [PageInfo | null, () => void] {
  const [info, setInfo] = useState<PageInfo | null>(null);
  const refresh = useCallback(() => {
    void toTab<PageInfo>({ type: 'get-page' }).then(setInfo);
  }, []);
  useEffect(() => {
    refresh();
    const onAct = () => refresh();
    const onUpd = (_id: number, change: { status?: string; url?: string }) => {
      if (change.status === 'complete' || change.url) setTimeout(refresh, 800);
    };
    browser.tabs.onActivated.addListener(onAct);
    browser.tabs.onUpdated.addListener(onUpd);
    const timer = setInterval(refresh, 3000);
    return () => {
      browser.tabs.onActivated.removeListener(onAct);
      browser.tabs.onUpdated.removeListener(onUpd);
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    const t = setTimeout(refresh, 300);
    return () => clearTimeout(t);
  }, [tick, refresh]);
  return [info, refresh];
}

function Body({ doc }: { doc: AdfDoc }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current!.replaceChildren(adfToFragment(doc, document));
  }, [JSON.stringify(doc)]);
  return <div class="body" ref={ref} />;
}

/** Saves the body of a private note or draft locally. */
async function saveLocal(note: Note, body: AdfDoc): Promise<string | null> {
  await store.update(note.id, { body });
  return null;
}

function InlineEditor({
  note,
  onDone,
  onSave = (body) => saveLocal(note, body),
  saveLabel = 'Save',
  hint,
}: {
  note: Note;
  onDone: () => void;
  onSave?: (body: AdfDoc) => Promise<string | null>;
  saveLabel?: string;
  hint?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const e = createEditor(document, note.body);
    editor.current = e;
    host.current!.append(e.el);
    e.onSubmit(save);
    e.focus();
    return () => e.el.remove();
  }, []);
  const save = async () => {
    if (!editor.current || editor.current.isEmpty()) return onDone();
    setBusy(true);
    const e = await onSave(editor.current.getDoc());
    setBusy(false);
    if (e) setError(e);
    else onDone();
  };
  return (
    <div class="editing">
      <div ref={host} />
      {hint && <div class="hint">{hint}</div>}
      {error && <div class="hint err">{error}</div>}
      <div class="row end">
        <button class="b" onClick={onDone}>
          Cancel
        </button>
        <button class="b primary" disabled={busy} onClick={save}>
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

function Thread({ note }: { note: Note }) {
  const t = note.published?.thread;
  if (!t) return null;
  const unread = new Set(unreadReplies(note).map((r) => r.id));
  return (
    <div class="thread">
      <div class="row">
        <span class={`chip ${t.resolution === 'resolved' ? 'ok' : t.resolution === 'deleted' || t.resolution === 'dangling' ? 'warn' : ''}`}>{threadLabel(t)}</span>
        {unread.size > 0 && <span class="chip new">{unread.size} new</span>}
        <span class="spacer" />
        {unread.size > 0 && (
          <button
            class="b small"
            onClick={() => {
              const seen = markThreadSeen(note);
              if (seen) void store.update(note.id, { published: seen.published });
            }}
          >
            Mark read
          </button>
        )}
      </div>
      {t.replies.map((r) => (
        <div class={`reply ${unread.has(r.id) ? 'unread' : ''}`}>
          <span class="who">{r.mine ? 'You' : (r.authorName ?? 'Someone')}</span> <span class="muted">{r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}</span>
          <div>{r.text}</div>
        </div>
      ))}
    </div>
  );
}

function NoteCard({ note, onPage }: { note: Note; onPage: boolean }) {
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const setState = async (state: Exclude<NoteState, 'published'>) => {
    if (state === 'draft') await store.startSession(note.page.key);
    await store.update(note.id, { state, lastError: null });
  };
  const reattach = async () => {
    const r = await toTab<{ error: string | null }>({ type: 'reattach', noteId: note.id });
    setMsg(r?.error ?? null);
  };
  const commentUrl = note.published?.webUrl ? new URL(note.published.webUrl, `https://${note.page.site}`).href : null;
  const jump = async () => {
    setMsg(null);
    // A published note opens Confluence's thread, which shows the replies.
    const seen = markThreadSeen(note);
    if (seen) void store.update(note.id, { published: seen.published });
    if (await toTab<boolean>({ type: 'jump-to', noteId: note.id })) return;
    // Not on the page (anymore): open the comment's own URL in the same tab.
    if (commentUrl) await openInTab(commentUrl);
    else setMsg('Could not find this note on the page.');
  };
  const unpublishIt = async () => {
    if (!confirm(unpublishQuestion(note))) return;
    setMsg(await act({ type: 'unpublish', noteId: note.id }, note.page.site));
  };
  const changed = note.state !== 'published' && note.target.exact !== note.target.originalExact;
  const lost = note.anchorStatus === 'orphaned' || note.anchorStatus === 'ambiguous';
  const publishBlocked = !note.publishable || lost;
  const blockedTitle = lost ? 'Re-attach the note first' : (note.unpublishableReason ?? '');
  return (
    <article class={`note ${note.state}`}>
      <header>
        <span class={`dot ${note.state}`} />
        <span class="state">{STATE_LABEL[note.state]}</span>
        <span class="spacer" />
        {note.state !== 'published' && <span class={`chip ${NEEDS_ATTENTION.has(note.anchorStatus) ? 'warn' : 'ok'}`}>{note.anchorStatus}</span>}
      </header>
      <button class="quote" title="Show on page" disabled={!onPage} onClick={() => void jump()}>
        “{note.target.exact.length > 200 ? note.target.exact.slice(0, 199) + '…' : note.target.exact}”
      </button>
      {changed && <div class="hint warn">Was: “{note.target.originalExact.slice(0, 160)}”</div>}
      {note.anchorStatus === 'orphaned' && <div class="hint warn">The text is gone. Select new text on the page and click Re-attach.</div>}
      {note.anchorStatus === 'ambiguous' && <div class="hint warn">The text appears several times. Select the right one and click Re-attach.</div>}
      {editing ? (
        note.state === 'published' ? (
          <InlineEditor
            note={note}
            onDone={() => setEditing(false)}
            onSave={(body) => act({ type: 'edit-published', noteId: note.id, body }, note.page.site)}
            saveLabel="Update comment"
            hint="Saving changes the comment in Confluence for everyone."
          />
        ) : (
          <InlineEditor note={note} onDone={() => setEditing(false)} />
        )
      ) : (
        <Body doc={note.body} />
      )}
      {note.state === 'published' && <Thread note={note} />}
      {note.lastError && <div class="hint err">{note.lastError}</div>}
      {msg && <div class="hint err">{msg}</div>}
      {!editing && (
        <div class="actions">
          {note.state === 'published' ? (
            <>
              {onPage ? (
                <button class="b" title="Scroll to the comment and open it" onClick={() => void jump()}>
                  Jump to comment
                </button>
              ) : (
                commentUrl && (
                  <button class="b" onClick={() => void openInTab(commentUrl)}>
                    Open comment
                  </button>
                )
              )}
              {note.published?.thread?.resolution !== 'deleted' && (
                <button class="b" title="Change the comment's text in Confluence" onClick={() => setEditing(true)}>
                  Edit comment
                </button>
              )}
              <span class="spacer" />
              <button class="b danger" title="Delete the comment in Confluence and keep the note as a private note" onClick={() => void unpublishIt()}>
                Unpublish
              </button>
            </>
          ) : (
            <>
              {onPage && (
                <button class="b" title="Scroll to the note and open it" onClick={() => void jump()}>
                  Jump to
                </button>
              )}
              <button class="b" onClick={() => setEditing(true)}>
                Edit
              </button>
              {note.state === 'private' ? (
                <button class="b" disabled={!note.publishable} title={note.unpublishableReason ?? ''} onClick={() => void setState('draft')}>
                  Make draft
                </button>
              ) : (
                <button class="b" onClick={() => void setState('private')}>
                  Make private
                </button>
              )}
              {onPage && (
                <button class="b" disabled={publishBlocked} title={blockedTitle} onClick={() => void toTab({ type: 'publish-now', noteId: note.id })}>
                  Publish now
                </button>
              )}
              {onPage && (NEEDS_ATTENTION.has(note.anchorStatus) || changed) && (
                <button class="b" title="Attach the note to the text currently selected on the page" onClick={() => void reattach()}>
                  Re-attach
                </button>
              )}
              {changed && (
                <button class="b" title="Accept the new text as the note's text" onClick={() => void store.update(note.id, { target: { ...note.target, originalExact: note.target.exact }, anchorStatus: 'anchored' })}>
                  Accept new text
                </button>
              )}
              <span class="spacer" />
              <button class="b danger" onClick={() => confirm('Delete this note?') && void store.delete(note.id)}>
                Delete
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function SessionPanel({ pageKey, drafts, session }: { pageKey: string; drafts: number; session: DraftSession | null }) {
  const [summary, setSummary] = useState(session?.summary ?? '');
  useEffect(() => setSummary(session?.summary ?? ''), [session?.summary]);
  if (!drafts && !session) return null;
  return (
    <section class="session">
      <div class="row">
        <span class="dot draft" />
        <strong>Draft comments</strong>
        <span class="muted">{drafts} pending</span>
        <span class="spacer" />
      </div>
      <textarea
        placeholder="Optional summary, posted as a page comment after the inline comments"
        value={summary}
        onInput={(e) => setSummary((e.target as HTMLTextAreaElement).value)}
        onBlur={() => void store.setSummary(pageKey, summary)}
      />
      <div class="row end">
        <button
          class="b"
          onClick={async () => {
            if (confirm('Turn all draft comments on this page back into private notes? Nothing is deleted.')) await store.discardSession(pageKey);
          }}
        >
          Discard
        </button>
        <button
          class="b primary"
          disabled={!drafts && !summary.trim()}
          onClick={async () => {
            await store.setSummary(pageKey, summary);
            await toTab({ type: 'open-submit' });
          }}
        >
          Submit {drafts || ''}
        </button>
      </div>
    </section>
  );
}

function SearchBox({ value, onInput, placeholder, query }: { value: string; onInput: (v: string) => void; placeholder: string; query: Query }) {
  return (
    <div class="searchbox">
      <input class="search" type="search" placeholder={placeholder} title={SEARCH_HELP} value={value} onInput={(e) => onInput((e.target as HTMLInputElement).value)} />
      {query.unknown.length > 0 && <div class="hint warn">Unknown filter: {query.unknown.join(', ')}. {SEARCH_HELP}</div>}
    </div>
  );
}

function PageView({ info, notes, sessions }: { info: PageInfo | null; notes: Note[]; sessions: DraftSession[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const query = useMemo(() => parseQuery(q), [q]);
  if (!info?.page) {
    return <p class="empty">{info?.unavailable ?? 'Open a Confluence page to see its notes.'}</p>;
  }
  const page = info.page;
  const mine = notes.filter((n) => n.page.key === page.key).sort((a, b) => a.target.start - b.target.start);
  const shown = mine.filter((n) => (filter === 'all' ? true : filter === 'attention' ? needsAttention(n) : n.state === filter) && matches(n, query));
  const count = (f: Filter) => mine.filter((n) => (f === 'all' ? true : f === 'attention' ? needsAttention(n) : n.state === f)).length;
  const session = sessions.find((s) => s.pageKey === page.key) ?? null;
  const drafts = count('draft');
  return (
    <>
      <h1 title={page.title}>{page.title}</h1>
      <SessionPanel pageKey={page.key} drafts={drafts} session={session} />
      <div class="filters">
        {(['all', 'private', 'draft', 'published', 'attention'] as Filter[]).map((f) => (
          <button class={`filter ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f === 'attention' ? 'Needs attention' : STATE_LABEL[f as NoteState]} <span>{count(f)}</span>
          </button>
        ))}
      </div>
      {mine.length > 0 && <SearchBox value={q} onInput={setQ} placeholder="Search notes on this page" query={query} />}
      {shown.length === 0 ? (
        <p class="empty">{mine.length ? 'No notes match.' : 'No notes on this page yet. Select text and click “Add note”.'}</p>
      ) : (
        shown.map((n) => <NoteCard key={n.id} note={n} onPage />)
      )}
    </>
  );
}

function Snippet({ note, query }: { note: Note; query: Query }) {
  return (
    <div class="snippet">
      {snippet(note, query).map((p) => (p.hit ? <mark>{p.text}</mark> : p.text))}
    </div>
  );
}

function AllView({ notes, currentKey }: { notes: Note[]; currentKey: string | null }) {
  const [q, setQ] = useState('');
  const query = useMemo(() => parseQuery(q), [q]);
  const searching = !isEmptyQuery(query);
  const groups = useMemo(() => {
    const m = new Map<string, Note[]>();
    for (const n of notes) {
      if (!matches(n, query)) continue;
      if (!m.has(n.page.key)) m.set(n.page.key, []);
      m.get(n.page.key)!.push(n);
    }
    return [...m.values()].sort((a, b) => Math.max(...b.map((n) => Date.parse(n.updatedAt))) - Math.max(...a.map((n) => Date.parse(n.updatedAt))));
  }, [notes, query]);
  const hits = groups.reduce((a, g) => a + g.length, 0);
  return (
    <>
      <SearchBox value={q} onInput={setQ} placeholder="Search all notes, e.g. solver is:draft" query={query} />
      {searching && groups.length > 0 && (
        <p class="hint">
          {hits} note{hits === 1 ? '' : 's'} on {groups.length} page{groups.length === 1 ? '' : 's'}
        </p>
      )}
      {groups.length === 0 && <p class="empty">{searching ? 'No notes match.' : 'No notes yet.'}</p>}
      {groups.map((g) => {
        const p = g[0]!.page;
        return (
          <section class="group">
            <button class="page-link" onClick={() => void openInTab(p.url)} title={p.url}>
              {p.title || p.url}
            </button>
            <ul>
              {g
                .sort((a, b) => a.target.start - b.target.start)
                .map((n) => (
                  <li
                    class="jump"
                    title={n.page.key === currentKey ? 'Jump to this note' : 'Open the page'}
                    onClick={() => void (n.page.key === currentKey ? toTab({ type: 'jump-to', noteId: n.id }) : openInTab(p.url))}
                  >
                    <div class="line">
                      <span class={`dot ${n.state}`} title={STATE_LABEL[n.state]} />
                      <span class="q">“{n.target.exact.slice(0, 80)}”</span>
                      {needsAttention(n) && <span class="chip warn">{n.anchorStatus}</span>}
                      {n.published?.thread?.resolution === 'resolved' && <span class="chip ok">resolved</span>}
                      {unreadReplies(n).length > 0 && <span class="chip new">{unreadReplies(n).length} new</span>}
                    </div>
                    {searching && <Snippet note={n} query={query} />}
                  </li>
                ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'never';
}

function SyncSettings({ tick, info }: { tick: number; info: PageInfo | null }) {
  const [config, setConfig] = useState<SyncConfig | null>(null);
  const [state, setState] = useState<SyncState | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void readSyncConfig(browser.storage.local).then(setConfig);
    void readSyncState(browser.storage.local).then(setState);
  }, [tick]);
  const run = async (msgType: 'sync-setup' | 'sync-now', site?: string) => {
    setBusy(true);
    setMsg(null);
    setMsg(await act({ type: msgType }, site));
    setBusy(false);
  };
  const site = info?.page?.site ?? null;
  return (
    <section class="settings">
      <h2>Sync between machines</h2>
      {!config ? (
        <>
          <p class="muted">
            Keeps your notes in a page titled “margin-notes sync” in your Confluence personal space, restricted to you. Set it up on every machine with the same
            Atlassian account; the second machine finds the existing page and merges.
          </p>
          <div class="row end">
            <button class="b primary" disabled={busy || !site} title={site ? '' : 'Open a Confluence page first'} onClick={() => void run('sync-setup')}>
              {site ? `Set up sync on ${site}` : 'Open a Confluence page to set up sync'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p class="muted">
            Syncing through{' '}
            {config.pageUrl ? (
              <a href={`https://${config.host}${config.pageUrl}`} target="_blank" rel="noreferrer">
                a page in your personal space
              </a>
            ) : (
              'a page in your personal space'
            )}{' '}
            on {config.host}. Sync runs while a page on that site is open: on load, a few seconds after changes and every 5 minutes.
          </p>
          <p class="muted">
            Last sync: {when(state?.lastSyncAt ?? null)}
            {state?.lastResult ? ` (${state.lastResult})` : ''}
          </p>
          {state?.lastError && <p class="hint err">Last attempt {when(state.lastAttemptAt)} failed: {state.lastError}</p>}
          <div class="row end">
            <button
              class="b"
              disabled={busy}
              title="Stops syncing on this machine. The sync page and its notes stay in Confluence."
              onClick={async () => {
                if (!confirm('Stop syncing on this machine? Your notes stay here and on the sync page.')) return;
                await browser.storage.local.remove([SYNC_CONFIG_KEY, SYNC_STATE_KEY]);
              }}
            >
              Turn off
            </button>
            <button class="b primary" disabled={busy} onClick={() => void run('sync-now', config.host)}>
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
        </>
      )}
      {msg && <p class="hint err">{msg}</p>}
    </section>
  );
}

function SettingsView({ tick, info }: { tick: number; info: PageInfo | null }) {
  const [s, setS] = useState<Settings>({ apiEmail: '', apiToken: '' });
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    void browser.storage.local.get(SETTINGS_KEY).then((r) => r[SETTINGS_KEY] && setS(r[SETTINGS_KEY] as Settings));
  }, []);
  const exportNotes = async () => {
    const file = await store.exportAll();
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `margin-notes-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setMsg(`Exported ${file.notes.length} notes.`);
  };
  const importNotes = async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const n = await store.importAll(JSON.parse(await f.text()) as ExportFile);
      setMsg(`Imported ${n} notes (newer local copies were kept).`);
    } catch (err) {
      setMsg(`Import failed: ${(err as Error).message}`);
    }
  };
  return (
    <>
      <SyncSettings tick={tick} info={info} />
      <section class="settings">
        <h2>Backup</h2>
        <p class="muted">Notes live in this browser (and on the sync page, if sync is on). Uninstalling the extension deletes the local copy, so export regularly.</p>
        <div class="row">
          <button class="b" onClick={exportNotes}>
            Export JSON
          </button>
          <label class="b">
            Import JSON
            <input type="file" accept="application/json" hidden onChange={importNotes} />
          </label>
        </div>
      </section>
      <section class="settings">
        <h2>API token fallback</h2>
        <p class="muted">
          Publishing uses your Confluence session. If that is ever rejected, an Atlassian API token is tried instead. Leave empty unless publishing fails with 401 or 403.
        </p>
        <input type="email" placeholder="Atlassian account email" value={s.apiEmail} onInput={(e) => setS({ ...s, apiEmail: (e.target as HTMLInputElement).value })} />
        <input type="password" placeholder="API token" value={s.apiToken} onInput={(e) => setS({ ...s, apiToken: (e.target as HTMLInputElement).value })} />
        <div class="row end">
          <button
            class="b primary"
            onClick={async () => {
              await browser.storage.local.set({ [SETTINGS_KEY]: s });
              setMsg('Saved.');
            }}
          >
            Save
          </button>
        </div>
      </section>
      {msg && <p class="hint">{msg}</p>}
    </>
  );
}

function App() {
  const tick = useStorageTick();
  const [view, setView] = useState<View>('page');
  const [notes, setNotes] = useState<Note[]>([]);
  const [sessions, setSessions] = useState<DraftSession[]>([]);
  const [info] = usePageInfo(tick);
  const unread = notes.filter((n) => unreadReplies(n).length > 0).length;
  useEffect(() => {
    void store.allNotes().then(setNotes);
    void store.allSessions().then(setSessions);
  }, [tick]);
  return (
    <div class="mn">
      <nav>
        {(['page', 'all', 'settings'] as View[]).map((v) => (
          <button class={view === v ? 'on' : ''} onClick={() => setView(v)}>
            {v === 'page' ? 'This page' : v === 'all' ? `All notes (${notes.length})` : 'Settings'}
            {v === 'all' && unread > 0 && <span class="chip new">{unread} new</span>}
          </button>
        ))}
      </nav>
      <main>
        {view === 'page' && <PageView info={info} notes={notes} sessions={sessions} />}
        {view === 'all' && <AllView notes={notes} currentKey={info?.page?.key ?? null} />}
        {view === 'settings' && <SettingsView tick={tick} info={info} />}
      </main>
    </div>
  );
}

const style = document.createElement('style');
style.textContent = EDITOR_CSS;
document.head.append(style);
render(<App />, document.getElementById('app')!);
