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

function ConnectionBadge({ connected }) {
  return (
    <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm">
      <span
        role="status"
        aria-label={connected ? 'Connected' : 'Disconnected'}
        className={`inline-block h-2.5 w-2.5 rounded-full ${
          connected ? 'bg-green-500' : 'bg-red-500'
        }`}
      />
      <span className="text-slate-300">{connected ? 'Connected' : 'Disconnected'}</span>
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
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-4 text-slate-100">
      <div className="absolute right-4 top-4">
        <ConnectionBadge connected={connected} />
      </div>

      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900 p-8 shadow-2xl">
        <h1 className="mb-1 text-center text-3xl font-bold tracking-tight">
          <span className="text-indigo-400">Watch</span> Party
        </h1>
        <p className="mb-8 text-center text-sm text-slate-400">
          Watch videos together, in sync.
        </p>

        <button
          type="button"
          onClick={onCreateRoom}
          className="mb-6 w-full rounded-xl bg-indigo-500 px-4 py-3 font-semibold text-white transition hover:bg-indigo-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
        >
          Create Room
        </button>

        <div className="mb-6 flex items-center gap-3 text-xs uppercase text-slate-500">
          <span className="h-px flex-1 bg-white/10" />
          or
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <form onSubmit={handleSubmit}>
          <label
            htmlFor="room-code"
            className="mb-2 block text-sm font-medium text-slate-300"
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
              className="w-full rounded-xl border border-white/10 bg-slate-800 px-4 py-3 font-mono text-lg tracking-widest uppercase placeholder:text-slate-600 focus:border-indigo-400 focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-xl border border-white/10 bg-slate-800 px-5 py-3 font-semibold text-slate-200 transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
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
        className="w-full max-w-sm overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h2 className="text-base font-semibold text-white">
            Participants ({participants.length})
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-200"
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

        <ul className="max-h-80 space-y-1 overflow-y-auto p-3">
          {participants.length === 0 && (
            <li className="px-2 py-3 text-sm text-slate-500">No participants yet.</li>
          )}
          {participants.map((name, i) => (
            <li
              key={`${name}-${i}`}
              className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-white/5"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-green-500" />
              <span className="flex-1 truncate text-sm text-slate-200">{name}</span>
              {hostName && name === hostName && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-xs font-semibold text-indigo-300">
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

function RoomView({ roomId, room, socketId, onLeave, connected, media, syncInit, hostHeartbeat, onMediaAction, onHeartbeat, onRequestSync }) {
  const [copied, setCopied] = useState(false)
  const [activeTab, setActiveTab] = useState('chat')
  const [chatInput, setChatInput] = useState('')
  const [messages, setMessages] = useState([])
  const [queue, setQueue] = useState([])
  const [videoUrl, setVideoUrl] = useState('')
  const [showParticipants, setShowParticipants] = useState(false)

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

  const sendMessage = (e) => {
    e.preventDefault()
    const text = chatInput.trim()
    if (!text) return
    setMessages((prev) => [...prev, { id: Date.now(), author: 'You', text }])
    setChatInput('')
  }

  const addVideo = (e) => {
    e.preventDefault()
    const url = videoUrl.trim()
    if (!url) return
    setQueue((prev) => [...prev, { id: Date.now(), title: url }])
    setVideoUrl('')
  }

  const tabClass = (tab) =>
    `flex-1 border-b-2 px-4 py-2.5 text-sm font-medium transition ${
      activeTab === tab
        ? 'border-indigo-400 text-white'
        : 'border-transparent text-slate-400 hover:text-slate-200'
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

    const incomingVideoId = typeof data.currentVideoId === 'string' && data.currentVideoId
      ? data.currentVideoId
      : null
    const incomingPlaying = typeof data.isPlaying === 'boolean'
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
    const action = incomingPlaying ? 'play' : data.action === 'seek' ? 'seek' : 'pause'
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

  // Step 5 heartbeat drift check (guests only): when a host heartbeat arrives,
  // compare the local playhead to the host time; if drift exceeds 0.5s, snap
  // via a guarded seekTo so no event bounces back to the server.
  useEffect(() => {
    if (!hostHeartbeat || isHostRef.current) return
    const hostTime = typeof hostHeartbeat.currentTime === 'number'
      ? hostHeartbeat.currentTime
      : null
    if (hostTime == null) return
    heartbeatRef.current = {
      currentTime: hostTime,
      isPlaying: hostHeartbeat.isPlaying,
      receivedAt: Date.now(),
    }
    const player = playerRef.current
    if (!player || !playerReadyRef.current) return
    if (typeof player.getCurrentTime !== 'function') return
    // Do not fight the player while it is still buffering/cued.
    if (player.getPlayerState && player.getPlayerState() === window.YT.PlayerState.CUED) return
    const localTime = player.getCurrentTime()
    if (Math.abs(localTime - hostTime) > 0.5) {
      isRemoteUpdate.current = true
      clearTimeout(remoteTimerRef.current)
      remoteTimerRef.current = setTimeout(() => {
        isRemoteUpdate.current = false
      }, 500)
      player.seekTo(hostTime, true)
    }
  }, [hostHeartbeat])

  // Load the YouTube IFrame API once and create the player.
  useEffect(() => {
    let cancelled = false

    const createPlayer = () => {
      if (cancelled || playerRef.current) return
      playerRef.current = new window.YT.Player('yt-player', {
        videoId: DEFAULT_VIDEO_ID,
        playerVars: { rel: 0, modestbranding: 1 },
        events: {
          onReady: () => {
            playerReadyRef.current = true
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
  // directly to the current video, spot, and play state. All application is
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

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
        <h1 className="text-lg font-bold tracking-tight">
          <span className="text-indigo-400">Watch</span> Party
        </h1>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowParticipants(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
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
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
            Participants
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-indigo-500 px-1.5 text-xs font-semibold text-white">
              {room.participantCount}
            </span>
          </button>
          <ConnectionBadge connected={connected} />
          <button
            type="button"
            onClick={onLeave}
            className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-sm text-slate-300 transition hover:bg-slate-800"
          >
            Leave
          </button>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-5 lg:flex-row">
        <div className="flex w-full flex-col gap-5 lg:w-[70%]">
          <div className="relative">
            <div className="aspect-video w-full overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
              <div id="yt-player" className="h-full w-full" />
            </div>
            {!isHost && (
              <button
                type="button"
                onClick={onRequestSync}
                className="absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/90 px-3 py-1.5 text-xs font-medium text-slate-200 shadow-lg backdrop-blur transition hover:bg-slate-800"
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
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Room ID</div>
                <div className="font-mono text-2xl font-bold tracking-widest text-white">
                  {roomId}
                </div>
              </div>
              <div className="flex items-center gap-3">
                {isHost && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-indigo-500/40 bg-indigo-500/10 px-3 py-1 text-xs font-semibold text-indigo-300">
                    ★ Host
                  </span>
                )}
                <button
                  type="button"
                  onClick={copyInvite}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-700"
                >
                  {copied ? 'Copied!' : 'Copy Invite Link'}
                </button>
              </div>
            </div>
          </div>
        </div>

        <aside className="flex w-full flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 lg:w-[30%]">
          <div className="flex border-b border-slate-800">
            <button
              type="button"
              onClick={() => setActiveTab('chat')}
              className={tabClass('chat')}
            >
              Chat
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('queue')}
              className={tabClass('queue')}
            >
              Movie Queue
            </button>
          </div>

          {activeTab === 'chat' && (
            <div className="flex flex-1 flex-col">
              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {messages.length === 0 && (
                  <p className="text-sm text-slate-500">No messages yet. Say hi 👋</p>
                )}
                {messages.map((m) => (
                  <div key={m.id} className="text-sm">
                    <span className="font-semibold text-indigo-300">{m.author}</span>
                    <span className="ml-2 text-slate-300">{m.text}</span>
                  </div>
                ))}
              </div>
              <form onSubmit={sendMessage} className="flex gap-2 border-t border-slate-800 p-3">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Send a message…"
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-400 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400"
                >
                  Send
                </button>
              </form>
            </div>
          )}

          {activeTab === 'queue' && (
            <div className="flex flex-1 flex-col">
              <div className="flex-1 space-y-2 overflow-y-auto p-4">
                {queue.length === 0 && (
                  <p className="text-sm text-slate-500">Queue is empty. Add a video to get started.</p>
                )}
                {queue.map((v) => (
                  <div
                    key={v.id}
                    className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-300"
                  >
                    <span className="text-indigo-400">▶</span>
                    <span className="truncate">{v.title}</span>
                  </div>
                ))}
              </div>
              <form onSubmit={addVideo} className="flex gap-2 border-t border-slate-800 p-3">
                <input
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                  placeholder="Paste a video URL…"
                  className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-400 focus:outline-none"
                />
                <button
                  type="submit"
                  className="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-400"
                >
                  Add Video
                </button>
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
    s.on('media_action', (data) => setMedia(data))
    s.on('sync_init', (data) => {
      setSyncInit(data)
      setMedia(data)
    })
    s.on('heartbeat', (data) => setHostHeartbeat(data))

    return () => {
      s.off('connect')
      s.off('disconnect')
      s.off('room_update')
      s.off('media_action')
      s.off('sync_init')
      s.off('heartbeat')
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
  useEffect(() => {
    if (!connected || !roomId) return
    const s = socketRef.current
    if (!s) return
    const creatorToken = getCreatorToken(roomId)
    const payload = creatorToken
      ? { roomId, isCreator: true, creatorToken }
      : { roomId }
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

  // Step 5 host heartbeat: forward the host playhead to the server, which
  // refreshes the room buffer and relays it to guests.
  const handleHeartbeat = useCallback((currentTime) => {
    const s = socketRef.current
    if (!s || !roomId) return
    s.emit('heartbeat', { roomId, currentTime })
  }, [roomId])

  // Ask the server for the host's accurate current time. The server replies on
  // the 'media_action' channel (only to us), which the player applies via the
  // isRemoteUpdate-guarded path — no echo loop.
  const handleRequestSync = useCallback(() => {
    const s = socketRef.current
    if (!s || !roomId) return
    s.emit('sync_request', { roomId })
  }, [roomId])

  if (roomId) {
    return (
      <RoomView
        roomId={roomId}
        room={room}
        socketId={socketId}
        onLeave={handleLeave}
        connected={connected}
        media={media}
        syncInit={syncInit}
        hostHeartbeat={hostHeartbeat}
        onMediaAction={handleMediaAction}
        onHeartbeat={handleHeartbeat}
        onRequestSync={handleRequestSync}
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

