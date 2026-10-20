import { useCallback, useEffect, useRef, useState } from 'react';

function mediaError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError') return 'permissionDenied';
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return 'noDevice';
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') return 'deviceBusy';
  return 'joinFailed';
}

/** Media stays inside the invite-only peer room. The room owns WebRTC negotiation. */
export function useCall({ roomClient, user, users = [] }) {
  const [active, setActive] = useState(false);
  const [joining, setJoining] = useState(false);
  const [localStream, setLocalStream] = useState(null);
  const [peers, setPeers] = useState([]);
  const [audio, setAudio] = useState(false);
  const [video, setVideo] = useState(false);
  const [mode, setMode] = useState('audio');
  const [handsFree, setHandsFree] = useState(false);
  const [cameraBusy, setCameraBusy] = useState(false);
  const [error, setError] = useState(null);
  const clientRef = useRef(roomClient);
  const userRef = useRef(user);
  const usersRef = useRef(users);
  const activeRef = useRef(false);
  const joiningRef = useRef(false);
  const modeRef = useRef('audio');
  const handsFreeRef = useRef(false);
  const mediaRef = useRef({ audio: false, video: false });
  const streamRef = useRef(null);
  const sentPeersRef = useRef(new Set());
  const remoteStreamsRef = useRef(new Map());
  const generationRef = useRef(0);
  const cameraBusyRef = useRef(false);
  const mountedRef = useRef(true);

  clientRef.current = roomClient;
  userRef.current = user;
  usersRef.current = users;

  const syncPeers = useCallback(() => {
    if (!mountedRef.current) return;
    const participants = usersRef.current.filter((person) => person.id !== userRef.current?.id && person.inCall);
    setPeers(participants.map((person) => ({
      id: person.id,
      nickname: person.nickname,
      stream: remoteStreamsRef.current.get(person.id) || null,
      state: remoteStreamsRef.current.has(person.id) ? 'connected' : 'connecting',
    })));
  }, []);

  const broadcastMedia = useCallback(() => {
    const client = clientRef.current;
    if (activeRef.current && client) {
      Promise.resolve(client.setCallState({ inCall: true, ...mediaRef.current })).catch(() => {
        if (mountedRef.current && activeRef.current) setError('disconnected');
      });
    }
  }, []);

  const reconcileParticipants = useCallback((participants) => {
    usersRef.current = participants || [];
    if (!activeRef.current || !streamRef.current) return;
    const client = clientRef.current;
    const stream = streamRef.current;
    const generation = generationRef.current;
    const targets = new Set(usersRef.current.filter((person) => person.id !== userRef.current?.id && person.inCall).map((person) => person.id));
    for (const peerId of [...sentPeersRef.current]) {
      if (targets.has(peerId)) continue;
      sentPeersRef.current.delete(peerId);
      remoteStreamsRef.current.delete(peerId);
      Promise.resolve(client.removeStream(stream, peerId)).catch(() => {});
    }
    for (const peerId of targets) {
      if (sentPeersRef.current.has(peerId)) continue;
      sentPeersRef.current.add(peerId);
      Promise.resolve(client.addStream(stream, peerId)).then(() => {
        // A permission dialog, leave, or another participant's departure can
        // finish while the room is negotiating the stream.
        if (generation !== generationRef.current || !activeRef.current || !sentPeersRef.current.has(peerId)) {
          Promise.resolve(client.removeStream(stream, peerId)).catch(() => {});
        }
      }).catch(() => {
        sentPeersRef.current.delete(peerId);
        if (mountedRef.current && generation === generationRef.current && activeRef.current) setError('connectionFailed');
      });
    }
    syncPeers();
  }, [syncPeers]);

  const finish = useCallback((notify = true, client = clientRef.current) => {
    generationRef.current += 1;
    const wasActive = activeRef.current;
    const stream = streamRef.current;
    activeRef.current = false;
    joiningRef.current = false;
    cameraBusyRef.current = false;
    // Stop capture synchronously, even if signaling or negotiation is offline.
    stream?.getTracks().forEach((track) => track.stop());
    if (notify && wasActive && client) {
      Promise.resolve(client.setCallState({ inCall: false, audio: false, video: false })).catch(() => {});
      for (const peerId of sentPeersRef.current) {
        Promise.resolve(client.removeStream(stream, peerId)).catch(() => {});
      }
    }
    streamRef.current = null;
    sentPeersRef.current.clear();
    remoteStreamsRef.current.clear();
    mediaRef.current = { audio: false, video: false };
    handsFreeRef.current = false;
    if (mountedRef.current) {
      setActive(false);
      setJoining(false);
      setLocalStream(null);
      setAudio(false);
      setVideo(false);
      setHandsFree(false);
      setCameraBusy(false);
      setPeers([]);
    }
  }, []);

  const join = useCallback(async (withVideo = false) => {
    if (activeRef.current || joiningRef.current) return;
    setError(null);
    if (!window.isSecureContext) return setError('secureRequired');
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return setError('unsupported');
    const client = clientRef.current;
    if (!client?.connected) return setError('disconnected');
    joiningRef.current = true;
    setJoining(true);
    const generation = ++generationRef.current;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: withVideo ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } : false,
      });
      if (generation !== generationRef.current || !mountedRef.current || !client.connected || clientRef.current !== client) {
        stream.getTracks().forEach((track) => track.stop());
        if (generation === generationRef.current) finish(false, client);
        return;
      }
      // Audio starts as a walkie-talkie: capture is ready but muted until held.
      // Video calls use an ordinary hands-free microphone from the start.
      stream.getAudioTracks().forEach((track) => { track.enabled = withVideo; });
      streamRef.current = stream;
      mediaRef.current = { audio: withVideo, video: withVideo };
      modeRef.current = withVideo ? 'video' : 'audio';
      handsFreeRef.current = withVideo;
      activeRef.current = true;
      await client.setCallState({ inCall: true, ...mediaRef.current });
      if (generation !== generationRef.current || !mountedRef.current) return;
      setLocalStream(stream);
      setAudio(withVideo);
      setVideo(withVideo);
      setMode(modeRef.current);
      setHandsFree(withVideo);
      setActive(true);
      setJoining(false);
      joiningRef.current = false;
      reconcileParticipants(client.users || usersRef.current);
    } catch (cause) {
      if (generation !== generationRef.current || !mountedRef.current) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      finish(true, client);
      setError(mediaError(cause));
    }
  }, [finish, reconcileParticipants]);

  useEffect(() => {
    if (!roomClient) return;
    const onPresence = (event) => {
      const participants = Array.isArray(event) ? event : event.users || [];
      const local = participants.find((person) => person.id === userRef.current?.id);
      if (activeRef.current && local?.nicknameConflict) {
        finish(true, roomClient);
        setError('joinFailed');
        return;
      }
      reconcileParticipants(participants);
    };
    const onStream = ({ stream, peerId }) => {
      const person = usersRef.current.find((item) => item.id === peerId);
      if (!activeRef.current || !person?.inCall || peerId === userRef.current?.id) return;
      remoteStreamsRef.current.set(peerId, stream);
      syncPeers();
    };
    const onPeerLeft = ({ peerId }) => {
      sentPeersRef.current.delete(peerId);
      remoteStreamsRef.current.delete(peerId);
      usersRef.current = usersRef.current.filter((person) => person.id !== peerId);
      syncPeers();
    };
    const onStatus = (event) => {
      const status = typeof event === 'string' ? event : event.status;
      if (!['offline', 'error'].includes(status)) return;
      const wasActive = activeRef.current || joiningRef.current;
      finish(false, roomClient);
      if (wasActive) setError('disconnected');
    };
    roomClient.on('presence', onPresence);
    roomClient.on('stream', onStream);
    roomClient.on('peer-left', onPeerLeft);
    roomClient.on('status', onStatus);
    return () => {
      roomClient.off('presence', onPresence);
      roomClient.off('stream', onStream);
      roomClient.off('peer-left', onPeerLeft);
      roomClient.off('status', onStatus);
      finish(true, roomClient);
    };
  }, [roomClient, finish, reconcileParticipants, syncPeers]);

  useEffect(() => {
    reconcileParticipants(users);
  }, [users, reconcileParticipants]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      finish(true);
    };
  }, [finish]);

  const setAudioEnabled = useCallback((enabled) => {
    if (!activeRef.current) return;
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
    mediaRef.current.audio = enabled;
    setAudio(enabled);
    broadcastMedia();
  }, [broadcastMedia]);

  const startTalking = useCallback(() => {
    if (modeRef.current === 'audio' && !handsFreeRef.current) setAudioEnabled(true);
  }, [setAudioEnabled]);
  const stopTalking = useCallback(() => {
    if (modeRef.current === 'audio' && !handsFreeRef.current) setAudioEnabled(false);
  }, [setAudioEnabled]);

  useEffect(() => {
    const onVisibilityChange = () => { if (document.hidden) stopTalking(); };
    window.addEventListener('blur', stopTalking);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', stopTalking);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [stopTalking]);

  const toggleAudio = useCallback(() => setAudioEnabled(!mediaRef.current.audio), [setAudioEnabled]);
  const toggleHandsFree = useCallback(() => {
    handsFreeRef.current = !handsFreeRef.current;
    setHandsFree(handsFreeRef.current);
    setAudioEnabled(handsFreeRef.current);
  }, [setAudioEnabled]);

  const toggleVideo = useCallback(async () => {
    if (!activeRef.current || cameraBusyRef.current) return;
    setError(null);
    cameraBusyRef.current = true;
    setCameraBusy(true);
    const generation = generationRef.current;
    const client = clientRef.current;
    try {
      if (mediaRef.current.video) {
        const tracks = streamRef.current.getVideoTracks();
        // Stop the camera before asynchronous peer negotiation finishes.
        tracks.forEach((track) => { track.stop(); streamRef.current.removeTrack(track); });
        mediaRef.current.video = false;
        setVideo(false);
        broadcastMedia();
        await Promise.allSettled(tracks.flatMap((track) => [...sentPeersRef.current].map((peerId) => client.removeTrack(track, peerId))));
      } else {
        const camera = await navigator.mediaDevices.getUserMedia({
          audio: false, video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        });
        if (!activeRef.current || generation !== generationRef.current) {
          camera.getTracks().forEach((track) => track.stop());
          return;
        }
        const track = camera.getVideoTracks()[0];
        streamRef.current.addTrack(track);
        mediaRef.current.video = true;
        setVideo(true);
        await client.setCallState({ inCall: true, ...mediaRef.current });
        if (!activeRef.current || generation !== generationRef.current) return;
        await Promise.allSettled([...sentPeersRef.current].map((peerId) => client.addTrack(track, streamRef.current, peerId)));
      }
    } catch (cause) {
      if (activeRef.current && generation === generationRef.current) setError(mediaError(cause));
    } finally {
      if (generation === generationRef.current) {
        cameraBusyRef.current = false;
        if (mountedRef.current) setCameraBusy(false);
      }
    }
  }, [broadcastMedia]);

  return {
    active, joining, localStream, peers, audio, video, mode, handsFree, cameraBusy, error,
    join, leave: () => finish(true), toggleAudio, toggleVideo, toggleHandsFree,
    startTalking, stopTalking, clearError: () => setError(null),
  };
}
