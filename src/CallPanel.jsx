import { useEffect, useRef, useState } from 'react';
import { useCall } from './useCall';
import './call.css';

function Icon({ name, ...props }) {
  const paths = {
    phone: <path d="M8 3H4a1 1 0 0 0-1 1c0 9.39 7.61 17 17 17a1 1 0 0 0 1-1v-4l-5-2-2 2a14 14 0 0 1-6-6l2-2-2-5Z" />,
    hangup: <path d="M3.5 15.5 2 12c5.52-5.33 14.48-5.33 20 0l-1.5 3.5-5-1V11a12 12 0 0 0-7 0v3.5l-5 1Z" />,
    video: <><rect x="3" y="5" width="12" height="14" rx="3" /><path d="m15 10 6-4v12l-6-4" /></>,
    videoOff: <><path d="M9 5h3a3 3 0 0 1 3 3v2l6-4v12l-4-3M3 5v11a3 3 0 0 0 3 3h6a3 3 0 0 0 2.1-.9M2 2l20 20" /></>,
    mic: <><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></>,
    micOff: <><path d="M9 5a3 3 0 0 1 6 0v6M9 9v2a3 3 0 0 0 5 2M5 10v2a7 7 0 0 0 12 5m2-5v-2M12 19v3m-4 0h8M2 2l20 20" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    play: <path d="m9 5 11 7-11 7V5Z" />,
  };
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{paths[name]}</svg>;
}

function MediaTile({ stream, nickname, local = false, camera = false, muted = false, state, t }) {
  const videoRef = useRef(null);
  const [needsPlay, setNeedsPlay] = useState(false);
  useEffect(() => {
    const element = videoRef.current;
    if (!element || !stream) return;
    element.srcObject = stream;
    let cancelled = false;
    element.play().then(() => { if (!cancelled) setNeedsPlay(false); }).catch(() => {
      if (!cancelled && !local) setNeedsPlay(true);
    });
    return () => { cancelled = true; element.srcObject = null; };
  }, [stream, camera, local]);
  const play = () => videoRef.current?.play().then(() => setNeedsPlay(false)).catch(() => {});
  return <div className={`call-tile ${camera ? 'has-camera' : ''}`}>
    <video ref={videoRef} muted={local} autoPlay playsInline className={local ? 'call-local-video' : ''} aria-label={nickname} />
    {!camera && <div className="call-avatar" aria-hidden="true">{Array.from(nickname || '?')[0].toUpperCase()}</div>}
    <div className="call-tile-caption">
      <span>{nickname}{local ? ` · ${t('call.you')}` : ''}</span>
      {muted && <Icon name="micOff" width="14" height="14" />}
    </div>
    {!local && state !== 'connected' && <span className={`call-connection-state ${state === 'failed' ? 'failed' : ''}`}>{t(state === 'failed' ? 'call.failed' : 'call.connecting')}</span>}
    {needsPlay && <button type="button" className="call-play" onClick={play}><Icon name="play" />{t('call.play')}</button>}
  </div>;
}

export default function CallPanel({ roomClient, user, users = [], t, onCallStateChange }) {
  const call = useCall({ roomClient, user, users });
  const inCall = users.filter((item) => item.inCall && item.id !== user?.id);
  useEffect(() => { onCallStateChange?.(call.active); }, [call.active, onCallStateChange]);

  return <section className={`call-panel ${call.active ? 'call-panel-active' : ''}`} aria-label={t('call.title')}>
    {!call.active ? <div className="call-start-row">
      <div className="call-invitation">
        <span className="call-invitation-icon"><Icon name={inCall.length ? 'phone' : 'video'} /></span>
        <span><strong>{t('call.title')}</strong><small>{inCall.length ? t('call.people', { count: inCall.length }) : t('call.subtitle')}</small></span>
        {inCall.length > 0 && <span className="call-live-dot" />}
      </div>
      <div className="call-start-actions">
        <button type="button" className="call-start-button" disabled={call.joining || !roomClient?.connected} onClick={() => call.join(false)}>
          <Icon name="phone" /><span>{t(call.joining ? 'call.joining' : 'call.audio')}</span>
        </button>
        <button type="button" className="call-start-button call-start-primary" disabled={call.joining || !roomClient?.connected} onClick={() => call.join(true)}>
          <Icon name="video" /><span>{t(call.joining ? 'call.joining' : 'call.video')}</span>
        </button>
      </div>
    </div> : <>
      <div className="call-active-heading"><span><i className="call-live-dot" />{t('call.live')}<span className="call-participant-count">{call.peers.length + 1}</span></span></div>
      <div className="call-video-grid">
        <MediaTile stream={call.localStream} nickname={user?.nickname} local camera={call.video} muted={!call.audio} t={t} />
        {call.peers.map((peer) => {
          const person = users.find((item) => item.id === peer.id);
          return <MediaTile key={peer.id} stream={peer.stream} nickname={person?.nickname || peer.nickname} camera={person?.video === true} muted={person?.audio === false} state={peer.state} t={t} />;
        })}
        {call.peers.length === 0 && <div className="call-waiting"><span className="call-waiting-rings"><Icon name="phone" width="23" height="23" /></span><span>{t('call.waiting')}</span></div>}
      </div>
      {call.mode === 'audio' && !call.handsFree && <div className="call-walkie">
        <button
          type="button"
          className={`call-talk-button ${call.audio ? 'call-talk-active' : ''}`}
          aria-pressed={call.audio}
          aria-describedby="walkie-hint"
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            call.startTalking();
          }}
          onPointerUp={call.stopTalking}
          onPointerCancel={call.stopTalking}
          onLostPointerCapture={call.stopTalking}
          onKeyDown={event => {
            if ([' ', 'Enter'].includes(event.key)) {
              event.preventDefault();
              if (!event.repeat) call.startTalking();
            }
          }}
          onKeyUp={event => {
            if ([' ', 'Enter'].includes(event.key)) {
              event.preventDefault();
              call.stopTalking();
            }
          }}
          onBlur={call.stopTalking}
        ><Icon name="mic" /><span>{t(call.audio ? 'call.talking' : 'call.holdToTalk')}</span></button>
        <span id="walkie-hint">{t('call.walkieHint')}</span>
      </div>}
      <div className="call-controls">
        {(call.mode === 'video' || call.handsFree) && <button type="button" className={`call-control ${call.audio ? '' : 'call-control-off'}`} onClick={call.toggleAudio} aria-label={t(call.audio ? 'call.mute' : 'call.unmute')} title={t(call.audio ? 'call.mute' : 'call.unmute')} aria-pressed={!call.audio}><Icon name={call.audio ? 'mic' : 'micOff'} /></button>}
        {call.mode === 'audio' && <button type="button" className={`call-control call-hands-free ${call.handsFree ? 'call-control-off' : ''}`} onClick={call.toggleHandsFree} aria-label={t(call.handsFree ? 'call.walkieMode' : 'call.handsFree')} title={t(call.handsFree ? 'call.walkieMode' : 'call.handsFree')} aria-pressed={call.handsFree}><Icon name={call.handsFree ? 'mic' : 'micOff'} /><span>{t(call.handsFree ? 'call.walkieMode' : 'call.handsFree')}</span></button>}
        <button type="button" className={`call-control ${call.video ? '' : 'call-control-off'}`} onClick={call.toggleVideo} disabled={call.cameraBusy} aria-label={t(call.video ? 'call.cameraOff' : 'call.cameraOn')} title={t(call.video ? 'call.cameraOff' : 'call.cameraOn')} aria-pressed={call.video}><Icon name={call.video ? 'video' : 'videoOff'} /></button>
        <span className="call-controls-divider" />
        <button type="button" className="call-control call-hangup" onClick={() => call.leave()} aria-label={t('call.hangup')} title={t('call.hangup')}><Icon name="hangup" /><span>{t('call.hangup')}</span></button>
      </div>
    </>}
    {call.error && <div className="call-error" role="alert"><span>{t(`call.${call.error}`)}</span><button type="button" onClick={call.clearError} aria-label={t('call.closeError')}><Icon name="close" width="16" height="16" /></button></div>}
  </section>;
}
