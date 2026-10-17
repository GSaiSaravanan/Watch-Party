import { useCallback, useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'

const SERVER_URL = 'http://localhost:5000'

// Default video loaded into the player when a room is opened.
const DEFAULT_VIDEO_ID = 'dQw4w9WgXcQ'

// Random 6-char room code, e.g. "K7QM2X".
function generateRoomId(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let id = ''
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id
}

// Reads the room id from the URL hash, e.g. "#/room/XYZ123" -> "XYZ123".
function getRoomIdFromHash() {
  const match = window.location.hash.match(/#\/room\/([A-Za-z0-9]+)/)
  return match ? match[1].toUpperCase() : null
}

function goToRoom(roomId) {
  window.location.hash = `#/room/${roomId.toUpperCase()}`
}

function goHome() {
  window.location.hash = '#/'
}

// A creator token identifies the room's host across reconnects/tab refreshes.
// It lives in sessionStorage, which survives a refresh of the same tab but is
// NOT shared with tabs opened from a link — so link/code joiners never get it.
function generateCreatorToken() {
  const arr = new Uint8Array(16)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

function creatorTokenKey(roomId) {
  return `watchparty:creator:${roomId}`
}

function getCreatorToken(roomId) {
  try {
    return sessionStorage.getItem(creatorTokenKey(roomId))
  } catch {
    return null
  }
}

function setCreatorToken(roomId, token) {
  try {
    sessionStorage.setItem(creatorTokenKey(roomId), token)
  } catch {
    // storage may be unavailable; ignore
  }
}

// Extract an 11-char YouTube video id from a full URL, short link, embed
// URL, or a bare video id. Returns '' when nothing usable is found.
function extractVideoId(input) {
  const raw = String(input || '').trim()
  if (!raw) return ''
  const bare = /^[A-Za-z0-9_-]{11}$/
  if (bare.test(raw)) return raw
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`)
    if (url.hostname.includes('youtu.be')) {
      const id = url.pathname.slice(1).split(/[?&#/]/)[0]
      if (bare.test(id)) return id
    }
    if (url.hostname.includes('youtube.com')) {
      const v = url.searchParams.get('v')
      if (v && bare.test(v)) return v
      const parts = url.pathname.split('/').filter(Boolean)
      const embedIdx = parts.findIndex((p) => ['embed', 'shorts', 'live'].includes(p))
      if (embedIdx >= 0 && parts[embedIdx + 1] && bare.test(parts[embedIdx + 1])) {
        return parts[embedIdx + 1]
      }
    }
  } catch {
    // not a parseable URL — fall through
  }
  const m = raw.match(/[A-Za-z0-9_-]{11}/)
  return m ? m[0] : ''
}

// Stable per-tab guest name used for reaction sender tags + queue attribution.
function getOrCreateUsername() {
  try {
    const existing = sessionStorage.getItem('watchparty:username')
    if (existing && existing.trim()) return existing
    const fresh = `Guest-${Math.random().toString(36).slice(2, 6)}`
    sessionStorage.setItem('watchparty:username', fresh)
    return fresh
  } catch {
    return `Guest-${Math.random().toString(36).slice(2, 6)}`
  }
}

const EMOJI_PALETTE = ['❤️', '😂', '🍿', '🔥', '👏', '💀', '😮', '🎉']

// Format a playhead timestamp (seconds) as MM:SS or HH:MM:SS.
function formatBookmarkTime(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  const ss = String(sec).padStart(2, '0')
  if (h > 0) return `${h}:${mm}:${ss}`
  return `${mm}:${ss}`
}

function ConnectionBadge({ connected }) {
  return (
    <div className="flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm">
      <span
        role="status"
        aria-label={connected ? 'Connected' : 'Disconnected'}
        className={`inline-block h-2 w-2 rounded-full ${
          connected
            ? 'bg-emerald-400 shadow-sm shadow-emerald-400/80'
            : 'bg-red-500 shadow-sm shadow-red-500/80'
        }`}
      />
      <span className="text-sm font-medium text-zinc-300">{connected ? 'Connected' : 'Disconnected'}</span>
    </div>
  )
}

function HomeView({ onCreateRoom, onJoinByCode, connected }) {
  const [code, setCode] = useState('')

  const handleSubmit = (e) => {
    e.preventDefault()
    const trimmed = code.trim()
    if (!trimmed) return
    onJoinByCode(trimmed)
  }

  return (
    <div className="wp-glow-bg relative flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-4 text-zinc-100">
      <div className="absolute right-4 top-4">
        <ConnectionBadge connected={connected} />
      </div>

      <div className="w-full max-w-md rounded-3xl border border-white/10 bg-zinc-900/60 p-8 shadow-2xl shadow-black/60 backdrop-blur-xl">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-linear-to-br from-indigo-500 to-fuchsia-500 text-xl shadow-lg shadow-indigo-500/40">
          🍿
        </div>
        <h1 className="mb-1 text-center text-3xl font-bold tracking-tight">
          <span className="bg-linear-to-r from-indigo-300 via-white to-fuchsia-300 bg-clip-text text-transparent">
            Watch Party
          </span>
        </h1>
        <p className="mb-8 text-center text-sm text-zinc-400">
          Watch videos together, in sync.
        </p>

        <button
          type="button"
          onClick={onCreateRoom}
          className="mb-6 w-full rounded-xl bg-linear-to-r from-indigo-500 to-indigo-400 px-4 py-3 font-semibold text-white shadow-lg shadow-indigo-500/30 transition duration-200 hover:-translate-y-0.5 hover:shadow-xl hover:shadow-indigo-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
        >
          Create Room
        </button>

        <div className="mb-6 flex items-center gap-3 text-xs uppercase text-zinc-500">
          <span className="h-px flex-1 bg-white/10" />
          or
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <form onSubmit={handleSubmit}>
          <label
            htmlFor="room-code"
            className="mb-2 block text-sm font-medium text-zinc-300"
          >
            Enter Room Code
          </label>
          <div className="flex gap-2">
            <input
              id="room-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABC123"
              maxLength={12}
              autoComplete="off"
              className="w-full rounded-xl border border-white/10 bg-zinc-950/70 px-4 py-3 font-mono text-lg uppercase tracking-widest text-white placeholder:text-zinc-600 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
            <button
              type="submit"
              className="rounded-xl border border-white/10 bg-white/5 px-5 py-3 font-semibold text-zinc-200 transition duration-200 hover:border-indigo-400/40 hover:bg-indigo-500/15 hover:text-indigo-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              Join
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}


function ParticipantsModal({ participants, hostName, onClose }) {
  // Allow dismissing with the Escape key.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Participants"
    >
      <div
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/80 shadow-2xl shadow-black/60 backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <h2 className="text-base font-semibold text-white">
            Participants ({participants.length})
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-zinc-400 transition hover:bg-white/10 hover:text-zinc-100"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <ul className="wp-scrollbar max-h-80 space-y-1 overflow-y-auto p-3">
          {participants.length === 0 && (
            <li className="px-2 py-3 text-sm text-zinc-500">No participants yet.</li>
          )}
          {participants.map((name, i) => (
            <li
              key={`${name}-${i}`}
              className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-white/5"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/70" />
              <span className="flex-1 truncate text-sm text-zinc-200">{name}</span>
              {hostName && name === hostName && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-indigo-400/40 bg-indigo-500/15 px-2 py-0.5 text-xs font-semibold text-indigo-300">
                  ★ Host
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function RoomView({ roomId, room, socketId, username, onLeave, connected, media, syncInit, hostHeartbeat, onMediaAction, onHeartbeat, onRequestSync, chatMessages, reaction, latencyMs, queue, bookmarks, onSendChat, onSendReaction, onAddToQueue, onRemoveFromQueue, onPlayQueued, onAddBookmark, onDeleteBookmark, onJumpToBookmark }) {
  const [copied, setCopied] = useState(false)
  const [activeTab, setActiveTab] = useState('chat')
  const [chatInput, setChatInput] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const [queueError, setQueueError] = useState('')
  const [showParticipants, setShowParticipants] = useState(false)
  const [showBookmarks, setShowBookmarks] = useState(true)
  const safeBookmarks = bookmarks?.map ? bookmarks : []
  // Muted-autoplay state: guests start muted so sync_init seek+play is not
  // blocked by autoplay policies; overlay button offers one-tap unmute.
  const [muted, setMuted] = useState(true)
  // Guest "peek" mode: while reviewing a bookmark, drift auto-snap pauses so
  // the heartbeat engine doesn't yank the guest back to live. Host stays
  // authoritative — host jumps emit media_action seek for the whole room.
  const [isPeeking, setIsPeeking] = useState(false);
  const [peekTime, setPeekTime] = useState(null);
  // Video the guest was watching before peeking at another video's bookmark.
  const [peekVideoId, setPeekVideoId] = useState(null);
  // Step 6 — floating emoji reactions overlaying the video (each floats up
  // and fades out over 2s; removed by timer).
  const [floaters, setFloaters] = useState([])
  // Step 6 — diagnostics drawer state: local playback drift vs host (ms).
  const [driftMs, setDriftMs] = useState(null)
  const [showDiag, setShowDiag] = useState(true)

  // --- YouTube player + sync engine refs ---
  const playerRef = useRef(null)
  const isRemoteUpdate = useRef(false)
  const playerReadyRef = useRef(false)
  const pendingSyncRef = useRef(null)
  const remoteTimerRef = useRef(null)
  const isHostRef = useRef(false)
  const lastSyncRef = useRef(null)
  const hostMediaRef = useRef(null)
  // Video currently loaded in the local player (for sync_init switches).
  const loadedVideoIdRef = useRef(DEFAULT_VIDEO_ID)
  // Latest host heartbeat payload (playhead ping).
  const heartbeatRef = useRef(null)

  const isHost = Boolean(room.hostId) && room.hostId === socketId
  const inviteLink = `${window.location.origin}${window.location.pathname}#/room/${roomId}`

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard may be unavailable; ignore
    }
  }

  // Step 6 — live chat: emit to the server, which broadcasts to the room.
  // The server resolves the sender name from join_room state; all clients
  // (including us) render the message when 'chat_message' comes back.
  const sendMessage = (e) => {
    e.preventDefault()
    const text = chatInput.trim()
    if (!text) return
    onSendChat(text)
    setChatInput('')
  }

  // Step 6 — emoji reaction: emit to the server for room-wide broadcast.
  const sendReaction = (emoji) => {
    onSendReaction(emoji)
  }

  // Format a message timestamp as HH:MM.
  const formatTime = (ts) => {
    if (!ts) return ''
    try {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    } catch {
      return ''
    }
  }

  const addVideo = (e) => {
    e.preventDefault()
    const raw = videoUrl.trim()
    if (!raw) return
    const videoId = extractVideoId(raw)
    if (!videoId) {
      setQueueError('Could not find a YouTube video ID in that link.')
      return
    }
    setQueueError('')
    onAddToQueue(videoId, raw)
    setVideoUrl('')
  }

  // Host "Play Now": load the queued video locally, tell the server it is
  // the current video (media_action relay + accurate buffer), then drop it
  // from the shared queue so every client converges.
  const playQueued = (index) => {
    const item = queue[index]
    if (!item || !item.videoId) return
    const player = playerRef.current
    if (player && playerReadyRef.current && typeof player.loadVideoById === 'function') {
      loadedVideoIdRef.current = item.videoId
      isRemoteUpdate.current = true
      clearTimeout(remoteTimerRef.current)
      remoteTimerRef.current = setTimeout(() => {
        isRemoteUpdate.current = false
      }, 500)
      try {
        player.loadVideoById({ videoId: item.videoId, startSeconds: 0 })
      } catch {
        // player not ready; server relay still switches guests
      }
    }
    onPlayQueued(index, item.videoId)
  }

  // Host Bookmarking: capture the current playhead + video and emit
  // 'add_bookmark' immediately with a 'Bookmark at MM:SS' label. No
  // window.prompt() here — blocking the event loop pauses heartbeats and
  // causes massive playback drift (85s+) for the whole room.
  const bookmarkMoment = () => {
    const player = playerRef.current;
    let time = 0;
    try {
      if (player && typeof player.getCurrentTime === 'function') {
        time = player.getCurrentTime();
      } else if (playerRef?.current && typeof playerRef.current.getCurrentTime === 'function') {
        time = playerRef.current.getCurrentTime();
      } else if (hostMediaRef?.current?.currentTime) {
        time = hostMediaRef.current.currentTime;
      }
    } catch (e) { time = 0; }
    console.log('[CLIENT] Bookmark button clicked, extracted time:', time);
    const vid = loadedVideoIdRef?.current || 'dQw4w9WgXcQ';
    const m = Math.floor(time / 60);
    const s = String(Math.floor(time % 60)).padStart(2, '0');
    onAddBookmark(time, vid, 'Bookmark at ' + m + ':' + s);
  }

  // Host "Jump to Scene": seek locally under the isRemoteUpdate guard (so the
  // resulting state change is not echoed), then emit media_action seek so all
  // participants jump to the bookmarked scene in sync. Guests may also jump
  // locally via the list (their seek stays local and never emits).
  // Bookmark "Jump to Scene" (video-aware): if the bookmark lives on a
  // different video, load that video at the saved timestamp. Host jumps emit
  // media_action so the whole room switches together; guest jumps stay local
  // (peek mode) and remember the live video so Catch Up restores it.
  const jumpToBookmark = (bookmark) => {
    const ts = typeof bookmark === 'number' ? bookmark : bookmark?.timestamp
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return
    const bmVideoId = typeof bookmark?.videoId === 'string' && bookmark.videoId
      ? bookmark.videoId
      : null
    const currentVideoId = loadedVideoIdRef.current
      || hostMediaRef.current?.currentVideoId
      || DEFAULT_VIDEO_ID
    const needsVideoSwitch = bmVideoId && bmVideoId !== currentVideoId
    const player = playerRef.current
    const guarded = (fn) => {
      isRemoteUpdate.current = true
      clearTimeout(remoteTimerRef.current)
      remoteTimerRef.current = setTimeout(() => {
        isRemoteUpdate.current = false
      }, 500)
      try {
        fn()
      } catch {
        // player not ready; server relay still moves guests
      }
    }
    if (needsVideoSwitch) {
      if (!player || !playerReadyRef.current || typeof player.loadVideoById !== 'function') {
        // Can't switch locally; host path still emits so guests converge.
        if (isHost) onJumpToBookmark({ timestamp: ts, videoId: bmVideoId })
        else { setIsPeeking(true); setPeekTime(ts); setPeekVideoId(currentVideoId); }
        return
      }
      loadedVideoIdRef.current = bmVideoId
      if (isHost) {
        guarded(() => {
          player.loadVideoById({ videoId: bmVideoId, startSeconds: ts })
          if (typeof player.playVideo === 'function') player.playVideo()
        })
        // Authoritative room-wide switch via App handler: emits change_video
        // so receivers load the video at ts via the guarded path.
        onJumpToBookmark({ timestamp: ts, videoId: bmVideoId })
      } else {
        // Guest peek: load the bookmark's video locally, remember the live
        // video so Catch Up restores both video AND timestamp.
        guarded(() => {
          player.loadVideoById({ videoId: bmVideoId, startSeconds: ts })
        })
        setIsPeeking(true);
        setPeekTime(ts);
        setPeekVideoId(currentVideoId);
      }
      return
    }
    if (player && playerReadyRef.current && typeof player.seekTo === 'function') {
      isRemoteUpdate.current = true
      clearTimeout(remoteTimerRef.current)
      remoteTimerRef.current = setTimeout(() => {
        isRemoteUpdate.current = false
      }, 500)
      try {
        player.seekTo(ts, true)
      } catch {
        // player not ready; server relay still moves guests
      }
    }
    if (isHost) {
      onJumpToBookmark(bookmark?.timestamp !== undefined ? bookmark : { timestamp: ts, videoId: loadedVideoIdRef.current })
    } else {
      // Guest peek: review locally, no media_action emit (host/room unaffected).
      setIsPeeking(true);
      setPeekTime(ts);
      setPeekVideoId(null);
    }
  }

  // Guest "Catch Up to Live": leave peek mode and restore the host's live
  // video AND timestamp via the existing guarded sync path, resuming
  // heartbeat tracking.
  const catchUpToLive = () => {
    setIsPeeking(false);
    setPeekTime(null);
    const restoreVideoId = peekVideoId;
    setPeekVideoId(null);
    const hostTime = getHostCurrentTime()
    // Prefer the host's live video (heartbeat buffer) over the stale local
    // ref: after peeking at another video, loadedVideoIdRef points at the
    // peeked video, not the host's. Fall back to the remembered peek origin.
    const hostVideoId = hostMediaRef.current?.currentVideoId || null
    const targetVideoId = hostVideoId || restoreVideoId || loadedVideoIdRef.current || DEFAULT_VIDEO_ID
    const player = playerRef.current
    if (hostTime == null || !player || !playerReadyRef.current) return
    isRemoteUpdate.current = true
    clearTimeout(remoteTimerRef.current)
    remoteTimerRef.current = setTimeout(() => {
      isRemoteUpdate.current = false
    }, 500)
    try {
      if (targetVideoId && targetVideoId !== loadedVideoIdRef.current && typeof player.loadVideoById === 'function') {
        loadedVideoIdRef.current = targetVideoId
        player.loadVideoById({ videoId: targetVideoId, startSeconds: hostTime })
      } else if (typeof player.seekTo === 'function') {
        player.seekTo(hostTime, true)
      }
      if (typeof player.playVideo === 'function') player.playVideo()
    } catch {
      // next heartbeat will retry
    }
  }

  const tabClass = (tab) =>
    `flex-1 rounded-xl px-4 py-2 text-sm font-semibold transition duration-200 ${
      activeTab === tab
        ? 'bg-indigo-500/20 text-white shadow-sm shadow-indigo-500/30 ring-1 ring-indigo-400/40'
        : 'text-zinc-400 ring-1 ring-transparent hover:bg-white/5 hover:text-zinc-200'
    }`

  // --- YouTube IFrame player + sync engine --------------------------------

  // Keep isHostRef in sync so the (mount-only) player callbacks read the
  // latest host status without needing to be re-registered.
  useEffect(() => {
    isHostRef.current = isHost
  }, [isHost])

  // Apply a media action to the local player, flagging it as a programmatic
  // (remote) update so the resulting state-change event is not echoed back.
  // Accepts both legacy { action, currentTime } packets and Step 5
  // { currentVideoId, isPlaying, currentTime } packets.
  const applyMediaToPlayer = useCallback((data) => {
    const player = playerRef.current
    if (!data || !player || !playerReadyRef.current) return

    const incomingVideoId = typeof data.videoId === 'string' && data.videoId
      ? data.videoId
      : typeof data.currentVideoId === 'string' && data.currentVideoId
        ? data.currentVideoId
        : null
    const incomingAction = typeof data.action === 'string' ? data.action : null
    const incomingPlaying = incomingAction === 'change_video'
      ? true
      : typeof data.isPlaying === 'boolean'
        ? data.isPlaying
        : data.action === 'play'

    // Switch video if the packet names a different one (sync_init / queue).
    if (incomingVideoId && incomingVideoId !== loadedVideoIdRef.current) {
      loadedVideoIdRef.current = incomingVideoId
      isRemoteUpdate.current = true
      // Reset the flag shortly after; YouTube fires onStateChange asynchronously.
      clearTimeout(remoteTimerRef.current)
      remoteTimerRef.current = setTimeout(() => {
        isRemoteUpdate.current = false
      }, 500)
      const t = typeof data.currentTime === 'number' ? data.currentTime : 0
      if (typeof player.loadVideoById === 'function') {
        if (incomingPlaying) {
          player.loadVideoById({ videoId: incomingVideoId, startSeconds: t })
        } else {
          player.cueVideoById({ videoId: incomingVideoId, startSeconds: t })
        }
      }
      return
    }

    isRemoteUpdate.current = true
    // Reset the flag shortly after; YouTube fires onStateChange asynchronously.
    clearTimeout(remoteTimerRef.current)
    remoteTimerRef.current = setTimeout(() => {
      isRemoteUpdate.current = false
    }, 500)

    const time = typeof data.currentTime === 'number' ? data.currentTime : 0
    const action = incomingPlaying ? 'play' : incomingAction === 'seek' ? 'seek' : 'pause'
    if (action === 'play') {
      player.seekTo(time, true)
      player.playVideo()
    } else if (action === 'pause') {
      player.pauseVideo()
    } else if (action === 'seek') {
      player.seekTo(time, true)
    }
  }, [])

  // Remember the latest host media we received, plus the local wall-clock time
  // we received it, so we can estimate the host's live playhead position.
  // Accepts both legacy media_action packets and Step 5 sync_init packets.
  useEffect(() => {
    const packet = syncInit || media
    if (!packet) return
    hostMediaRef.current = {
      action: typeof packet.isPlaying === 'boolean'
        ? (packet.isPlaying ? 'play' : 'pause')
        : packet.action,
      currentTime: packet.currentTime,
      currentVideoId: packet.currentVideoId,
      receivedAt: Date.now(),
    }
  }, [media, syncInit])

  // Best-effort estimate of where the host's playhead is right now. Returns
  // null if we've never received host media. Fresh heartbeats take precedence
  // over older media packets.
  const getHostCurrentTime = useCallback(() => {
    const hb = heartbeatRef.current
    if (hb && typeof hb.currentTime === 'number' && typeof hb.receivedAt === 'number') {
      const wasPlaying = hb.isPlaying !== false
      if (wasPlaying) {
        return hb.currentTime + (Date.now() - hb.receivedAt) / 1000
      }
      return hb.currentTime
    }
    const m = hostMediaRef.current
    if (!m) return null
    const base = typeof m.currentTime === 'number' ? m.currentTime : 0
    if (m.action === 'play') {
      return base + (Date.now() - m.receivedAt) / 1000
    }
    return base
  }, [])

  // Step 5 heartbeat drift check (guests only): active snap on every
  // heartbeat — if drift > 0.4s, force seekTo(hostTime)+playVideo under the
  // isRemoteUpdate guard so no event bounces back to the server.
  useEffect(() => {
    if (!hostHeartbeat || isHostRef.current) return
    if (isPeeking) return; // Do NOT auto-snap if guest is intentionally reviewing a bookmarked moment!
    const hostTime = typeof hostHeartbeat.currentTime === 'number'
      ? hostHeartbeat.currentTime
      : null
    if (hostTime == null) return
    heartbeatRef.current = {
      currentTime: hostTime,
      isPlaying: hostHeartbeat.isPlaying,
      receivedAt: Date.now(),
    }
    if (!playerRef.current || hostTime === undefined) return
    let localTime = 0;
    try { localTime = playerRef.current.getCurrentTime(); } catch (e) { /* ignore */ }
    if (typeof localTime !== 'number' || !Number.isFinite(localTime)) return
    // Do not fight the player while it is still buffering/cued.
    if (playerRef.current.getPlayerState && playerRef.current.getPlayerState() === window.YT.PlayerState.CUED) return
    const drift = Math.abs(localTime - hostTime);
    if (drift > 0.4) {
      isRemoteUpdate.current = true;
      try {
        playerRef.current.seekTo(hostTime, true);
        if (typeof playerRef.current.playVideo === 'function') playerRef.current.playVideo();
      } catch {
        // player not ready; next heartbeat will retry
      }
      clearTimeout(remoteTimerRef.current)
      setTimeout(() => { isRemoteUpdate.current = false; }, 400);
    }
  }, [hostHeartbeat, isPeeking])

  // Load the YouTube IFrame API once and create the player.
  useEffect(() => {
    let cancelled = false

    const createPlayer = () => {
      if (cancelled || playerRef.current) return
      playerRef.current = new window.YT.Player('yt-player', {
        videoId: DEFAULT_VIDEO_ID,
        // Muted autoplay: browsers block unmuted autoplay, which left guest
        // tabs stuck at 0s (tens of seconds of drift) until clicked. Starting
        // muted lets sync_init seek+play succeed instantly for real <=500ms
        // drift; guests unmute via the overlay button.
        playerVars: { rel: 0, modestbranding: 1, autoplay: 1, mute: 1 },
        events: {
          onReady: () => {
            playerReadyRef.current = true
            try {
              if (typeof playerRef.current?.mute === 'function') playerRef.current.mute()
            } catch {
              // mute not available; autoplay may require a click
            }
            try {
              setMuted(
                typeof playerRef.current?.isMuted === 'function'
                  ? playerRef.current.isMuted()
                  : true,
              )
            } catch {
              setMuted(true)
            }
            // Apply any media state that arrived before the player was ready.
            if (pendingSyncRef.current) {
              const pending = pendingSyncRef.current
              pendingSyncRef.current = null
              applyMediaToPlayer(pending)
            }
          },
          onStateChange: (event) => {
            // Ignore state changes we caused ourselves via applyMediaToPlayer.
            if (isRemoteUpdate.current) return

            const player = event.target
            const currentTime = player.getCurrentTime ? player.getCurrentTime() : 0
            const YTState = window.YT.PlayerState

            if (isHostRef.current) {
              // Only the host drives playback for the room. Include the loaded
              // video id so the server buffer tracks which video is playing.
              if (event.data === YTState.PLAYING) {
                onMediaAction('play', currentTime, loadedVideoIdRef.current)
              } else if (event.data === YTState.PAUSED) {
                onMediaAction('pause', currentTime, loadedVideoIdRef.current)
              }
              return
            }

            // Guest catch-up on local unpause: if this client just started
            // playing but has drifted from the host, snap to the host's
            // position before continuing. Guarded by isRemoteUpdate so the
            // resulting seek/play events are not echoed back to the server.
            if (event.data === YTState.PLAYING) {
              const hostTime = getHostCurrentTime()
              if (hostTime != null && Math.abs(currentTime - hostTime) > 1.5) {
                isRemoteUpdate.current = true
                clearTimeout(remoteTimerRef.current)
                remoteTimerRef.current = setTimeout(() => {
                  isRemoteUpdate.current = false
                }, 500)
                player.seekTo(hostTime, true)
                player.playVideo()
              }
            }
          },
        },
      })
    }

    if (window.YT && window.YT.Player) {
      createPlayer()
      return () => {
        cancelled = true
      }
    }

    // Wire up the global ready callback, preserving any previous handler.
    const previousReady = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousReady === 'function') previousReady()
      createPlayer()
    }

    if (!document.getElementById('yt-iframe-api')) {
      const tag = document.createElement('script')
      tag.id = 'yt-iframe-api'
      tag.src = 'https://www.youtube.com/iframe_api'
      document.head.appendChild(tag)
    }

    return () => {
      cancelled = true
      if (playerRef.current && playerRef.current.destroy) {
        playerRef.current.destroy()
        playerRef.current = null
      }
    }
  }, [applyMediaToPlayer, onMediaAction, getHostCurrentTime])

  // React to media actions received from the server (host actions + late-join
  // sync). Step 5 'sync_init' packets take precedence: a newcomer jumps
  // directly to the current video, spot, and play state. Because the player
  // starts muted, the browser permits immediate seekTo+playVideo on
  // sync_init, so real measured drift stays <=500ms. All application is
  // routed through applyMediaToPlayer, which holds the isRemoteUpdate guard.
  useEffect(() => {
    const packet = syncInit || media
    if (!packet) return
    if (playerReadyRef.current) {
      applyMediaToPlayer(packet)
    } else {
      // Player not ready yet; stash it and apply once ready.
      pendingSyncRef.current = packet
    }
  }, [media, syncInit, applyMediaToPlayer])

  // Host seek detection: poll the player time and emit a 'seek' when the host
  // jumps the playhead by a meaningful amount (drag/scrub on the timeline).
  useEffect(() => {
    if (!isHost) return
    const interval = setInterval(() => {
      const player = playerRef.current
      if (!player || !playerReadyRef.current) return
      if (typeof player.getCurrentTime !== 'function') return
      // Only track while playing to avoid noise.
      if (player.getPlayerState && player.getPlayerState() !== 1) return

      const t = player.getCurrentTime()
      const last = lastSyncRef.current
      if (last != null && Math.abs(t - last) > 1.5) {
        onMediaAction('seek', t, loadedVideoIdRef.current)
      }
      lastSyncRef.current = t
    }, 1000)
    return () => clearInterval(interval)
  }, [isHost, onMediaAction])

  // Host heartbeat (Step 5): every 2s the host emits its current playhead so
  // the server can refresh the room buffer and guests can drift-correct.
  // Only runs for the host; guests never emit.
  useEffect(() => {
    if (!isHost) return
    const interval = setInterval(() => {
      const player = playerRef.current
      if (!player || !playerReadyRef.current) return
      if (typeof player.getCurrentTime !== 'function') return
      const t = player.getCurrentTime()
      onHeartbeat(t)
    }, 2000)
    return () => clearInterval(interval)
  }, [isHost, onHeartbeat])

  // Step 6 — floating reactions: on every 'reaction' packet, spawn a badge
  // (emoji + sender name tag) that floats up and fades out over 2s, then
  // remove it by timer. Updates are scheduled asynchronously (timer
  // callbacks) to keep the effect body free of synchronous setState
  // (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!reaction) return
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const left = 10 + Math.random() * 80 // random horizontal position (%)
    const emoji = reaction.emoji
    const sender = typeof reaction.sender === 'string' && reaction.sender
      ? reaction.sender.slice(0, 32)
      : 'Guest'
    const addTimer = setTimeout(() => {
      setFloaters((prev) => [...prev.slice(-11), { id, emoji, sender, left }])
    }, 0)
    const removeTimer = setTimeout(() => {
      setFloaters((prev) => prev.filter((f) => f.id !== id))
    }, 2000)
    return () => {
      clearTimeout(addTimer)
      clearTimeout(removeTimer)
    }
  }, [reaction])

  // Step 6 — drift sampling: every 2s compare the local playhead to the
  // estimated host time (getHostCurrentTime accounts for elapsed playback).
  // Read-only — never touches the player, so no echo risk. When both sides
  // are paused the estimate is frozen, so drift = |guestTime - hostTime|
  // exactly (no runaway timer inflation). The host's own drift is
  // definitionally 0 and derived at render time (shownDrift below).
  useEffect(() => {
    if (isHost) return
    const interval = setInterval(() => {
      const player = playerRef.current
      if (!player || !playerReadyRef.current) return
      if (typeof player.getCurrentTime !== 'function') return
      // While paused we still sample: getHostCurrentTime() only advances the
      // estimate when the host is playing, so a guest paused alongside the
      // host sees the exact playhead gap with no wall-clock inflation.
      const hostTime = getHostCurrentTime()
      if (hostTime == null) return
      try {
        const localTime = player.getCurrentTime()
        setDriftMs(Math.round(Math.abs(localTime - hostTime) * 1000))
      } catch {
        // player not ready; leave the last value
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [isHost, getHostCurrentTime, media, syncInit, hostHeartbeat])

  // Host drift is 0 by definition; guests show the last sampled value.
  const shownDrift = isHost ? 0 : driftMs

  const avatarList = (room.participants || []).slice(0, 4)

  return (
    <div className="wp-glow-bg flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* Top navigation bar: brand, room code chip (1-click copy),
      participant avatar stack, connection badge and leave action. */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-zinc-950/70 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-[1440px] items-center justify-between gap-4 px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-indigo-500 to-fuchsia-500 text-lg shadow-lg shadow-indigo-500/30">
              🍿
            </span>
            <h1 className="truncate text-lg font-bold tracking-tight">
              <span className="bg-linear-to-r from-indigo-300 via-white to-fuchsia-300 bg-clip-text text-transparent">
                Watch Party
              </span>
            </h1>
          </div>

          <div className="flex min-w-0 items-center gap-2">
            {/* Room code chip — one click copies the invite link. */}
            <div className="flex min-w-0 items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1.5 pl-4 pr-1.5 backdrop-blur">
              <span className="hidden text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500 sm:inline">
                Room
              </span>
              <span className="truncate font-mono text-sm font-bold tracking-[0.25em] text-white">
                {roomId}
              </span>
              <button
                type="button"
                onClick={copyInvite}
                aria-label="Copy invite link"
                className={`inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-xs font-semibold transition duration-200 ${
                  copied
                    ? 'bg-emerald-500/20 text-emerald-300'
                    : 'bg-white/10 text-zinc-300 hover:bg-white/20 hover:text-white'
                }`}
              >
                {copied ? '✓ Copied' : '⧉ Copy'}
              </button>
            </div>

            {isHost && (
              <span className="hidden items-center gap-1 rounded-full border border-indigo-400/40 bg-indigo-500/15 px-3 py-1 text-xs font-semibold text-indigo-300 md:inline-flex">
                ★ Host
              </span>
            )}

            {/* Participant avatar stack + counter. */}
            <button
              type="button"
              onClick={() => setShowParticipants(true)}
              aria-label="Show participants"
              className="flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1 pl-1.5 pr-3 transition duration-200 hover:border-white/25 hover:bg-white/10"
            >
              <span className="flex -space-x-2">
                {avatarList.map((name, i) => (
                  <span
                    key={`${name}-${i}`}
                    title={name}
                    className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-950 bg-linear-to-br from-indigo-500 to-sky-500 text-[10px] font-bold uppercase text-white"
                  >
                    {String(name || '?').slice(0, 1)}
                  </span>
                ))}
                <span className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-950 bg-zinc-800 text-[10px] font-bold text-zinc-300">
                  {room.participantCount}
                </span>
              </span>
              <span className="hidden text-xs font-semibold text-zinc-300 sm:inline">
                watching
              </span>
            </button>

            <ConnectionBadge connected={connected} />
            <button
              type="button"
              onClick={onLeave}
              className="shrink-0 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm font-medium text-zinc-300 transition duration-200 hover:border-red-400/40 hover:bg-red-500/15 hover:text-red-200"
            >
              Leave
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-6 p-5 lg:flex-row">
        <div className="flex w-full min-w-0 flex-col gap-5 lg:w-[72%]">
          {/* Cinema stage: edge-to-edge curved player with ambient glow. */}
          <div className="relative">
            <div
              aria-hidden="true"
              className="absolute -inset-3 rounded-[32px] bg-linear-to-tr from-indigo-600/40 via-fuchsia-500/20 to-sky-400/25 blur-2xl"
            />
            <div className="relative aspect-video w-full overflow-hidden rounded-3xl border border-white/10 bg-black shadow-2xl shadow-indigo-950/70 ring-1 ring-white/5">
              <div id="yt-player" className="h-full w-full" />
            </div>
            {/* Muted-autoplay unmute overlay: guests start muted so the
            browser allows immediate seek+play on sync_init (real <=500ms
            drift). One tap unmutes; hidden for the host once unmuted. */}
            {muted && (
              <button
                type="button"
                onClick={() => {
                  try {
                    if (typeof playerRef.current?.unMute === 'function') playerRef.current.unMute()
                    if (typeof playerRef.current?.setVolume === 'function') playerRef.current.setVolume(100)
                  } catch {
                    // ignore; still hide the overlay
                  }
                  setMuted(false)
                }}
                className="absolute bottom-4 right-4 z-10 inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-black/70 px-4 py-2 text-xs font-semibold text-white backdrop-blur-md transition duration-200 hover:border-white/40 hover:bg-black/90"
              >
                🔊 Click to Unmute
              </button>
            )}
            {/* Step 6 — floating emoji reactions overlay (emoji + sender name tag, float up + fade, 2s). */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl">
              {floaters.map((f) => (
                <span
                  key={f.id}
                  style={{ left: `${f.left}%` }}
                  className="animate-float-up absolute bottom-6 flex flex-col items-center drop-shadow-lg"
                >
                  <span className="text-4xl">{f.emoji}</span>
                  <span className="mt-1 max-w-24 truncate rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-medium text-white">
                    {f.sender}
                  </span>
                </span>
              ))}
            </div>
          </div>

          {/* Sleek playback control bar docked beneath the stage: host
          bookmark action, guest sync control and Peek Mode status banner. */}
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-zinc-900/60 px-4 py-3 shadow-lg shadow-black/30 backdrop-blur-xl">
            {/* Host-only: snapshot the current playhead as a shared bookmark. */}
            {isHost && (
              <button
                type="button"
                onClick={bookmarkMoment}
                className="inline-flex items-center gap-2 rounded-xl border border-amber-400/40 bg-amber-500/15 px-4 py-2 text-sm font-semibold text-amber-300 transition duration-200 hover:-translate-y-0.5 hover:bg-amber-500/25 hover:shadow-lg hover:shadow-amber-500/20"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
                Bookmark Moment
              </button>
            )}
            {!isHost && (
              <button
                type="button"
                onClick={onRequestSync}
                className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2 text-xs font-medium text-zinc-200 transition duration-200 hover:-translate-y-0.5 hover:border-indigo-400/40 hover:bg-indigo-500/15 hover:text-indigo-200"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <polyline points="21 3 21 9 15 9" />
                </svg>
                Sync with Host
              </button>
            )}
            {/* Guest peek status: docked in the control bar (never overlays the
            16:9 player). While peeking, auto-snap is paused; one tap snaps
            back to live host time. */}
            {!isHost && isPeeking && (
              <div className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3.5 py-2 text-amber-200 backdrop-blur">
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-amber-400" />
                  </span>
                  <span className="truncate">
                    Viewing bookmarked scene ({peekTime != null ? formatBookmarkTime(peekTime) : '--:--'}) • Playback desynced from host
                  </span>
                </span>
                <button
                  type="button"
                  onClick={catchUpToLive}
                  className="shrink-0 rounded-lg bg-amber-400 px-3.5 py-1.5 text-sm font-bold text-zinc-950 shadow-sm transition-colors duration-200 hover:bg-amber-300"
                >
                  Catch Up to Live ⏩
                </button>
              </div>
            )}
          </div>

          {/* Interactive bookmarks drawer beneath the player: clean timestamps,
          note tags and quick-jump pills in a horizontal carousel. Visible to
          EVERYONE (host + guests); only the host's jump emits a room-wide
          media_action. */}
          <div className="rounded-2xl border border-white/10 bg-zinc-900/60 p-4 shadow-xl shadow-black/30 backdrop-blur-xl">
            <button
              type="button"
              onClick={() => setShowBookmarks((v) => !v)}
              aria-expanded={showBookmarks}
              className="flex w-full items-center justify-between text-left"
            >
              <div className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300 ring-1 ring-amber-400/30">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                </span>
                <span className="text-sm font-semibold text-white">
                  Bookmarks
                  <span className="ml-2 rounded-full bg-white/10 px-2 py-0.5 text-xs font-medium text-zinc-300 ring-1 ring-white/10">
                    {safeBookmarks.length}
                  </span>
                </span>
              </div>
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-xs text-zinc-400">
                {showBookmarks ? '▾' : '▸'}
              </span>
            </button>
            {showBookmarks && (
              <div className="wp-scrollbar-none mt-3 flex gap-3 overflow-x-auto pb-1">
                {safeBookmarks.length === 0 && (
                  <p className="py-3 text-sm text-zinc-500">
                    No bookmarks yet.{isHost ? ' Hit “Bookmark Moment” to save a scene.' : ' The host can save scene bookmarks here.'}
                  </p>
                )}
                {safeBookmarks.map((bm) => {
                  const bmVideoId = typeof bm.videoId === 'string' ? bm.videoId : ''
                  const liveVideoId = loadedVideoIdRef.current
                    || hostMediaRef.current?.currentVideoId
                    || DEFAULT_VIDEO_ID
                  const isOtherVideo = bmVideoId && bmVideoId !== liveVideoId
                  return (
                  <div
                    key={bm.id}
                    className="flex w-60 shrink-0 flex-col gap-2 self-start rounded-xl border border-white/10 bg-zinc-950/70 p-3 transition duration-200 hover:-translate-y-0.5 hover:border-indigo-400/40 hover:bg-zinc-900/80 hover:shadow-lg hover:shadow-indigo-500/10"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded-lg bg-amber-500/15 px-2 py-1 font-mono text-xs font-semibold tracking-wide text-amber-300 ring-1 ring-amber-400/30">
                        {formatBookmarkTime(bm.timestamp)}
                      </span>
                      <span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                        Scene
                      </span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-zinc-200" title={bm.note || ''}>
                        {bm.note || `Bookmark at ${formatBookmarkTime(bm.timestamp)}`}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                        {bm.createdAt && <span>saved {bm.createdAt}</span>}
                        {isOtherVideo && (
                          <span
                            title={`Switches to video ${bmVideoId}`}
                            className="rounded-md border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-sky-300"
                          >
                            🎬 Switch Video · {bmVideoId.slice(0, 6)}…
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="mt-auto flex items-center gap-2 pt-1">
                      {isHost ? (
                        <>
                          <button
                            type="button"
                            onClick={() => jumpToBookmark(bm)}
                            className="flex-1 rounded-lg bg-indigo-500 px-2.5 py-1.5 text-xs font-semibold text-white transition duration-200 hover:bg-indigo-400 hover:shadow-md hover:shadow-indigo-500/30"
                          >
                            Jump to Scene
                          </button>
                          <button
                            type="button"
                            onClick={() => onDeleteBookmark(bm.id)}
                            aria-label={`Delete bookmark ${formatBookmarkTime(bm.timestamp)}`}
                            className="shrink-0 rounded-lg border border-white/10 px-2 py-1.5 text-xs text-zinc-500 transition hover:border-red-400/40 hover:bg-red-500/15 hover:text-red-300"
                          >
                            ✕
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => jumpToBookmark(bm)}
                          title="Jump locally (host is not affected)"
                          className="w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-zinc-200 transition duration-200 hover:border-indigo-400/40 hover:bg-indigo-500/15 hover:text-indigo-200"
                        >
                          Jump to Scene
                        </button>
                      )}
                    </div>
                  </div>
                  )
                })}
              </div>
            )}
          </div>

        </div>

        <aside className="flex w-full min-w-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/60 shadow-2xl shadow-black/40 backdrop-blur-xl lg:w-[28%]">
          {/* Unified tab deck with a glowing active pill. */}
          <div className="flex gap-1.5 border-b border-white/10 bg-zinc-950/40 p-2">
            <button
              type="button"
              onClick={() => setActiveTab('chat')}
              className={tabClass('chat')}
            >
              💬 Chat
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('queue')}
              className={tabClass('queue')}
            >
              🎬 Movie Queue
            </button>
          </div>

          {activeTab === 'chat' && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="wp-scrollbar flex-1 space-y-3 overflow-y-auto p-4">
                {chatMessages.length === 0 && (
                  <p className="text-sm text-zinc-500">No messages yet. Say hi 👋</p>
                )}
                {chatMessages.map((m) => (
                  <div
                    key={m.id}
                    className="rounded-xl border border-white/5 bg-white/5 px-3 py-2 transition duration-150 hover:border-white/10"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-indigo-300">{m.sender}</span>
                      <span className="shrink-0 text-[11px] text-zinc-500">{formatTime(m.timestamp)}</span>
                    </div>
                    <div className="break-words text-sm text-zinc-200">{m.text}</div>
                  </div>
                ))}
              </div>
              {/* Step 6 — floating quick-emoji trigger bar: broadcast to the whole room. */}
              <div className="wp-scrollbar-none flex flex-wrap items-center gap-1 border-t border-white/10 bg-zinc-950/30 px-3 py-2">
                {EMOJI_PALETTE.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => sendReaction(emoji)}
                    aria-label={`Send ${emoji} reaction`}
                    className="rounded-lg px-2 py-1 text-xl transition duration-150 hover:scale-125 hover:bg-white/10"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <form onSubmit={sendMessage} className="sticky bottom-0 flex gap-2 border-t border-white/10 bg-zinc-900/80 p-3 backdrop-blur">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Send a message…"
                  className="w-full rounded-xl border border-white/10 bg-zinc-950/70 px-3.5 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                />
                <button
                  type="submit"
                  className="rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white transition duration-200 hover:-translate-y-0.5 hover:bg-indigo-400 hover:shadow-lg hover:shadow-indigo-500/30"
                >
                  Send
                </button>
              </form>
            </div>
          )}

          {activeTab === 'queue' && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="wp-scrollbar flex-1 space-y-2 overflow-y-auto p-4">
                {queue.length === 0 && (
                  <p className="text-sm text-zinc-500">Queue is empty. Add a video to get started.</p>
                )}
                {queue.map((v, index) => (
                  <div
                    key={`${v.videoId}-${index}`}
                    className="flex items-center gap-2 rounded-xl border border-white/10 bg-zinc-950/70 px-3 py-2.5 text-sm text-zinc-300 transition duration-150 hover:border-white/20 hover:bg-zinc-900/80"
                  >
                    <span className="text-indigo-400">▶</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate" title={v.title}>{v.title}</div>
                      <div className="truncate text-xs text-zinc-500">
                        {v.videoId}{v.addedBy ? ` • added by ${v.addedBy}` : ''}
                      </div>
                    </div>
                    {isHost && (
                      <button
                        type="button"
                        onClick={() => playQueued(index)}
                        className="shrink-0 rounded-lg bg-indigo-500 px-2.5 py-1.5 text-xs font-semibold text-white transition duration-200 hover:bg-indigo-400 hover:shadow-md hover:shadow-indigo-500/30"
                      >
                        Play Now
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onRemoveFromQueue(index)}
                      aria-label={`Remove ${v.title} from queue`}
                      className="shrink-0 rounded-lg px-2 py-1.5 text-xs text-zinc-500 transition hover:border-red-400/40 hover:bg-red-500/15 hover:text-red-300"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <form onSubmit={addVideo} className="sticky bottom-0 border-t border-white/10 bg-zinc-900/80 p-3 backdrop-blur">
                <div className="flex gap-2">
                  <input
                    value={videoUrl}
                    onChange={(e) => setVideoUrl(e.target.value)}
                    placeholder="Paste a YouTube URL or video ID…"
                    className="w-full rounded-xl border border-white/10 bg-zinc-950/70 px-3.5 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-indigo-400/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                  />
                  <button
                    type="submit"
                    className="shrink-0 rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white transition duration-200 hover:-translate-y-0.5 hover:bg-indigo-400 hover:shadow-lg hover:shadow-indigo-500/30"
                  >
                    Add Video
                  </button>
                </div>
                {queueError && (
                  <p className="mt-2 text-xs text-red-400">{queueError}</p>
                )}
              </form>
            </div>
          )}
        </aside>
      </div>

      {showParticipants && (
        <ParticipantsModal
          participants={room.participants}
          hostName={room.hostName}
          onClose={() => setShowParticipants(false)}
        />
      )}

      {/* Step 6 — latency & drift diagnostics drawer (bottom-left, clear of chat + reactions). */}
      <div className="fixed bottom-4 left-4 z-40 w-72 overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/70 shadow-2xl shadow-black/50 backdrop-blur-xl transition duration-200">
        <button
          type="button"
          onClick={() => setShowDiag((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.15em] text-zinc-400 transition hover:text-white"
        >
          <span className="inline-flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/70" />
            Diagnostics
          </span>
          <span className="text-zinc-500">{showDiag ? '▾' : '▴'}</span>
        </button>
        {showDiag && (
          <div className="space-y-2 border-t border-white/10 px-4 py-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Local Network Latency</span>
              <span className={`font-mono font-semibold ${latencyMs != null && latencyMs <= 250 ? 'text-emerald-400' : 'text-amber-400'}`}>
                {latencyMs != null ? `~${latencyMs} ms` : '—'}
              </span>
            </div>
            <div className="text-right text-[11px] text-zinc-600">Target: &le; 250 ms</div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-400">Max Playback Drift</span>
              <span className={`font-mono font-semibold ${shownDrift != null && shownDrift <= 500 ? 'text-emerald-400' : 'text-amber-400'}`}>
                {shownDrift != null ? `${shownDrift} ms` : '—'}
              </span>
            </div>
            <div className="text-right text-[11px] text-zinc-600">Target: &le; 500 ms</div>
            <div className="flex items-center justify-between border-t border-white/10 pt-2">
              <span className="text-zinc-400">Connected Peers</span>
              <span className="font-mono font-semibold text-zinc-200">
                {room.participantCount} user{room.participantCount === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}


function App() {
  const [connected, setConnected] = useState(false)
  const [socketId, setSocketId] = useState(null)
  const [roomId, setRoomId] = useState(getRoomIdFromHash)
  const [room, setRoom] = useState({ participantCount: 0, participants: [] })
  const [media, setMedia] = useState(null)
  // Step 5 packets: late-join snapshot + host heartbeat playhead.
  const [syncInit, setSyncInit] = useState(null)
  const [hostHeartbeat, setHostHeartbeat] = useState(null)
  // Step 6: live chat transcript, latest reaction packet, and RTT latency.
  // queue: synchronized Movie Queue from the server.
  // bookmarks: host-saved scene bookmarks from the server.
  const [chatMessages, setChatMessages] = useState([])
  const [reaction, setReaction] = useState(null)
  const [queue, setQueue] = useState([])
  const [bookmarks, setBookmarks] = useState([])
  const [latencyMs, setLatencyMs] = useState(null)
  const usernameRef = useRef(getOrCreateUsername())

  const socketRef = useRef(null)

  // Create a single socket for the lifetime of the app.
  useEffect(() => {
    const s = io(SERVER_URL)
    socketRef.current = s

    s.on('connect', () => {
      setConnected(true)
      setSocketId(s.id)
    })
    s.on('disconnect', () => setConnected(false))
    s.on('room_update', (data) => setRoom(data))
    // Bulletproof: bookmarks listener lives in the main socket effect
    // alongside room_update/sync_init so it is never detached.
    s.on('bookmarks_updated', (data) => {
      console.log('[CLIENT] Received bookmarks_updated:', data);
      setBookmarks(data || []);
    })
    s.on('media_action', (data) => setMedia(data))
    s.on('sync_init', (data) => {
      setSyncInit(data)
      setMedia(data)
      if (data && Array.isArray(data.queue)) setQueue(data.queue)
      if (data && Array.isArray(data.bookmarks)) setBookmarks(data.bookmarks)
    })
    s.on('queue_updated', (data) => {
      if (Array.isArray(data)) setQueue(data)
    })
    s.on('heartbeat', (data) => setHostHeartbeat(data))
    // Step 6 — live chat + reactions + latency pong.
    s.on('chat_message', (data) => {
      setChatMessages((prev) => [
        ...prev.slice(-99),
        {
          id: `${data.timestamp}-${Math.random().toString(36).slice(2, 7)}`,
          sender: data.sender,
          text: data.text,
          timestamp: data.timestamp,
        },
      ])
    })
    s.on('reaction', (data) => setReaction(data))
    s.on('pong_check', (data) => {
      if (data && typeof data.sendTime === 'number') {
        setLatencyMs(Date.now() - data.sendTime)
      }
    })

    return () => {
      s.off('connect')
      s.off('disconnect')
      s.off('room_update')
      s.off('media_action')
      s.off('sync_init')
      s.off('heartbeat')
      s.off('chat_message')
      s.off('reaction')
      s.off('queue_updated')
      s.off('bookmarks_updated')
      s.off('pong_check')
      s.disconnect()
      socketRef.current = null
    }
  }, [])

  // Keep roomId in sync with the URL hash (back/forward + manual edits).
  useEffect(() => {
    const onHashChange = () => setRoomId(getRoomIdFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Join the room channel whenever connected + a room id is in the URL.
  // If we hold a creator token for this room, join as the creator (host);
  // otherwise join as a regular participant (link / room-code entry).
  // We always send our display username so reactions/queue/chat attribution
  // stay consistent across reconnects.
  useEffect(() => {
    if (!connected || !roomId) return
    const s = socketRef.current
    if (!s) return
    setQueue([])
    setBookmarks([])
    const creatorToken = getCreatorToken(roomId)
    const payload = creatorToken
      ? { roomId, isCreator: true, creatorToken, username: usernameRef.current }
      : { roomId, username: usernameRef.current }
    s.emit('join_room', payload)
    return () => s.emit('leave_room', { roomId })
  }, [connected, roomId])

  const handleCreateRoom = useCallback(() => {
    const roomId = generateRoomId()
    // Persist a creator token so this client is recognised as the host even
    // after a tab refresh (sessionStorage survives refresh, not new tabs).
    setCreatorToken(roomId, generateCreatorToken())
    goToRoom(roomId)
  }, [])

  const handleJoinByCode = useCallback((code) => {
    goToRoom(code)
  }, [])

  const handleLeave = useCallback(() => {
    goHome()
  }, [])

  // Emit a playback action from the host to the server, which relays it to the
  // rest of the room and stores the latest state for late joiners. Carries the
  // currentVideoId when known so the Step 5 buffer stays accurate.
  const handleMediaAction = useCallback((action, currentTime, currentVideoId) => {
    const s = socketRef.current
    if (!s || !roomId) return
    const payload = { roomId, action, currentTime }
    if (typeof currentVideoId === 'string' && currentVideoId) {
      payload.currentVideoId = currentVideoId
    }
    s.emit('media_action', payload)
  }, [roomId])

  // Step 5 host heartbeat: forward the host playhead + current video to the
  // server, which refreshes the room buffer and relays it to guests.
  const handleHeartbeat = useCallback((currentTime) => {
    const s = socketRef.current
    if (!s || !roomId) return
    s.emit('heartbeat', { roomId, currentTime, currentVideoId: loadedVideoIdRef.current })
  }, [roomId])

  // Ask the server for the host's accurate current time. The server replies on
  // the 'media_action' channel (only to us), which the player applies via the
  // isRemoteUpdate-guarded path — no echo loop.
  const handleRequestSync = useCallback(() => {
    const s = socketRef.current
    if (!s || !roomId) return
    s.emit('sync_request', { roomId })
  }, [roomId])

  // Step 6 — live chat: sender name is resolved server-side from the
  // join_room username.
  const handleSendChat = useCallback((text) => {
    const s = socketRef.current
    if (!s || !roomId) return
    s.emit('chat_message', { roomId, text, timestamp: Date.now() })
  }, [roomId])

  // Step 6 — emoji reaction broadcast (includes our display name for the name tag).
  const handleSendReaction = useCallback((emoji) => {
    const s = socketRef.current
    if (!s || !roomId) return
    s.emit('send_reaction', { roomId, emoji, sender: usernameRef.current })
  }, [roomId])

  // Synchronized Movie Queue: add / remove, then broadcast via 'queue_updated'.
  const handleAddToQueue = useCallback((videoId, rawInput) => {
    const s = socketRef.current
    if (!s || !roomId || !videoId) return
    s.emit('add_to_queue', {
      roomId,
      videoId,
      title: rawInput ? String(rawInput).slice(0, 120) : videoId,
      addedBy: usernameRef.current,
    })
  }, [roomId])

  const handleRemoveFromQueue = useCallback((index) => {
    const s = socketRef.current
    if (!s || !roomId) return
    s.emit('remove_from_queue', { roomId, index })
  }, [roomId])

  // Host "Play Now": update the server's currentVideoId (media_action relay +
  // accurate buffer) and remove the item from the shared queue.
  const handlePlayQueued = useCallback((index, videoId) => {
    const s = socketRef.current
    if (!s || !roomId || !videoId) return
    s.emit('media_action', { roomId, action: 'play', currentTime: 0, currentVideoId: videoId })
    s.emit('remove_from_queue', { roomId, index })
  }, [roomId])

  // Host Bookmarking: emit 'add_bookmark' with { roomId, timestamp,
  // videoId, note }. roomId is read straight from the URL so the emit can
  // never go stale via closure. Server broadcast is the single source of truth.
  const handleAddBookmark = (timestamp, videoId, note) => {
    const activeRoomId = window.location.hash.split('/room/')[1]?.split('?')[0];
    console.log('[CLIENT] Emitting add_bookmark for room:', activeRoomId, { timestamp, videoId, note });
    if (!socketRef.current || !activeRoomId) return;
    socketRef.current.emit('add_bookmark', { roomId: activeRoomId, timestamp, videoId, note });
  }

  const handleDeleteBookmark = useCallback((bookmarkId) => {
    const s = socketRef.current
    if (!s || !roomId || bookmarkId == null) return
    s.emit('delete_bookmark', { roomId, bookmarkId, creatorToken: getCreatorToken(roomId) || undefined })
  }, [roomId])

  // Host "Jump to Scene": same-video seeks emit 'seek'; cross-video jumps
  // emit 'change_video' with videoId so the room switches video + timestamp
  // together. RoomView seeks/loads locally under the isRemoteUpdate guard.
  const handleJumpToBookmark = useCallback((bookmark) => {
    const s = socketRef.current
    if (!s || !roomId || !bookmark || typeof bookmark.timestamp !== 'number') return
    const bmVideoId = typeof bookmark.videoId === 'string' && bookmark.videoId ? bookmark.videoId : null
    const payload = bmVideoId
      ? { roomId, action: 'change_video', videoId: bmVideoId, currentVideoId: bmVideoId, currentTime: bookmark.timestamp }
      : { roomId, action: 'seek', currentTime: bookmark.timestamp }
    s.emit('media_action', payload)
  }, [roomId])

  // Step 6 — latency ping-pong: every 3s emit our sendTime; the server echoes
  // it back in 'pong_check' and we compute RTT = Date.now() - sendTime.
  useEffect(() => {
    if (!roomId) return
    const interval = setInterval(() => {
      const s = socketRef.current
      if (!s || !s.connected) return
      s.emit('ping_check', { roomId, sendTime: Date.now() })
    }, 3000)
    return () => clearInterval(interval)
  }, [roomId])

  if (roomId) {
    return (
      <RoomView
        roomId={roomId}
        room={room}
        socketId={socketId}
        username={usernameRef.current}
        onLeave={handleLeave}
        connected={connected}
        media={media}
        syncInit={syncInit}
        hostHeartbeat={hostHeartbeat}
        onMediaAction={handleMediaAction}
        onHeartbeat={handleHeartbeat}
        onRequestSync={handleRequestSync}
        chatMessages={chatMessages}
        reaction={reaction}
        latencyMs={latencyMs}
        queue={queue}
        bookmarks={bookmarks}
        onSendChat={handleSendChat}
        onSendReaction={handleSendReaction}
        onAddToQueue={handleAddToQueue}
        onRemoveFromQueue={handleRemoveFromQueue}
        onPlayQueued={handlePlayQueued}
        onAddBookmark={handleAddBookmark}
        onDeleteBookmark={handleDeleteBookmark}
        onJumpToBookmark={handleJumpToBookmark}
      />
    )
  }

  return (
    <HomeView
      onCreateRoom={handleCreateRoom}
      onJoinByCode={handleJoinByCode}
      connected={connected}
    />
  )
}

export default App

