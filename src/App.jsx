import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPeerRoom } from './peerRoom.js';
import { readInvitation, createInvitation, invitationUrl } from './roomInvite.js';
import { translateMessage } from './translate.js';
import { languages, getT, localeFor } from './i18n.js';
import CallPanel from './CallPanel.jsx';

const languageCodes = ['en', 'ru', 'es', 'uk', 'it'];
const maxFileSize = 25 * 1024 * 1024;

function readLanguage() {
  try {
    const remembered = localStorage.getItem('chattamento.language');
    if (languageCodes.includes(remembered)) return remembered;
  } catch { /* Browser storage may be unavailable. */ }
  const browser = navigator.language?.split('-')[0];
  return languageCodes.includes(browser) ? browser : 'en';
}

function saveLanguage(language) {
  try { localStorage.setItem('chattamento.language', language); } catch { /* Session remains usable. */ }
}

class RoomError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function errorText(error, t) {
  const code = typeof error === 'string' ? error : error?.code;
  const mapping = {
    network: 'errorNetwork', invalid_nickname: 'errorInvalidNickname', nickname_taken: 'errorNicknameTaken',
    invalid_language: 'errorInvalidLanguage', message_too_long: 'errorMessageTooLong',
    file_too_large: 'errorFileTooLarge', upload_failed: 'transferFailed', transfer_failed: 'transferFailed',
    rate_limited: 'errorRateLimited', message_required: 'emptyMessage', no_peers: 'waitingForFriends',
    nickname_conflict: 'nicknameConflict', connection_failed: 'roomConnectionError', offline: 'roomOffline',
  };
  return t(mapping[code] || 'errorGeneric');
}

function useTranslations(messages, language) {
  const cache = useRef(new Map());
  const [version, setVersion] = useState(0);
  const abortController = useMemo(() => new AbortController(), [language]);
  useEffect(() => () => abortController.abort(), [abortController]);
  useEffect(() => {
    let active = true;
    for (const message of messages) {
      if (!message.text || message.sourceLanguage === language) continue;
      const key = `${message.id}:${language}`;
      if (!cache.current.has(key) || cache.current.get(key).controller.signal.aborted) {
        const entry = { status: 'pending', text: message.text, controller: abortController };
        entry.promise = translateMessage(message.text, message.sourceLanguage, language, { signal: abortController.signal })
          .then(text => { entry.status = 'translated'; entry.text = text; })
          .catch(() => {
            entry.status = 'unavailable'; entry.text = message.text;
            if (abortController.signal.aborted && cache.current.get(key) === entry) cache.current.delete(key);
          });
        cache.current.set(key, entry);
      }
      const entry = cache.current.get(key);
      if (entry.status === 'pending') entry.promise.then(() => { if (active) setVersion(value => value + 1); });
    }
    return () => { active = false; };
  }, [messages, language]);
  return useMemo(() => messages.map(message => {
    const entry = cache.current.get(`${message.id}:${language}`);
    const sameLanguage = !message.text || message.sourceLanguage === language;
    return { ...message, translatedText: sameLanguage ? message.text : entry?.text || message.text, translationStatus: sameLanguage ? 'original' : entry?.status || 'pending', targetLanguage: language };
  }), [messages, language, version]);
}

export function Icon({ name, size = 20, ...props }) {
  const paths = {
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    back: <><path d="M19 12H5m6-6-6 6 6 6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" /></>,
    chat: <><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z" /><path d="M8 11h.01M12 11h.01M16 11h.01" /></>,
    sparkle: <><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z" /><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5L20 2Z" /></>,
    video: <><rect x="3" y="5" width="13" height="14" rx="3" /><path d="m16 10 5-3v10l-5-3" /></>,
    history: <><path d="M3 11a9 9 0 1 1 2.6 7M3 4v7h7" /><path d="M12 7v5l3 2" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /><circle cx="9" cy="7" r="4" /></>,
    paperclip: <path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7L9.3 17.6a2 2 0 0 1-2.8-2.8l9.2-9.2" />,
    send: <><path d="m22 2-7 20-4-9-9-4L22 2Z" /><path d="M22 2 11 13" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    chevron: <path d="m6 9 6 6 6-6" />,
    down: <><path d="M12 4v16m-6-6 6 6 6-6" /></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z" /><path d="M14 2v6h6M8 13h8M8 17h5" /></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></>,
    edit: <><path d="m16 3 5 5M4 20l5-1L21 7a3.5 3.5 0 0 0-5-5L4 14l-1 7Z" /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
    heart: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name] || paths.chat}</svg>;
}

function Logo({ compact = false }) {
  return <div className={`brand ${compact ? 'brand-compact' : ''}`}><span className="brand-icon"><Icon name="chat" size={23} /></span><span>chattamento<span className="brand-period">.</span></span></div>;
}

function Avatar({ name, small = false, online = false }) {
  let hash = 0;
  for (const letter of String(name)) hash = (hash + letter.codePointAt(0)) % 6;
  return <span className={`avatar avatar-${hash} ${small ? 'avatar-small' : ''}`} aria-hidden="true">{Array.from(name || '?').slice(0, 2).join('').toLocaleUpperCase()}{online && <span className="online-dot" />}</span>;
}

function Spinner({ small = false }) { return <span className={`spinner ${small ? 'spinner-small' : ''}`} aria-hidden="true" />; }

function LanguageSelect({ language, onChange, label, disabled = false, id = 'language-select' }) {
  const selected = languages.find(item => item.code === language);
  return <div className="language-select-wrap"><label className="sr-only" htmlFor={id}>{label}</label><span className="select-flag" aria-hidden="true">{selected?.flag}</span><select id={id} value={language} onChange={event => onChange(event.target.value)} disabled={disabled}>{languages.map(item => <option key={item.code} value={item.code}>{item.nativeName}</option>)}</select><Icon name="chevron" size={15} /></div>;
}

function Welcome({ step, setStep, language, onLanguage, onJoin, busy, error, hasInvitation, t }) {
  const [nickname, setNickname] = useState('');
  const selected = languages.find(item => item.code === language);
  return <div className="welcome-page">
    <header className="welcome-header"><Logo /><span className="welcome-room-tag"><span className="status-dot" />{t('roomName')}</span></header>
    <main className="welcome-main">
      <section className="welcome-story">
        <div className="eyebrow"><span className="small-line" />{t('homeEyebrow')}</div>
        <h1>{t('homeTitle')}<br /><span>{t('homeTitleAccent')}</span></h1>
        <p className="welcome-description">{t('homeDescription')}</p>
        <div className="conversation-illustration" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <span className="art-spark art-spark-one">✳</span><span className="art-spark art-spark-two">✧</span>
          <div className="hello-bubble hello-bubble-one"><span>🇮🇹</span> Ciao, amici!<span className="bubble-heart">♡</span></div>
          <div className="hello-bubble hello-bubble-two"><span>🇺🇦</span> Привіт, друзі!<span className="bubble-check">✓✓</span></div>
          <div className="hello-bubble hello-bubble-three"><span>🇪🇸</span> ¡Hola, amigos!<Icon name="sparkle" size={16} /></div>
          <div className="illustration-caption"><span className="mini-avatar mini-avatar-one">A</span><span className="mini-avatar mini-avatar-two">M</span><span className="mini-avatar mini-avatar-three">S</span><span>{t('yourPeople')}</span></div>
        </div>
      </section>
      <section className="welcome-card" aria-labelledby="welcome-card-title">
        <div className="step-indicator" aria-label={`${step === 'welcome' ? 1 : 2} / 2`}><span className="step-current" /><span className={step === 'nickname' ? 'step-current' : ''} /><small>0{step === 'welcome' ? 1 : 2} / 02</small></div>
        {step === 'welcome' ? <>
          <div className="card-symbol"><Icon name="globe" size={26} /></div>
          <h2 id="welcome-card-title">{t('chooseLanguage')}</h2>
          <p className="card-description">{t('chooseLanguageHint')}</p>
          <div className="language-options" role="radiogroup" aria-label={t('chooseLanguage')}>
            {languages.map(item => <button type="button" key={item.code} role="radio" aria-checked={language === item.code} className={`language-option ${language === item.code ? 'selected' : ''}`} onClick={() => onLanguage(item.code)}><span className="language-flag" aria-hidden="true">{item.flag}</span><span className="language-option-label"><strong>{item.nativeName}</strong><small>{item.greeting}</small></span><span className="language-radio">{language === item.code && <Icon name="check" size={12} />}</span></button>)}
          </div>
          <button className="button button-primary welcome-continue" type="button" onClick={() => setStep('nickname')}>{t('continue')}<Icon name="arrow" size={18} /></button>
          <p className="card-footnote"><Icon name="sparkle" size={14} />{t('translationNotice')}</p>
        </> : <>
          <button className="text-button welcome-back" type="button" onClick={() => setStep('welcome')} disabled={busy}><Icon name="back" size={16} />{t('back')}</button>
          <div className="card-symbol"><Icon name="user" size={26} /></div>
          <h2 id="welcome-card-title">{t('nicknameTitle')}</h2>
          <p className="card-description">{t(hasInvitation ? 'invitedRoomDescription' : 'nicknameDescription')}</p>
          <div className="selected-language"><span>{selected?.flag} {selected?.nativeName}</span><Icon name="check" size={16} /></div>
          <form onSubmit={event => { event.preventDefault(); onJoin(nickname); }}>
            <label className="field-label" htmlFor="nickname">{t('nicknameLabel')}</label>
            <div className="nickname-input-wrap"><Icon name="user" size={18} /><input id="nickname" value={nickname} onChange={event => setNickname(event.target.value)} placeholder={t('nicknamePlaceholder')} minLength={2} maxLength={24} autoComplete="nickname" autoFocus required disabled={busy} /></div>
            <p className="field-hint">{t('nicknameHint')}</p>
            {error && <p className="error-message" role="alert"><Icon name="info" size={16} />{errorText(error, t)}</p>}
            <button className="button button-primary welcome-continue" type="submit" disabled={busy || !nickname.trim()}>{busy ? <><Spinner small />{t('joining')}</> : <>{t('joinChat')}<Icon name="arrow" size={18} /></>}</button>
          </form>
          <p className="card-footnote"><Icon name="heart" size={14} />{t('rememberedDevice')}</p>
        </>}
        {step === 'welcome' && error && <p className="error-message" role="alert">{errorText(error, t)}</p>}
      </section>
    </main>
    <div className="welcome-features">
      {[['sparkle', 'featureTranslation', 'featureTranslationHint'], ['video', 'featureCalls', 'featureCallsHint'], ['users', 'featureHistory', 'featureHistoryHint']].map(([icon, title, description]) => <div className="welcome-feature" key={title}><span className="feature-icon"><Icon name={icon} size={22} /></span><div><strong>{t(title)}</strong><p>{t(description)}</p></div></div>)}
    </div>
    <footer className="welcome-footer"><span>{t('footerNote')}</span><span className="footer-languages" aria-hidden="true">Hello. Ciao. Hola. Привіт. Привет.</span></footer>
  </div>;
}

function formatBytes(size, locale) {
  if (size < 1024) return `${size} B`;
  const unit = size >= 1024 * 1024 ? 'MB' : 'KB';
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(size / (unit === 'MB' ? 1024 * 1024 : 1024))} ${unit}`;
}

function Attachment({ attachment, t, locale }) {
  if (!attachment) return null;
  const image = attachment.mimeType?.startsWith('image/');
  const video = attachment.mimeType?.startsWith('video/');
  const audio = attachment.mimeType?.startsWith('audio/');
  return <div className={`message-attachment ${image || video ? 'message-attachment-visual' : ''}`}>
    {image && <a href={attachment.url} target="_blank" rel="noreferrer"><img src={attachment.url} alt={attachment.name} loading="lazy" /></a>}
    {video && <video src={attachment.url} controls preload="metadata" aria-label={`${t('mediaVideo')}: ${attachment.name}`} />}
    {audio && <audio src={attachment.url} controls preload="metadata" aria-label={`${t('mediaAudio')}: ${attachment.name}`} />}
    <a className="attachment-download" href={attachment.url} download={attachment.name} aria-label={`${t('downloadFile')}: ${attachment.name}`}><span className="file-symbol"><Icon name="file" size={20} /></span><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size, locale)}</small></span><Icon name="download" size={16} /></a>
  </div>;
}

function Message({ message, own, t, language, grouped }) {
  const [showOriginal, setShowOriginal] = useState(false);
  const locale = localeFor(language);
  const hasText = Boolean(message.text);
  const isTranslated = message.translationStatus === 'translated' && message.translatedText;
  const unavailable = message.translationStatus === 'unavailable' && hasText && message.sourceLanguage !== language;
  const pending = message.translationStatus === 'pending' && hasText && message.sourceLanguage !== language;
  const text = isTranslated && !showOriginal ? message.translatedText : message.text;
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(message.createdAt));
  const source = languages.find(item => item.code === message.sourceLanguage);
  return <article className={`message-row ${own ? 'message-own' : ''} ${grouped ? 'message-grouped' : ''}`} data-message-id={message.id}>
    {!own && <span className={`message-avatar ${grouped ? 'message-avatar-hidden' : ''}`}><Avatar name={message.nickname} small /></span>}
    <div className="message-content">
      {!grouped && <div className="message-meta"><strong>{own ? t('you') : message.nickname}</strong><span className="message-language" title={source?.nativeName}>{source?.code?.toUpperCase()}</span><time dateTime={message.createdAt}>{time}</time></div>}
      <div className="message-bubble">
        {hasText && <p className="message-text" dir="auto">{text}</p>}
        <Attachment attachment={message.attachment} t={t} locale={locale} />
        {isTranslated && <button className="translation-toggle" type="button" onClick={() => setShowOriginal(value => !value)}><Icon name="sparkle" size={11} />{showOriginal ? t('hideOriginal') : t('showOriginal')}</button>}
        {pending && <span className="translation-pending"><Spinner small />{t('translationPending')}</span>}
        {unavailable && <span className="translation-unavailable"><Icon name="info" size={12} />{t('translationUnavailable')}</span>}
        {grouped && <time className="grouped-time" dateTime={message.createdAt}>{time}</time>}
      </div>
    </div>
  </article>;
}

function dayKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dateLabel(value, language, t) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (dayKey(date) === dayKey(today)) return t('today');
  if (dayKey(date) === dayKey(yesterday)) return t('yesterday');
  return new Intl.DateTimeFormat(localeFor(language), { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

function NicknameDialog({ user, roomClient, onUpdate, onClose, conflict, t }) {
  const dialog = useRef(null);
  const [nickname, setNickname] = useState(conflict ? '' : user.nickname);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(conflict ? new RoomError('nickname_conflict') : null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError(null);
    try { const updated = await roomClient.updateProfile({ nickname: nickname.trim() }); onUpdate(updated); onClose(); }
    catch (err) { setError(err); } finally { setBusy(false); }
  };
  return <dialog className="nickname-dialog" ref={dialog} onCancel={event => { if (conflict) event.preventDefault(); else onClose(); }} onClick={event => { if (!conflict && event.target === event.currentTarget) onClose(); }}><form onSubmit={submit}><div className="dialog-top"><h2>{t('changeNicknameTitle')}</h2>{!conflict && <button className="icon-button" type="button" onClick={onClose} aria-label={t('close')}><Icon name="close" /></button>}</div><label className="field-label" htmlFor="edit-nickname">{t('nicknameLabel')}</label><input id="edit-nickname" value={nickname} onChange={event => setNickname(event.target.value)} minLength={2} maxLength={24} required autoFocus disabled={busy} /><p className="field-hint">{t('nicknameHint')}</p>{error && <p className="error-message" role="alert">{errorText(error, t)}</p>}<div className="dialog-actions">{!conflict && <button className="button button-secondary" type="button" onClick={onClose}>{t('cancel')}</button>}<button className="button button-primary" type="submit" disabled={busy || !nickname.trim()}>{busy ? t('saving') : t('save')}</button></div></form></dialog>;
}

function InvitationDialog({ invitation, onClose, t }) {
  const dialog = useRef(null);
  const input = useRef(null);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const url = invitationUrl(invitation);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const copy = async () => {
    setCopied(false); setManual(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(url); setCopied(true);
    } catch {
      input.current?.focus(); input.current?.select();
      try { if (document.execCommand('copy')) setCopied(true); else setManual(true); }
      catch { setManual(true); }
    }
  };
  const share = async () => {
    try { await navigator.share({ title: 'Chattamento', text: t('invitationDescription'), url }); }
    catch (error) { if (error.name !== 'AbortError') setManual(true); }
  };
  return <dialog className="nickname-dialog invitation-dialog" ref={dialog} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><div className="dialog-top"><h2>{t('invitationTitle')}</h2><button className="icon-button" type="button" onClick={onClose} aria-label={t('close')}><Icon name="close" /></button></div><p className="invitation-description">{t('invitationDescription')}</p><label className="field-label" htmlFor="invitation-url">{t('inviteLinkLabel')}</label><input ref={input} id="invitation-url" type="text" value={url} readOnly onClick={event => event.target.select()} spellCheck={false} /><p className="field-hint">{t('inviteHint')}</p><div className="invitation-actions"><button className="button button-primary" type="button" onClick={copy}><Icon name={copied ? 'check' : 'users'} size={17} />{t(copied ? 'inviteCopied' : 'copyInvite')}</button>{typeof navigator.share === 'function' && <button className="button button-secondary" type="button" onClick={share}>{t('shareInvite')}</button>}</div>{copied && <p className="invitation-feedback" role="status">{t('inviteCopied')}</p>}{manual && <p className="field-hint" role="status">{t('inviteManualCopy')}</p>}</dialog>;
}

function Chat({ session, user, setUser, language, setLanguage, onLeave, t }) {
  const { client: roomClient, invitation } = session;
  const [rawMessages, setRawMessages] = useState([]);
  const messages = useTranslations(rawMessages, language);
  const [status, setStatus] = useState('connecting');
  const [users, setUsers] = useState([]);
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [changingLanguage, setChangingLanguage] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 640px)').matches);
  const [editNickname, setEditNickname] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const scrollRef = useRef(null);
  const fileRef = useRef(null);
  const textareaRef = useRef(null);
  const nearBottom = useRef(true);
  const forceBottom = useRef(true);
  const knownIds = useRef(new Set());
  const userRef = useRef(user);
  userRef.current = user;
  const selectedLanguage = languages.find(item => item.code === language);
  const locale = localeFor(language);
  const onlineUsers = users.length ? users : [user];
  const canSend = status === 'connected' && !conflict;
  const isWaiting = status === 'waiting';

  useEffect(() => {
    const media = matchMedia('(max-width: 640px)');
    const update = () => setMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const mergeMessage = message => {
    if (!message?.id || knownIds.current.has(message.id)) return;
    knownIds.current.add(message.id);
    if (!nearBottom.current && message.userId !== userRef.current.id) setUnread(value => value + 1);
    setRawMessages(current => [...current, message]);
  };

  useEffect(() => {
    let active = true;
    const subscriptions = [
      roomClient.on('message', mergeMessage),
      roomClient.on('presence', data => { if (active) setUsers(data.users || []); }),
      roomClient.on('status', value => { if (active) setStatus(value); }),
      roomClient.on('profile', profile => { if (active) setUser(profile.user || profile); }),
      roomClient.on('error', err => { if (active) setError(err); }),
      roomClient.on('nickname-conflict', () => { if (active) { setConflict(true); setEditNickname(true); } }),
    ];
    roomClient.connect().then(() => { if (active) setUser(roomClient.user); }).catch(err => { if (active) { setError(err); setStatus('error'); } });
    return () => { active = false; for (const unsubscribe of subscriptions) unsubscribe?.(); roomClient.leave(); };
  }, [roomClient]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (container && (nearBottom.current || forceBottom.current)) {
      container.scrollTop = container.scrollHeight;
      forceBottom.current = false; nearBottom.current = true; setUnread(0);
    }
  }, [messages]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) { textarea.style.height = '24px'; textarea.style.height = `${Math.min(textarea.scrollHeight, 132)}px`; }
  }, [text]);

  const changeLanguage = async next => {
    if (next === language) return;
    setChangingLanguage(true); setError(null);
    try { const updated = await roomClient.updateProfile({ language: next }); setUser(updated); setLanguage(next); saveLanguage(next); }
    catch (err) { setError(err); } finally { setChangingLanguage(false); }
  };

  const send = async event => {
    event?.preventDefault();
    if (sending || !canSend || (!text.trim() && !attachment)) return;
    setSending(true); setError(null);
    try {
      const data = await roomClient.sendMessage({ text: text.trim(), file: attachment?.file, clientId: crypto.randomUUID() });
      forceBottom.current = true; mergeMessage(data.message); setText(''); setAttachment(null);
      requestAnimationFrame(() => textareaRef.current?.focus());
    } catch (err) { setError(err); } finally { setSending(false); }
  };

  const chooseFile = event => {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file) return;
    setError(null);
    if (file.size > maxFileSize) { setError(new RoomError('file_too_large')); return; }
    setAttachment({ name: file.name, size: file.size, mimeType: file.type, file });
  };

  const scrollToLatest = () => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; nearBottom.current = true; setUnread(0); };
  const onScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    nearBottom.current = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    if (nearBottom.current) setUnread(0);
  };
  const statusKey = status === 'connected' ? 'connected' : isWaiting ? 'waitingForFriends' : status === 'connecting' ? 'roomConnecting' : status === 'error' ? 'roomConnectionError' : 'roomOffline';

  return <div className="chat-app">
    {sidebarOpen && <button className="sidebar-backdrop" aria-label={t('close')} type="button" onClick={() => setSidebarOpen(false)} />}
    <aside className={`sidebar ${sidebarOpen ? 'sidebar-open' : ''}`} inert={mobile && !sidebarOpen ? true : undefined} aria-hidden={mobile && !sidebarOpen ? true : undefined} onKeyDown={event => { if (event.key === 'Escape') setSidebarOpen(false); }}>
      <div className="sidebar-brand"><Logo compact /><button className="icon-button sidebar-close" type="button" aria-label={t('close')} onClick={() => setSidebarOpen(false)}><Icon name="close" /></button></div>
      <div className="sidebar-room-section"><p className="section-label">{t('sharedSpace')}</p><div className="room-selected"><span className="room-icon"><Icon name="chat" size={22} /></span><div><strong>{t('roomName')}</strong><span>{t('roomDescription')}</span></div><span className="room-selected-dot" /></div><button type="button" className="button sidebar-invite" onClick={() => setInviteOpen(true)}><Icon name="users" size={16} />{t('inviteFriends')}</button></div>
      <div className="sidebar-people"><div className="section-label section-label-row"><span>{t('onlineNow')}</span><span className="people-count">{onlineUsers.length}</span></div><div className="people-list">{onlineUsers.map(person => <div className="person" key={person.id}><Avatar name={person.nickname} small online /><div className="person-label"><strong>{person.nickname}{person.id === user.id && <span> · {t('you')}</span>}</strong><span>{languages.find(item => item.code === person.language)?.nativeName}{person.inCall && <> · <Icon name="video" size={11} /></>}</span></div></div>)}</div>{onlineUsers.length <= 1 && <p className="people-empty">{t('justYou')}</p>}</div>
      <div className="sidebar-note"><span><Icon name="users" size={18} /></span><p>{t('realtimeOnly')}</p></div>
      <div className="sidebar-settings"><label className="section-label" htmlFor="chat-language">{t('yourLanguage')}</label><LanguageSelect id="chat-language" language={language} onChange={changeLanguage} label={t('yourLanguage')} disabled={changingLanguage} /><p className="language-help"><Icon name="sparkle" size={12} />{t('languageHint')}</p></div>
      <div className="sidebar-profile"><Avatar name={user.nickname} small /><div><strong>{user.nickname}</strong><span><span className={`status-dot ${status !== 'connected' ? 'status-offline' : ''}`} />{t(statusKey)}</span></div><button className="icon-button" type="button" aria-label={t('editNickname')} title={t('editNickname')} onClick={() => setEditNickname(true)}><Icon name="edit" size={17} /></button><button className="icon-button" type="button" aria-label={t('leaveRoom')} title={t('leaveRoom')} onClick={onLeave}><Icon name="back" size={17} /></button></div>
    </aside>
    <main className="chat-main">
      <header className="room-header"><div className="room-header-title"><button className="icon-button sidebar-toggle" type="button" aria-label={t('participants')} onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button><span className="header-room-icon"><Icon name="chat" size={24} /></span><div><h1>{t('roomName')}</h1><p><span className={`status-dot ${status === 'connected' ? '' : 'status-offline'}`} />{t(statusKey)}<span className="header-dot">·</span><span className="header-room-description">{t('onlineCount', { count: onlineUsers.length })}</span></p></div></div><button type="button" className="button button-primary invite-header-button" onClick={() => setInviteOpen(true)}><Icon name="users" size={16} /><span>{t('inviteFriends')}</span></button></header>
      {(status === 'offline' || status === 'error') && <div className="connection-banner" role="status"><Icon name="info" size={15} />{t(statusKey)}</div>}
      <div className="call-area"><CallPanel roomClient={roomClient} user={user} users={onlineUsers} t={t} /></div>
      <div className="conversation-body">
        <div className="messages-scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="message-history-intro"><span className="history-intro-icon"><Icon name={isWaiting ? 'users' : 'chat'} size={27} /></span><h2>{t(isWaiting ? 'waitingForFriends' : 'chatWelcome')}</h2><p>{t(isWaiting ? 'waitingDescription' : 'chatWelcomeHint')}</p>{isWaiting && <button className="button button-secondary empty-invite" type="button" onClick={() => setInviteOpen(true)}><Icon name="users" size={15} />{t('inviteFriends')}</button>}<span className="history-intro-language-line">{languages.map(item => <span key={item.code} aria-hidden="true">{item.flag}</span>)}</span></div>
          <div className="messages" role="log" aria-live="polite" aria-relevant="additions text" aria-label={t('roomName')}>
            {messages.map((message, index) => {
              const previous = messages[index - 1];
              const newDay = !previous || dayKey(previous.createdAt) !== dayKey(message.createdAt);
              const grouped = !newDay && previous.userId === message.userId && new Date(message.createdAt) - new Date(previous.createdAt) < 3 * 60 * 1000;
              return <React.Fragment key={message.id}>{newDay && <div className="date-divider"><span>{dateLabel(message.createdAt, language, t)}</span></div>}<Message message={message} own={message.userId === user.id} grouped={grouped} t={t} language={language} /></React.Fragment>;
            })}
          </div>
        </div>
        {unread > 0 && <button type="button" className="new-messages" onClick={scrollToLatest}><Icon name="down" size={15} />{t('newMessages', { count: unread })}</button>}
      </div>
      <div className="composer-area">
        {error && <div className="composer-error" role="alert"><Icon name="info" size={16} /><span>{errorText(error, t)}</span><button type="button" className="icon-button" onClick={() => setError(null)} aria-label={t('close')}><Icon name="close" size={15} /></button></div>}
        {attachment && <div className="pending-attachment"><Icon name="file" size={19} /><span><strong>{attachment.name}</strong><small>{formatBytes(attachment.size, locale)}</small></span><button className="icon-button" type="button" aria-label={t('fileRemove')} onClick={() => setAttachment(null)} disabled={sending}><Icon name="close" size={16} /></button></div>}
        {sending && attachment && <p className="transfer-status" role="status"><Spinner small />{t('transferInProgress')}</p>}
        <form className="composer" onSubmit={send}><input type="file" ref={fileRef} onChange={chooseFile} className="sr-only" tabIndex={-1} aria-label={t('attachFile')} /><button className="icon-button attach-button" type="button" onClick={() => fileRef.current?.click()} aria-label={t('attachFile')} title={`${t('attachFile')} · ${t('uploadLimit', { size: formatBytes(maxFileSize, locale) })}`} disabled={sending}><Icon name="paperclip" size={21} /></button><textarea ref={textareaRef} value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} placeholder={t(canSend ? 'messagePlaceholder' : 'waitingForFriends')} aria-label={t('sendMessage')} rows={1} maxLength={4000} disabled={sending} /><button className="send-button" type="submit" disabled={!canSend || sending || (!text.trim() && !attachment)} aria-label={t('send')} title={t('send')}>{sending ? <Spinner small /> : <Icon name="send" size={20} />}</button></form>
        <div className="composer-footnote"><span><Icon name="sparkle" size={12} />{t('sourceLanguageHint', { language: selectedLanguage?.nativeName })}</span><span>{t('sendHint')}</span></div>
        <p className="translation-disclosure">{t('translationNotice')}</p>
      </div>
    </main>
    {editNickname && <NicknameDialog key={conflict ? 'conflict' : 'edit'} user={user} roomClient={roomClient} onUpdate={setUser} conflict={conflict} onClose={() => { setEditNickname(false); setConflict(false); }} t={t} />}
    {inviteOpen && <InvitationDialog invitation={invitation} onClose={() => setInviteOpen(false)} t={t} />}
  </div>;
}

function getInitialInvitation() {
  try { return { invitation: readInvitation(), invalid: false }; }
  catch { return { invitation: null, invalid: true }; }
}

export default function App() {
  const [language, setLanguage] = useState(readLanguage);
  const [stage, setStage] = useState('welcome');
  const [initial] = useState(getInitialInvitation);
  const [invitation, setInvitation] = useState(initial.invitation);
  const [invalidInvitation, setInvalidInvitation] = useState(initial.invalid);
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);
  const t = useMemo(() => getT(language), [language]);
  useEffect(() => { document.documentElement.lang = language; document.title = `Chattamento — ${t('tagline')}`; }, [language, t]);
  useEffect(() => {
    const openInvitation = () => {
      try { setInvitation(readInvitation()); setInvalidInvitation(false); }
      catch { setInvitation(null); setInvalidInvitation(true); }
      setSession(null); setUser(null); setStage('welcome'); setError(null);
    };
    window.addEventListener('hashchange', openInvitation);
    return () => window.removeEventListener('hashchange', openInvitation);
  }, []);
  const chooseLanguage = next => { setLanguage(next); saveLanguage(next); setError(null); };
  const join = nickname => {
    const trimmed = nickname.trim().normalize('NFKC');
    if ([...trimmed].length < 2 || [...trimmed].length > 24 || !/^[\p{L}\p{N} _-]+$/u.test(trimmed)) { setError(new RoomError('invalid_nickname')); return; }
    try {
      const selectedInvitation = invitation || createInvitation();
      const client = createPeerRoom({ ...selectedInvitation, nickname: trimmed, language });
      if (!invitation) { history.replaceState(null, '', invitationUrl(selectedInvitation)); setInvitation(selectedInvitation); }
      setUser(client.user || { id: 'connecting', nickname: trimmed, language });
      setSession({ client, invitation: selectedInvitation }); setError(null); setStage('chat');
    } catch (err) { setError(err); }
  };
  if (invalidInvitation) return <main className="invalid-invite-screen"><Logo /><span className="card-symbol"><Icon name="info" size={27} /></span><h1>{t('invalidInviteTitle')}</h1><p>{t('invalidInviteDescription')}</p><button type="button" className="button button-primary" onClick={() => { history.replaceState(null, '', `${location.pathname}${location.search}`); setInvalidInvitation(false); setInvitation(null); }}>{t('newRoom')}<Icon name="arrow" size={17} /></button></main>;
  if (stage === 'chat' && session && user) return <Chat session={session} user={user} setUser={setUser} language={language} setLanguage={setLanguage} onLeave={() => { history.replaceState(null, '', `${location.pathname}${location.search}`); setInvitation(null); setSession(null); setUser(null); setStage('nickname'); }} t={t} />;
  return <Welcome step={stage} setStep={next => { setStage(next); setError(null); }} language={language} onLanguage={chooseLanguage} onJoin={join} busy={false} error={error} hasInvitation={Boolean(invitation)} t={t} />;
}
