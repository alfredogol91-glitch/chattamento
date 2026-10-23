import { useEffect, useRef, useState } from 'react';
import { createDirectoryShareFromHandle, createDirectoryShareFromFiles } from './sharedDirectory.js';
import { localeFor } from './i18n.js';
import './folder.css';

function FolderIcon({ name = 'folder', size = 20 }) {
  const paths = {
    folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    back: <path d="M19 12H5m6-6-6 6 6 6" />,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    shield: <><path d="m12 3 8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4Z" /><path d="m8 12 3 3 5-6" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.folder}</svg>;
}

function sameShare(first, second) { return first?.id === second?.id && first?.ownerId === second?.ownerId; }

function folderError(error, t) {
  const code = error?.code || error?.message;
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError' || code === 'folder_permission_denied') return t('foldersPermissionDenied');
  if (code === 'folder_revoked') return t('foldersRevoked');
  if (code === 'offline') return t('roomOffline');
  if (code === 'no_peers') return t('foldersOffline');
  if (code === 'nickname_taken') return t('nicknameConflict');
  if (['folder_not_found', 'folder_file_unavailable', 'folder_unavailable'].includes(code)) return t('foldersUnavailable');
  if (code === 'folder_selection_invalid') return t('foldersSelectionError');
  if (code === 'folder_too_large') return t('foldersTooLarge');
  if (code === 'file_too_large') return t('foldersDownloadLimit', { size: '25 MB' });
  return t('foldersError');
}

function formatSize(value, locale) {
  if (!Number.isFinite(value)) return '—';
  const unit = value >= 1024 * 1024 ? 'MB' : value >= 1024 ? 'KB' : 'B';
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / (unit === 'MB' ? 1024 * 1024 : unit === 'KB' ? 1024 : 1))} ${unit}`;
}

function formatModified(value, locale) {
  if (!Number.isFinite(value) || value < 0 || value > 8640000000000000) return '';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short' }).format(value);
}

/** Picking a folder prepares a private preview. Only the share button publishes it. */
export default function FolderPanel({ roomClient, language, onClose, t }) {
  const dialogRef = useRef(null);
  const inputRef = useRef(null);
  const candidateRef = useRef(null);
  const mounted = useRef(true);
  const selectionGeneration = useRef(0);
  const requestGeneration = useRef(0);
  const selectedRef = useRef(null);
  const remoteRef = useRef(roomClient.sharedFolders || []);
  const [candidate, setCandidate] = useState(null);
  const [selecting, setSelecting] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [local, setLocal] = useState(roomClient.localSharedFolders || []);
  const [folders, setFolders] = useState(remoteRef.current);
  const [selected, setSelected] = useState(null);
  const [path, setPath] = useState([]);
  const [listing, setListing] = useState(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const locale = localeFor(language);

  const invalidateBrowse = revoked => {
    requestGeneration.current++;
    selectedRef.current = null;
    setSelected(null); setPath([]); setListing(null); setLoading(false); setDownloading(null);
    if (revoked) { setNotice('foldersRevoked'); setError(null); }
  };

  useEffect(() => {
    dialogRef.current?.showModal();
    const unsubscribeFolders = roomClient.on('folders', data => {
      if (!mounted.current) return;
      const available = data.folders || [];
      remoteRef.current = available; setFolders(available); setLocal(data.local || []);
      if (selectedRef.current && !available.some(folder => sameShare(folder, selectedRef.current))) invalidateBrowse(true);
    });
    const unsubscribeRevoked = roomClient.on('folder-revoked', data => {
      if (!mounted.current) return;
      const target = { id: data.shareId || data.id, ownerId: data.ownerId };
      remoteRef.current = remoteRef.current.filter(folder => !sameShare(folder, target));
      setFolders(remoteRef.current);
      if (sameShare(selectedRef.current, target)) invalidateBrowse(true);
    });
    const unsubscribeError = roomClient.on('error', err => { if (mounted.current && err?.code?.startsWith('folder_')) setError(err); });
    return () => {
      mounted.current = false; selectionGeneration.current++; requestGeneration.current++;
      unsubscribeFolders?.(); unsubscribeRevoked?.(); unsubscribeError?.();
      candidateRef.current?.dispose(); candidateRef.current = null;
    };
  }, [roomClient]);

  const clearCandidate = () => {
    selectionGeneration.current++;
    candidateRef.current?.dispose(); candidateRef.current = null;
    setCandidate(null); setReplaceConfirmed(false);
  };

  const acceptCandidate = (model, generation) => {
    if (!mounted.current || generation !== selectionGeneration.current) { model.dispose(); return; }
    candidateRef.current = model; setCandidate({ id: model.id, name: model.name });
  };

  const chooseDirectory = () => {
    clearCandidate(); setError(null); setNotice(null);
    if (typeof window.showDirectoryPicker !== 'function') { inputRef.current?.click(); return; }
    const generation = selectionGeneration.current;
    // Keep the native picker in the direct user gesture: no awaits before this call.
    let selection;
    try { selection = window.showDirectoryPicker({ mode: 'read' }); }
    catch (err) { setError(err); return; }
    setSelecting(true);
    Promise.resolve(selection).then(handle => createDirectoryShareFromHandle(handle)).then(model => acceptCandidate(model, generation))
      .catch(err => { if (mounted.current && generation === selectionGeneration.current && err.name !== 'AbortError') setError(err); })
      .finally(() => { if (mounted.current && generation === selectionGeneration.current) setSelecting(false); });
  };

  const chooseFallback = async event => {
    const files = Array.from(event.target.files || []); event.target.value = '';
    if (!files.length) return;
    const generation = selectionGeneration.current;
    setSelecting(true); setError(null);
    try { acceptCandidate(await createDirectoryShareFromFiles(files), generation); }
    catch (err) { if (mounted.current && generation === selectionGeneration.current) setError(err); }
    finally { if (mounted.current && generation === selectionGeneration.current) setSelecting(false); }
  };

  const share = async () => {
    const model = candidateRef.current;
    if (!model || sharing || (local.length > 0 && !replaceConfirmed)) return;
    // Ownership transfers to the room service; closing this dialog must not dispose a live share.
    candidateRef.current = null; setCandidate(null); setSharing(true); setError(null);
    try {
      for (const folder of local) await roomClient.stopSharingFolder(folder.id);
      await roomClient.shareFolder(model);
    }
    catch (err) { model.dispose(); if (mounted.current) setError(err); }
    finally { if (mounted.current) { setSharing(false); setReplaceConfirmed(false); } }
  };

  const stopSharing = async () => {
    setStopping(true); setError(null);
    try { for (const folder of local) await roomClient.stopSharingFolder(folder.id); }
    catch (err) { if (mounted.current) setError(err); }
    finally { if (mounted.current) setStopping(false); }
  };

  const browse = async (folder, nextPath = [{ id: 'root', name: folder.name }]) => {
    if (!remoteRef.current.some(item => sameShare(item, folder))) { invalidateBrowse(true); return; }
    const generation = ++requestGeneration.current;
    selectedRef.current = folder; setSelected(folder); setPath(nextPath); setListing(null); setLoading(true); setDownloading(null); setError(null); setNotice(null);
    try {
      const result = await roomClient.browseFolder({ ownerId: folder.ownerId, shareId: folder.id, nodeId: nextPath.at(-1).id });
      if (mounted.current && generation === requestGeneration.current && remoteRef.current.some(item => sameShare(item, folder))) setListing(result);
    } catch (err) { if (mounted.current && generation === requestGeneration.current) setError(err); }
    finally { if (mounted.current && generation === requestGeneration.current) setLoading(false); }
  };

  const download = async entry => {
    const folder = selectedRef.current;
    if (!folder || downloading || !remoteRef.current.some(item => sameShare(item, folder))) return;
    const generation = requestGeneration.current;
    setDownloading(entry.id); setError(null);
    try {
      const result = await roomClient.downloadSharedFile({ ownerId: folder.ownerId, shareId: folder.id, fileId: entry.id });
      if (!mounted.current || generation !== requestGeneration.current || !remoteRef.current.some(item => sameShare(item, folder))) { roomClient.releaseSharedFile?.(result.url); return; }
      const anchor = document.createElement('a'); anchor.href = result.url; anchor.download = result.name; anchor.hidden = true;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => roomClient.releaseSharedFile?.(result.url), 1500);
    } catch (err) { if (mounted.current && generation === requestGeneration.current) setError(err); }
    finally { if (mounted.current && generation === requestGeneration.current) setDownloading(null); }
  };

  const entries = [...(listing?.entries || [])].sort((first, second) => (first.kind === 'directory' ? 0 : 1) - (second.kind === 'directory' ? 0 : 1) || first.name.localeCompare(second.name, locale));
  return <dialog ref={dialogRef} className="folder-dialog" aria-labelledby="folder-dialog-title" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="folder-dialog-header"><span className="folder-header-icon"><FolderIcon /></span><div><h2 id="folder-dialog-title">{t('foldersTitle')}</h2><p>{t('foldersSubtitle')}</p></div><button className="icon-button" type="button" onClick={onClose} aria-label={t('close')}><FolderIcon name="close" /></button></header>
    <div className="folder-dialog-content">
      <section className="folder-own-section" aria-labelledby="folder-own-title">
        <div className="folder-section-heading"><h3 id="folder-own-title">{t('foldersOwnTitle')}</h3><span className="folder-readonly"><FolderIcon name="shield" size={13} />{t('foldersReadonly')}</span></div>
        {local.map(folder => <div className="folder-live-card" key={folder.id}><div><span className="status-dot" /><strong>{folder.name}</strong><small>{t('foldersSharingLive')}</small></div><button className="folder-stop" type="button" onClick={stopSharing} disabled={stopping}><FolderIcon name="stop" size={14} />{t('foldersStop')}</button></div>)}
        <button className="folder-choose" type="button" onClick={chooseDirectory} disabled={selecting || sharing}><FolderIcon size={23} /><strong>{t(local.length || candidate ? 'foldersChooseAnother' : 'foldersChoose')}</strong><span>{t(typeof window.showDirectoryPicker === 'function' ? 'foldersHomeHint' : 'foldersFallbackHint')}</span></button>
        <input ref={inputRef} type="file" webkitdirectory="" multiple className="sr-only" tabIndex={-1} aria-label={t('foldersChoose')} onChange={chooseFallback} />
        {selecting && <p className="folder-busy" role="status"><span className="spinner spinner-small" />{t('foldersLoading')}</p>}
        {candidate && <div className="folder-selection-preview"><div className="folder-selected-name"><FolderIcon size={19} /><div><small>{t('foldersSelected')}</small><strong>{candidate.name}</strong></div><button className="icon-button" type="button" onClick={clearCandidate} aria-label={t('cancel')}><FolderIcon name="close" size={16} /></button></div><p className="folder-consent">{t('foldersConsent')}</p>{local.length > 0 && <label className="folder-replacement"><input type="checkbox" checked={replaceConfirmed} onChange={event => setReplaceConfirmed(event.target.checked)} /><span>{t('foldersReplacementConfirm')}</span></label>}<button className="button button-primary folder-share-button" type="button" onClick={share} disabled={sharing || !roomClient.connected || (local.length > 0 && !replaceConfirmed)}><FolderIcon name="check" size={17} />{t('foldersShare')}</button></div>}
        {sharing && <p className="folder-busy" role="status"><span className="spinner spinner-small" />{t('foldersSharing')}</p>}
        <p className="folder-private-note"><FolderIcon name="shield" size={16} />{t('foldersDownloadedNote')}</p>
      </section>
      <section className="folder-remote-section" aria-labelledby="folder-remote-title">
        <div className="folder-section-heading"><h3 id="folder-remote-title">{t('foldersRemoteTitle')}</h3><span className="folder-count">{folders.length}</span></div>
        {folders.length > 0 ? <div className="folder-roots">{folders.map(folder => <button className={`folder-root ${sameShare(folder, selected) ? 'folder-root-selected' : ''}`} type="button" key={`${folder.ownerId}:${folder.id}`} onClick={() => browse(folder)}><FolderIcon size={20} /><span><strong>{folder.name}</strong><small>{t('foldersOwner', { name: folder.ownerNickname })}</small></span><FolderIcon name="back" size={15} /></button>)}</div> : <div className="folders-empty"><span><FolderIcon size={29} /></span><p>{t('foldersNoRemote')}</p></div>}
        {selected && <div className="folder-browser">
          <nav className="folder-breadcrumbs" aria-label={t('foldersBrowse')}><button className="icon-button" type="button" disabled={path.length <= 1} onClick={() => browse(selected, path.slice(0, -1))} aria-label={t('foldersBack')}><FolderIcon name="back" size={16} /></button>{path.map((part, index) => <button type="button" key={part.id} onClick={() => browse(selected, path.slice(0, index + 1))} aria-current={index === path.length - 1 ? 'location' : undefined}>{part.name}{index < path.length - 1 && <span aria-hidden="true">/</span>}</button>)}</nav>
          {loading && <p className="folder-busy" role="status"><span className="spinner spinner-small" />{t('foldersLoading')}</p>}
          {listing && <div className="folder-list" role="list" aria-label={listing.name}>{entries.map(entry => <div className="folder-entry" role="listitem" key={entry.id}><span className={`folder-entry-icon ${entry.kind === 'directory' ? 'folder-entry-directory' : ''}`}><FolderIcon name={entry.kind === 'directory' ? 'folder' : 'file'} size={19} /></span>{entry.kind === 'directory' ? <button className="folder-directory-button" type="button" onClick={() => browse(selected, [...path, { id: entry.id, name: entry.name }])} aria-label={`${t('foldersBrowse')}: ${entry.name}`}><strong>{entry.name}</strong><small>{t('foldersDirectory')}</small></button> : <div className="folder-entry-name"><strong>{entry.name}</strong><small>{Number.isFinite(entry.size) ? formatSize(entry.size, locale) : t('foldersUnknownSize')}{formatModified(entry.lastModified, locale) && <> · {formatModified(entry.lastModified, locale)}</>}</small></div>}{entry.kind === 'file' && <button className="folder-download-button" type="button" onClick={() => download(entry)} disabled={Boolean(downloading)} aria-label={`${t('foldersDownload')}: ${entry.name}`} title={t('foldersDownload')}>{downloading === entry.id ? <span className="spinner spinner-small" /> : <FolderIcon name="download" size={17} />}</button>}</div>)}{entries.length === 0 && <p className="folder-list-empty">{t('foldersEmpty')}</p>}</div>}
        </div>}
      </section>
    </div>
    {(error || notice) && <div className={`folder-feedback ${error ? 'folder-feedback-error' : ''}`} role={error ? 'alert' : 'status'}>{error ? folderError(error, t) : t(notice)}</div>}
  </dialog>;
}
