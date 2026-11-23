'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Activity, ArrowUp, AudioLines, BarChart3, BookOpen, Braces, Check, ChevronDown, CircleHelp, Database,
  FileText, FlaskConical, Layers3, Link2, LockKeyhole, LogOut, MessageSquare, Plus, RefreshCw, Search,
  Settings2, Sparkles, Trash2, Upload, Zap } from 'lucide-react';

const sections = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'search', label: 'Search', icon: Search },
  { id: 'collections', label: 'Collections', icon: Layers3 },
  { id: 'evaluation', label: 'Evaluation', icon: FlaskConical },
  { id: 'usage', label: 'Usage', icon: BarChart3 },
] as const;
type Section = typeof sections[number]['id'];
type Session = { tenantId: string; admin: boolean; models: string[] };
type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
type Usage = { provider: string; model: string; tokens: number | null; cost: number | null };
type Result = { chunkId: string; documentId: string; sectionPath: string; page?: number; text: string; score: number;
  source: { title: string; url?: string; path?: string } };
type ResponseData = { answer?: string | null; citations?: (Result & { id: number })[]; results: Result[]; usage: Usage[]; latencyMs: number; scoreType: string };
type Collection = { name: string; documents: number; chunks: number; indexed: number };
type DocumentRow = { _id: string; collectionId: string; source: Result['source']; chunkCount: number; status: string; updatedAt: string };
type UsageRow = Usage & { calls: number; unreportedTokens: number; unreportedCost: number };
type EvalRow = { _id: string; timestamp: string; config: { label?: string }; metrics: Record<string, number | null> };

const prompts = [
  { icon: Zap, title: 'Get started', question: 'How do I build my first NitroStack MCP server?' },
  { icon: Braces, title: 'Explore the SDK', question: 'How do I register a tool in NitroStack?' },
  { icon: LockKeyhole, title: 'Set up authentication', question: 'How do guards and authentication work in NitroStack?' },
];

const errorText = (error: unknown) => error instanceof Error ? error.message : 'The request failed.';
const money = (number: number | null) => number === null ? '—' : '$' + number.toFixed(6);
const settingsKey = 'nitrostack-workspace-key';

async function call<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', 'Bearer ' + token);
  if (typeof init?.body === 'string') headers.set('Content-Type', 'application/json');
  const response = await fetch('/api/' + path, { ...init, headers, cache: 'no-store' });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message || `Request failed (HTTP ${response.status}).`);
  return data as T;
}

function Empty({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="empty"><div className="emptyIcon">{icon}</div><h3>{title}</h3><p>{children}</p></div>;
}

function SourceCard({ item, index, score }: { item: Result; index: number; score: boolean }) {
  return <details className="source" id={'citation-' + index}>
    <summary><span className="citation">{index}</span><span className="sourceInfo"><strong>{item.source.title}</strong>
      <small>{[item.sectionPath, item.page && 'Page ' + item.page].filter(Boolean).join(' · ') || item.source.path || 'Source passage'}</small>
    </span>{score && <span className="metric">{item.score.toFixed(4)}</span>}<ChevronDown size={16}/></summary>
    <div className="sourceBody"><p>{item.text}</p>{item.source.url && <a href={item.source.url} target="_blank" rel="noreferrer"><Link2 size={14}/> Open source</a>}</div>
  </details>;
}

function QueryPanel({ chat, api, ready, models, collections, onConnect }: {
  chat: boolean; api: Api; ready: boolean; models: string[]; collections: Collection[]; onConnect: () => void;
}) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [result, setResult] = useState<ResponseData>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('hybrid');
  const [rerank, setRerank] = useState(false);
  const [rerankModel, setRerankModel] = useState('rerank-3-lite');
  const [model, setModel] = useState('');
  const [collection, setCollection] = useState('');
  const [exact, setExact] = useState(false);

  async function submit(question: string) {
    setQuery(question);
    if (!ready) { onConnect(); return; }
    if (!question.trim() || busy) return;
    setSubmitted(question.trim());
    setError('');
    setResult(undefined);
    setBusy(true);
    try {
      setResult(await api<ResponseData>(chat ? 'answer' : 'search', {
        method: 'POST', body: JSON.stringify({ query: question, mode, rerank, rerankModel, exact, collection, model: model || undefined }),
      }));
    } catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }

  const citations = result?.citations ?? [];
  return <>
    <div className="heading">
      <span className="sectionLabel"><span className="signal"/>{chat ? 'KNOWLEDGE WORKSPACE' : 'RETRIEVAL WORKSPACE'}</span>
      <h1>{chat ? 'Knowledge Chat' : 'Document Search'}</h1>
      <p>{chat ? 'Ask a question and get an answer grounded in your workspace documents.' : 'Inspect ranked passages, scores, and original sources from your collections.'}</p>
    </div>
    {chat && !submitted && <div className="welcome">
      <div className="halo"><div/><div/><div/><Sparkles size={30} strokeWidth={1.5}/></div>
      <h2>What would you like to know?</h2>
      <p>Explore NitroStack documentation, implementation patterns, and the MCP SDK.</p>
      <div className="prompts">{prompts.map(({ icon: Icon, title, question }) =>
        <button key={title} className="prompt" onClick={() => void submit(question)}><Icon size={17}/><span>{title}</span></button>)}</div>
    </div>}
    <form className="composer" onSubmit={event => { event.preventDefault(); void submit(query); }}>
      <label className="srOnly" htmlFor="question">{chat ? 'Ask a question' : 'Search query'}</label>
      <textarea id="question" value={query} maxLength={2000} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(query); } }}
        placeholder={chat ? 'Ask anything about your knowledge base…' : 'Search for a concept, function, or error code…'} rows={2}/>
      <div className="composerTools">
        <div className="controls">
          <label className="selectChip"><SlidersIcon/><span className="srOnly">Retrieval mode</span><select value={mode} onChange={event => setMode(event.target.value)}>
            <option value="hybrid">Hybrid</option><option value="vector">Vector</option></select><ChevronDown size={12}/></label>
          <label className="toggle"><input type="checkbox" checked={rerank} onChange={event => setRerank(event.target.checked)}/><span/>Rerank</label>
          {rerank && <label className="selectChip"><span className="srOnly">Rerank model</span><select value={rerankModel} onChange={event => setRerankModel(event.target.value)}>
            <option>rerank-3-lite</option><option>rerank-3</option></select><ChevronDown size={12}/></label>}
          {!chat && <label className="toggle"><input type="checkbox" checked={exact} onChange={event => setExact(event.target.checked)}/><span/>Exact</label>}
          {collections.length > 0 && <label className="selectChip"><Database size={13}/><span className="srOnly">Collection</span><select value={collection} onChange={event => setCollection(event.target.value)}>
            <option value="">All collections</option>{collections.map(item => <option key={item.name}>{item.name}</option>)}</select><ChevronDown size={12}/></label>}
          {chat && models.length > 1 && <label className="selectChip"><span className="srOnly">Answer model</span><select value={model || models[0]} onChange={event => setModel(event.target.value)}>
            {models.map(item => <option key={item}>{item}</option>)}</select><ChevronDown size={12}/></label>}
        </div>
        <button className="send" type="submit" disabled={!query.trim() || busy} aria-label={chat ? 'Send question' : 'Run search'}>{chat ? <ArrowUp size={20}/> : <Search size={19}/>}</button>
      </div>
    </form>
    {!ready && <p className="composerNote"><LockKeyhole size={13}/> <button onClick={onConnect}>Connect your workspace</button> to query your documents.</p>}
    {busy && <p className="notice" role="status"><RefreshCw size={16} className="spin"/> {chat ? 'Retrieving evidence and preparing an answer…' : 'Searching your collections…'}</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {result && <div className="results">
      <div className="resultsHeading"><h2>{chat ? 'Answer' : 'Ranked passages'}</h2><span className="metric"><Activity size={14}/> {result.latencyMs} ms</span></div>
      {chat && <div className="answer"><h3>{submitted}</h3><p>{result.answer ? result.answer.split(/(\[\d+\])/).map((part, i) => {
        const match = /^\[(\d+)\]$/.exec(part);
        return match ? <a key={i} className="inlineCitation" href={'#citation-' + match[1]} onClick={() => {
          const source = document.getElementById('citation-' + match[1]);
          if (source instanceof HTMLDetailsElement) source.open = true;
        }}>{part}</a> : part;
      }) : 'No supported answer was found in the available documents.'}</p></div>}
      <div className="runMeta"><span>{result.results.length} retrieved · {result.scoreType.toUpperCase()}</span>
        <span>{result.usage.reduce((total, item) => total + (item.tokens ?? 0), 0).toLocaleString()} reported tokens</span>
        <span>{money(result.usage.every(item => item.cost === null) ? null : result.usage.reduce((total, item) => total + (item.cost ?? 0), 0))} reported / estimated</span>
      </div>
      {chat && citations.length > 0 && <h3 className="sourceHeading">Citations</h3>}
      {(chat && citations.length ? citations : result.results).map((item, i) =>
        <SourceCard key={item.chunkId} item={item} index={'id' in item ? Number(item.id) : i + 1} score={!chat}/>)}
      {!chat && !result.results.length && <Empty icon={<Search size={23}/>} title="No matching passages">Try another query or search all collections.</Empty>}
    </div>}
  </>;
}

function SlidersIcon() { return <Settings2 size={14}/>; }

function CollectionsPanel({ api, session, onChanged }: { api: Api; session: Session; onChanged: () => void }) {
  const [docs, setDocs] = useState<DocumentRow[]>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [form, setForm] = useState(false);
  const [inputMode, setInputMode] = useState('url');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState('');
  const refresh = useCallback(async () => {
    try {
      const data = await api<{ documents: DocumentRow[] }>('documents');
      setDocs(data.documents);
    } catch (failure) { setError(errorText(failure)); }
  }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);
  async function operation(action: () => Promise<string>) {
    setBusy(true); setError(''); setMessage('');
    try { setMessage(await action()); await refresh(); onChanged(); }
    catch (failure) { setError(errorText(failure)); }
    finally { setBusy(false); }
  }
  function ingestForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = new FormData(event.currentTarget);
    const roles = String(body.get('visibility') || '').split(',').map(role => role.trim()).filter(Boolean);
    void operation(async () => {
      const response = await api<{ changed: boolean; status: string }>('ingest', { method: 'POST',
        body: inputMode === 'file' ? body : JSON.stringify({ collection: body.get('collection'), url: body.get('url'),
          visibility: roles.length ? roles : undefined }),
      });
      setForm(false);
      return response.changed ? 'Document saved. Indexing runs asynchronously.' : `Document is unchanged (${response.status}).`;
    });
  }
  return <>
    <PageHeading title="Collections" description="Add source documents and track when their passages become searchable.">
      {session.admin && <button className="primary" onClick={() => setForm(!form)}><Plus size={17}/> Add document</button>}
    </PageHeading>
    {form && <form className="panel ingest" onSubmit={ingestForm}><h2>Ingest a document</h2>
      <div className="formGrid"><label>Collection<input name="collection" required defaultValue="nitrostack-docs" pattern="[a-z0-9][a-z0-9-]{0,59}"/></label>
      <label>Source type<select value={inputMode} onChange={event => setInputMode(event.target.value)}><option value="url">NitroStack docs URL</option><option value="file">File upload</option></select></label></div>
      {inputMode === 'url' ? <label>Documentation URL<input name="url" type="url" required placeholder="https://docs.nitrostack.ai/docs/…"/></label> :
        <label>Document<input required type="file" name="file" accept=".md,.markdown,.pdf,.html,.htm,.txt"/></label>}
      <label>Visible to roles<input name="visibility" placeholder="tenant (everyone in this workspace)"/></label>
      <button type="submit" className="primary" disabled={busy}><Upload size={16}/> {busy ? 'Saving…' : 'Ingest document'}</button></form>}
    {error && <p className="error" role="alert">{error}</p>}{message && <p className="notice" role="status"><Check size={17}/> {message}</p>}
    {docs?.length ? <div className="tableWrap"><table><thead><tr><th>Document</th><th>Collection</th><th>Passages</th><th>Index status</th><th>Actions</th></tr></thead>
      <tbody>{docs.map(doc => <tr key={doc._id}><td><strong>{doc.source.title}</strong><small>{new Date(doc.updatedAt).toLocaleDateString()}</small></td>
        <td>{doc.collectionId}</td><td>{doc.chunkCount}</td><td><span className={'status ' + doc.status}>{doc.status}</span></td>
        <td><div className="rowActions"><button className="iconButton" aria-label={'Check status for ' + doc.source.title} title="Check index status" disabled={busy} onClick={() => void operation(async () => {
          const state = await api<{ status: string }>(`documents/${doc._id}/status`);
          return `Index status is ${state.status}.`;
        })}><RefreshCw size={16}/></button>
        {session.admin && (confirm === doc._id ? <><button className="danger" disabled={busy} onClick={() => void operation(async () => {
          await api(`documents/${doc._id}`, { method: 'DELETE' }); setConfirm(''); return 'Document removed.';
        })}>Confirm delete</button><button className="secondary small" onClick={() => setConfirm('')}>Cancel</button></> :
          <button className="iconButton" aria-label={'Delete ' + doc.source.title} title="Delete document" onClick={() => setConfirm(doc._id)}><Trash2 size={16}/></button>)}</div></td>
      </tr>)}</tbody></table></div> : !error && <Empty icon={<FileText size={24}/>} title={docs ? 'No documents yet' : 'Loading documents'}>{docs ? 'Ingest a documentation page or upload a file to get started.' : 'Reading the current collection state from Atlas.'}</Empty>}
  </>;
}

function PageHeading({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className="heading withAction"><div><span className="sectionLabel"><span className="signal"/>KNOWLEDGE WORKSPACE</span><h1>{title}</h1><p>{description}</p></div>{children}</div>;
}

function Reports({ api, evaluation }: { api: Api; evaluation: boolean }) {
  const [days, setDays] = useState(30);
  const [runs, setRuns] = useState<EvalRow[]>();
  const [usage, setUsage] = useState<UsageRow[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    const promise = evaluation ? api<{ runs: EvalRow[] }>('eval/runs').then(data => { if (current) setRuns(data.runs); }) :
      api<{ usage: UsageRow[] }>('usage?days=' + days).then(data => { if (current) setUsage(data.usage); });
    void promise.then(() => { if (current) setError(''); }).catch(failure => { if (current) setError(errorText(failure)); });
    return () => { current = false; };
  }, [api, days, evaluation]);
  return <>
    <PageHeading title={evaluation ? 'Evaluation' : 'Usage'} description={evaluation ? 'Compare saved retrieval configurations and measured quality.' : 'Review metered provider calls, token usage, and reported or estimated spend.'}>
      {!evaluation && <label className="selectChip"><span className="srOnly">Date range</span><select value={days} onChange={event => { setUsage(undefined); setDays(Number(event.target.value)); }}><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option></select><ChevronDown size={13}/></label>}
    </PageHeading>
    {error && <p className="error" role="alert">{error}</p>}
    {evaluation ? runs?.length ? <div className="tableWrap"><table><thead><tr><th>Configuration</th><th>Run date</th><th>Queries</th><th>Recall@10</th><th>nDCG@10</th><th>p50 latency</th><th>p95 latency</th><th>Cost/query</th></tr></thead>
      <tbody>{runs.map(run => <tr key={run._id}><td><strong>{run.config.label || 'Retrieval run'}</strong></td><td>{new Date(run.timestamp).toLocaleString()}</td>
        {['queries', 'recallAt10', 'ndcgAt10', 'p50Ms', 'p95Ms', 'costPerQuery'].map(name => <td key={name}>{name === 'costPerQuery' ? money(run.metrics[name] ?? null) : run.metrics[name]?.toLocaleString(undefined, { maximumFractionDigits: 3 }) ?? '—'}</td>)}
      </tr>)}</tbody></table></div> : !error && <Empty icon={<FlaskConical size={24}/>} title={runs ? 'No saved evaluation runs' : 'Loading evaluation runs'}>{runs ? 'Results will appear here after an evaluation run is saved.' : 'Reading stored metrics from Atlas.'}</Empty>
      : usage?.length ? <div className="tableWrap"><table><thead><tr><th>Provider</th><th>Model</th><th>Calls</th><th>Reported tokens</th><th>Reported / estimated spend</th></tr></thead>
        <tbody>{usage.map(row => <tr key={row.provider + row.model}><td>{row.provider}</td><td><strong>{row.model}</strong></td><td>{row.calls.toLocaleString()}</td>
          <td>{row.unreportedTokens === row.calls ? '—' : row.tokens?.toLocaleString()}{row.unreportedTokens > 0 && <small>{row.unreportedTokens} calls without token counts</small>}</td>
          <td>{money(row.unreportedCost === row.calls ? null : row.cost)}{row.unreportedCost > 0 && <small>{row.unreportedCost} calls without cost</small>}</td></tr>)}</tbody></table></div>
        : !error && <Empty icon={<BarChart3 size={24}/>} title={usage ? 'No recorded provider calls' : 'Loading usage'}>{usage ? 'Usage will appear after your workspace makes a provider request.' : 'Reading metered calls from Atlas.'}</Empty>}
  </>;
}

export default function Workspace() {
  const [section, setSection] = useState<Section>('chat');
  const [token, setToken] = useState('');
  const [session, setSession] = useState<Session>();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [showConnect, setShowConnect] = useState(false);
  const [draft, setDraft] = useState('');
  const [connectError, setConnectError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const api = useCallback<Api>((path, init) => call(token, path, init), [token]);

  const connect = useCallback(async (key: string) => {
    setConnecting(true); setConnectError('');
    try {
      const data = await call<Session>(key, 'session');
      setSession(data); setToken(key); sessionStorage.setItem(settingsKey, key); setShowConnect(false); setDraft('');
    } catch (failure) { sessionStorage.removeItem(settingsKey); setConnectError(errorText(failure)); setShowConnect(true); }
    finally { setConnecting(false); }
  }, []);
  useEffect(() => {
    const readSection = () => {
      const id = window.location.hash.slice(1);
      const match = sections.find(item => item.id === id);
      if (match) setSection(match.id);
      else if (!id) setSection('chat');
    };
    readSection();
    window.addEventListener('hashchange', readSection);
    const key = sessionStorage.getItem(settingsKey);
    if (key) void connect(key);
    return () => window.removeEventListener('hashchange', readSection);
  }, [connect]);
  const refreshCollections = useCallback(() => {
    if (token) void api<{ collections: Collection[] }>('collections').then(result => setCollections(result.collections)).catch(() => setCollections([]));
  }, [api, token]);
  useEffect(refreshCollections, [refreshCollections]);
  const onConnect = () => { setConnectError(''); setShowConnect(true); };
  const disconnect = () => { sessionStorage.removeItem(settingsKey); setToken(''); setSession(undefined); setCollections([]); };
  const current = sections.find(item => item.id === section)!;
  return <div className="shell">
    <aside className="sidebar">
      <a className="brand" href="#chat"><span className="brandIcon"><Layers3 size={22} strokeWidth={2.1}/></span><span><strong>NitroStack</strong><small>Knowledge Engine</small></span></a>
      <div className="navLabel">WORKSPACE</div>
      <nav aria-label="Workspace pages">{sections.map(({ id, icon: Icon, label }) => <a className={id === section ? 'navItem active' : 'navItem'} key={id} href={'#' + id}
        aria-current={id === section ? 'page' : undefined}><Icon size={18} strokeWidth={1.8}/>{label}</a>)}</nav>
      <div className="sidebarFoot">
        <a className="docsLink" href="https://docs.nitrostack.ai" target="_blank" rel="noreferrer"><CircleHelp size={17}/> Documentation</a>
        <button className="workspace" onClick={session ? disconnect : onConnect}>
          <span className="workspaceIcon">{session ? <Database size={17}/> : <LockKeyhole size={17}/>}</span>
          <span><strong>{session?.tenantId || 'Workspace access'}</strong><small>{session ? 'Connected' : 'API key required'}</small></span>
          {session && <LogOut size={15} aria-label="Disconnect workspace"/>}
        </button>
      </div>
    </aside>
    <main>
      <header className="topbar"><div><BookOpen size={16}/><span>Workspace</span><span className="slash">/</span><strong>{current.label}</strong></div>
        {session ? <button className="connected" onClick={disconnect} title="Disconnect workspace"><span/> Connected <LogOut size={13}/></button> : <button className="secondary" onClick={onConnect}><LockKeyhole size={14}/> Connect workspace</button>}</header>
      <div className="content" key={section + (session?.tenantId || '')}>
        {section === 'chat' || section === 'search' ? <QueryPanel chat={section === 'chat'} api={api} ready={!!session} models={session?.models || []} collections={collections} onConnect={onConnect}/> :
          session ? section === 'collections' ? <CollectionsPanel api={api} session={session} onChanged={refreshCollections}/> : <Reports api={api} evaluation={section === 'evaluation'}/> :
            <><PageHeading title={current.label} description="Connect your workspace to access its data."/><Empty icon={<LockKeyhole size={24}/>} title="Workspace access required"><button className="secondary" onClick={onConnect}>Connect workspace</button></Empty></>}
      </div>
      <footer className="mainFoot"><AudioLines size={14} strokeWidth={1.7}/> NitroStack Knowledge Engine</footer>
    </main>
    {showConnect && <div className="modalBackdrop" onClick={event => { if (event.target === event.currentTarget && !connecting) setShowConnect(false); }}>
      <form className="modal" aria-modal="true" role="dialog" aria-labelledby="connectTitle" onKeyDown={event => {
        if (event.key === 'Escape' && !connecting) setShowConnect(false);
      }} onSubmit={event => { event.preventDefault(); void connect(draft.trim()); }}>
        <div className="emptyIcon"><LockKeyhole size={22}/></div><h2 id="connectTitle">Connect workspace</h2>
        <p>Enter the API key issued for your NitroStack workspace.</p>
        <label htmlFor="workspaceKey">Workspace API key</label><input id="workspaceKey" autoFocus type="password" autoComplete="off" required value={draft} onChange={event => setDraft(event.target.value)}/>
        {connectError && <p className="error" role="alert">{connectError}</p>}
        <div className="modalActions"><button type="button" className="secondary" onClick={() => setShowConnect(false)} disabled={connecting}>Cancel</button><button className="primary" disabled={connecting || !draft.trim()}>{connecting ? 'Connecting…' : 'Connect'}</button></div>
      </form>
    </div>}
  </div>;
}
