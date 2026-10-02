// Confluence Cloud REST v2 client. Runs in the content script on the
// Confluence tab, so relative URLs are same-origin requests carrying the
// user's session. An API token from the settings is used as a fallback when
// the session path is rejected (401/403).

import type { AdfDoc, AdfNode } from '../core/model';

export interface ApiTokenAuth {
  email: string;
  token: string;
}

export class ConfluenceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: string,
  ) {
    super(message);
  }
}

export interface PageSnapshot {
  pageId: string;
  version: number;
  title: string;
  adf: AdfNode;
}

export interface InlineCommentProperties {
  textSelection: string;
  textSelectionMatchCount: number;
  textSelectionMatchIndex: number;
}

export interface CreatedComment {
  id: string;
  inlineMarkerRef: string | null;
  inlineOriginalSelection: string | null;
  webUrl: string | null;
}

export interface ExistingInlineComment {
  id: string;
  inlineMarkerRef: string | null;
  inlineOriginalSelection: string | null;
  authorId: string | null;
  createdAt: string | null;
  bodyText: string;
  webUrl: string | null;
  resolutionStatus: string | null;
  version: number | null;
}

export interface CurrentUser {
  accountId: string;
  displayName: string;
  personalSpace: { id: string; key: string } | null;
}

export interface StoragePage {
  id: string;
  title: string;
  version: number;
  /** Storage format (XHTML) body. */
  value: string;
  webUrl: string | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errorMessage(status: number, body: string): string {
  try {
    const j = JSON.parse(body);
    const first = j.errors?.[0];
    const detail = first?.title || first?.detail || j.message || j.title;
    if (detail) return `${status}: ${detail}`;
  } catch {
    // not JSON
  }
  return `${status}: ${body.slice(0, 200) || 'request failed'}`;
}

export class ConfluenceClient {
  constructor(
    private readonly getAuth: () => Promise<ApiTokenAuth | null> = async () => null,
    private readonly doFetch: FetchLike = (i, init) => fetch(i, init),
  ) {}

  private async request(path: string, init: RequestInit = {}, retry = 0): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Atlassian-Token': 'no-check',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    };
    let res = await this.doFetch(path, { ...init, credentials: 'same-origin', headers });
    if (res.status === 401 || res.status === 403) {
      const auth = await this.getAuth();
      if (auth) {
        res = await this.doFetch(path, {
          ...init,
          credentials: 'omit',
          headers: { ...headers, Authorization: 'Basic ' + btoa(`${auth.email}:${auth.token}`) },
        });
      }
    }
    // 429 means the request was not processed, so retrying is safe even for POST.
    if (res.status === 429 && retry < MAX_RETRIES) {
      const after = Number(res.headers.get('Retry-After'));
      const base = Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * 2 ** retry;
      await sleep(Math.min(30_000, base * (0.7 + Math.random() * 0.6)));
      return this.request(path, init, retry + 1);
    }
    if (!res.ok) {
      const body = await res.text();
      throw new ConfluenceError(res.status, errorMessage(res.status, body), body);
    }
    return res;
  }

  async getPage(pageId: string, version?: number): Promise<PageSnapshot> {
    const q = new URLSearchParams({ 'body-format': 'atlas_doc_format' });
    if (version !== undefined) q.set('version', String(version));
    const res = await this.request(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}?${q}`);
    const j = await res.json();
    const raw = j.body?.atlas_doc_format?.value;
    if (typeof raw !== 'string') throw new ConfluenceError(500, 'Page body missing in response', '');
    return { pageId: String(j.id), version: Number(j.version?.number), title: String(j.title ?? ''), adf: JSON.parse(raw) };
  }

  async createInlineComment(pageId: string, body: AdfDoc, props: InlineCommentProperties): Promise<CreatedComment> {
    const res = await this.request('/wiki/api/v2/inline-comments', {
      method: 'POST',
      body: JSON.stringify({
        pageId,
        body: { representation: 'atlas_doc_format', value: JSON.stringify(body) },
        inlineCommentProperties: props,
      }),
    });
    const j = await res.json();
    return {
      id: String(j.id),
      inlineMarkerRef: j.properties?.inlineMarkerRef ?? null,
      inlineOriginalSelection: j.properties?.inlineOriginalSelection ?? null,
      webUrl: j._links?.webui ? (j._links.base ?? '/wiki') + j._links.webui : null,
    };
  }

  async createFooterComment(pageId: string, body: AdfDoc): Promise<CreatedComment> {
    const res = await this.request('/wiki/api/v2/footer-comments', {
      method: 'POST',
      body: JSON.stringify({ pageId, body: { representation: 'atlas_doc_format', value: JSON.stringify(body) } }),
    });
    const j = await res.json();
    return {
      id: String(j.id),
      inlineMarkerRef: null,
      inlineOriginalSelection: null,
      webUrl: j._links?.webui ? (j._links.base ?? '/wiki') + j._links.webui : null,
    };
  }

  async getInlineComment(id: string): Promise<ExistingInlineComment> {
    const res = await this.request(`/wiki/api/v2/inline-comments/${encodeURIComponent(id)}?body-format=atlas_doc_format`);
    return toExisting(await res.json());
  }

  /** Open inline comments on a page, used to avoid duplicates after an uncertain failure. */
  async listInlineComments(pageId: string): Promise<ExistingInlineComment[]> {
    const out: ExistingInlineComment[] = [];
    let next: string | null =
      `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/inline-comments?body-format=atlas_doc_format&limit=250`;
    while (next) {
      const res = await this.request(next);
      const j = await res.json();
      for (const c of j.results ?? []) out.push(toExisting(c));
      const link: string | undefined = j._links?.next;
      next = link ? (link.startsWith('/wiki') ? link : '/wiki' + link) : null;
    }
    return out;
  }

  /** Replies to an inline comment, oldest first. */
  async listReplies(commentId: string): Promise<ExistingInlineComment[]> {
    const out: ExistingInlineComment[] = [];
    let next: string | null =
      `/wiki/api/v2/inline-comments/${encodeURIComponent(commentId)}/children?body-format=atlas_doc_format&limit=100`;
    while (next) {
      const res = await this.request(next);
      const j = await res.json();
      for (const c of j.results ?? []) out.push(toExisting(c));
      const link: string | undefined = j._links?.next;
      next = link ? (link.startsWith('/wiki') ? link : '/wiki' + link) : null;
    }
    return out.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  }

  /** Replaces the body of an inline comment. `version` is the comment's current version number. */
  async updateInlineComment(commentId: string, version: number, body: AdfDoc): Promise<void> {
    await this.request(`/wiki/api/v2/inline-comments/${encodeURIComponent(commentId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        version: { number: version + 1 },
        body: { representation: 'atlas_doc_format', value: JSON.stringify(body) },
      }),
    });
  }

  /** Permanently deletes an inline comment. */
  async deleteInlineComment(commentId: string): Promise<void> {
    await this.request(`/wiki/api/v2/inline-comments/${encodeURIComponent(commentId)}`, { method: 'DELETE' });
  }

  /** Display names by account id. Unknown ids are left out. */
  async displayNames(accountIds: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!accountIds.length) return out;
    const res = await this.request('/wiki/api/v2/users-bulk', { method: 'POST', body: JSON.stringify({ accountIds }) });
    const j = await res.json();
    for (const u of j.results ?? []) {
      const name = u.displayName || u.publicName;
      if (u.accountId && name) out.set(String(u.accountId), String(name));
    }
    return out;
  }

  async currentUser(): Promise<CurrentUser> {
    const res = await this.request('/wiki/rest/api/user/current?expand=personalSpace');
    const j = await res.json();
    const ps = j.personalSpace;
    return {
      accountId: String(j.accountId),
      displayName: String(j.displayName ?? j.publicName ?? ''),
      personalSpace: ps?.id ? { id: String(ps.id), key: String(ps.key) } : null,
    };
  }

  async findPageByTitle(spaceId: string, title: string): Promise<{ id: string } | null> {
    const q = new URLSearchParams({ 'space-id': spaceId, title, status: 'current', limit: '5' });
    const res = await this.request(`/wiki/api/v2/pages?${q}`);
    const j = await res.json();
    const hit = (j.results ?? []).find((p: any) => p.title === title);
    return hit ? { id: String(hit.id) } : null;
  }

  /** Creates a page only its creator can see and edit. */
  async createPrivatePage(spaceId: string, title: string, storage: string): Promise<{ id: string }> {
    const res = await this.request('/wiki/api/v2/pages?private=true', {
      method: 'POST',
      body: JSON.stringify({ spaceId, status: 'current', title, body: { representation: 'storage', value: storage } }),
    });
    const j = await res.json();
    return { id: String(j.id) };
  }

  async getStoragePage(pageId: string): Promise<StoragePage> {
    const res = await this.request(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}?body-format=storage`);
    const j = await res.json();
    return {
      id: String(j.id),
      title: String(j.title ?? ''),
      version: Number(j.version?.number),
      value: String(j.body?.storage?.value ?? ''),
      webUrl: j._links?.webui ? '/wiki' + j._links.webui : null,
    };
  }

  /** Writes a new page version. Fails with 409 when `version` is no longer the latest. */
  async updateStoragePage(pageId: string, title: string, version: number, storage: string, message: string): Promise<void> {
    await this.request(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        id: pageId,
        status: 'current',
        title,
        body: { representation: 'storage', value: storage },
        version: { number: version + 1, message },
      }),
    });
  }

  async readRestriction(pageId: string): Promise<PageReadRestriction> {
    const res = await this.request(`/wiki/rest/api/content/${encodeURIComponent(pageId)}/restriction/byOperation/read`);
    const j = await res.json();
    return {
      userIds: (j.restrictions?.user?.results ?? []).map((u: any) => String(u.accountId)),
      groups: (j.restrictions?.group?.results ?? []).length,
    };
  }

  /** Restricts viewing and editing of a page to one account. */
  async restrictToUser(pageId: string, accountId: string): Promise<void> {
    const user = [{ type: 'known', accountId }];
    await this.request(`/wiki/rest/api/content/${encodeURIComponent(pageId)}/restriction`, {
      method: 'PUT',
      body: JSON.stringify([
        { operation: 'read', restrictions: { user, group: [] } },
        { operation: 'update', restrictions: { user, group: [] } },
      ]),
    });
  }
}

export interface PageReadRestriction {
  userIds: string[];
  groups: number;
}

function adfPlain(n: AdfNode): string {
  if (n.type === 'text') return n.text ?? '';
  return (n.content ?? []).map(adfPlain).join(n.type === 'doc' ? '\n' : '');
}

function toExisting(j: any): ExistingInlineComment {
  let bodyText = '';
  try {
    const raw = j.body?.atlas_doc_format?.value;
    if (typeof raw === 'string') bodyText = adfPlain(JSON.parse(raw));
  } catch {
    // ignore
  }
  return {
    id: String(j.id),
    inlineMarkerRef: j.properties?.inlineMarkerRef ?? null,
    inlineOriginalSelection: j.properties?.inlineOriginalSelection ?? null,
    authorId: j.version?.authorId ?? null,
    createdAt: j.version?.createdAt ?? null,
    bodyText,
    webUrl: j._links?.webui ? '/wiki' + j._links.webui : null,
    resolutionStatus: j.resolutionStatus ?? null,
    version: Number.isFinite(Number(j.version?.number)) ? Number(j.version.number) : null,
  };
}
