import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PageInfo, Settings, ToContent } from '../../src/core/messages';
import { SETTINGS_KEY } from '../../src/core/messages';
import type { DraftSession, Note, NoteState } from '../../src/core/model';
import { adfToFragment } from '../../src/core/rich-text';
import type { AdfDoc } from '../../src/core/model';
import { NoteStore, type ExportFile } from '../../src/core/store';
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

function InlineEditor({ note, onDone }: { note: Note; onDone: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  useEffect(() => {
    const e = createEditor(document, note.body);
    editor.current = e;
    host.current!.append(e.el);
    e.onSubmit(save);
    e.focus();
    return () => e.el.remove();
  }, []);
  const save = async () => {
    if (editor.current && !editor.current.isEmpty()) await store.update(note.id, { body: editor.current.getDoc() });
    onDone();
  };
  return (
    <div class="editing">
      <div ref={host} />
      <div class="row end">
        <button class="b" onClick={onDone}>
          Cancel
        </button>
        <button class="b primary" onClick={save}>
          Save
        </button>
      </div>
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
    if (await toTab<boolean>({ type: 'jump-to', noteId: note.id })) return;
    // Not on the page (anymore): open the comment's own URL in the same tab.
    if (commentUrl) await openInTab(commentUrl);
    else setMsg('Could not find this note on the page.');
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
        <InlineEditor note={note} onDone={() => setEditing(false)} />
      ) : (
        <Body doc={note.body} />
      )}
      {note.lastError && <div class="hint err">{note.lastError}</div>}
      {msg && <div class="hint err">{msg}</div>}
      {!editing && (
        <div class="actions">
          {note.state === 'published' ? (
            onPage ? (
              <button class="b" title="Scroll to the comment and open it" onClick={() => void jump()}>
                Jump to comment
              </button>
            ) : (
              commentUrl && (
                <button class="b" onClick={() => void openInTab(commentUrl)}>
                  Open comment
                </button>
              )
            )
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

function PageView({ info, notes, sessions }: { info: PageInfo | null; notes: Note[]; sessions: DraftSession[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  if (!info?.page) {
    return <p class="empty">{info?.unavailable ?? 'Open a Confluence page to see its notes.'}</p>;
  }
  const page = info.page;
  const mine = notes.filter((n) => n.page.key === page.key).sort((a, b) => a.target.start - b.target.start);
  const shown = mine.filter((n) => (filter === 'all' ? true : filter === 'attention' ? needsAttention(n) : n.state === filter));
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
      {shown.length === 0 ? (
        <p class="empty">{mine.length ? 'No notes match this filter.' : 'No notes on this page yet. Select text and click “Add note”.'}</p>
      ) : (
        shown.map((n) => <NoteCard key={n.id} note={n} onPage />)
      )}
    </>
  );
}

function AllView({ notes, currentKey }: { notes: Note[]; currentKey: string | null }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const m = new Map<string, Note[]>();
    const needle = q.trim().toLowerCase();
    for (const n of notes) {
      if (needle && !(n.target.exact + ' ' + JSON.stringify(n.body) + ' ' + n.page.title).toLowerCase().includes(needle)) continue;
      if (!m.has(n.page.key)) m.set(n.page.key, []);
      m.get(n.page.key)!.push(n);
    }
    return [...m.values()].sort((a, b) => Math.max(...b.map((n) => Date.parse(n.updatedAt))) - Math.max(...a.map((n) => Date.parse(n.updatedAt))));
  }, [notes, q]);
  return (
    <>
      <input class="search" type="search" placeholder="Search all notes" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      {groups.length === 0 && <p class="empty">No notes yet.</p>}
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
                    <span class={`dot ${n.state}`} title={STATE_LABEL[n.state]} />
                    <span class="q">“{n.target.exact.slice(0, 80)}”</span>
                    {needsAttention(n) && <span class="chip warn">{n.anchorStatus}</span>}
                  </li>
                ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function SettingsView() {
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
      <section class="settings">
        <h2>Backup</h2>
        <p class="muted">Notes live only in this browser and are deleted if the extension is uninstalled. Export regularly.</p>
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
          </button>
        ))}
      </nav>
      <main>
        {view === 'page' && <PageView info={info} notes={notes} sessions={sessions} />}
        {view === 'all' && <AllView notes={notes} currentKey={info?.page?.key ?? null} />}
        {view === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}

const style = document.createElement('style');
style.textContent = EDITOR_CSS;
document.head.append(style);
render(<App />, document.getElementById('app')!);
